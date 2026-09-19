import { asRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCompanionExchange,
  SessionsCompanionAskResult,
  SessionsCompanionResetResult,
  SessionsCompanionStateResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

const COMPANION_BUSY_DETAIL_CODE = "SESSION_COMPANION_BUSY";
const MAX_COMPANION_EXCHANGES = 24;
const COMPANION_ASK_TIMEOUT_MS = 70_000;

export type ChatSessionCompanionTurn = {
  question: string;
} & (
  | { status: "pending" }
  | ({ status: "answered" } & SessionCompanionExchange)
  | {
      status: "failed";
      hint:
        | "busy"
        | "history-unavailable"
        | "missing"
        | "model-unavailable"
        | "rate-limited"
        | "unavailable";
      retryable: boolean;
    }
);

export type ChatSessionCompanionThread = {
  turns: ChatSessionCompanionTurn[];
  loading: boolean;
  draft: string;
};

type MutableCompanionThread = ChatSessionCompanionThread & {
  revision: number;
  // Bounded response identities retain the canonical turn even after UI pruning.
  responses: Map<ChatSessionCompanionTurn, string>;
};

function exchangeKey(exchange: SessionCompanionExchange): string {
  return JSON.stringify([exchange.question, exchange.answer, exchange.ts]);
}

function reconcileTurns(thread: MutableCompanionThread, exchanges: SessionCompanionExchange[]) {
  const known = [...thread.responses];
  const snapshot = exchanges.map((exchange) => ({ exchange, key: exchangeKey(exchange) }));
  // Gateway only removes from the front; retain the longest observed suffix still present.
  while (known.length) {
    let cursor = 0;
    if (
      known.every(([, key]) => {
        cursor = snapshot.findIndex((entry, index) => index >= cursor && entry.key === key) + 1;
        return cursor > 0;
      })
    ) {
      break;
    }
    known.shift();
  }
  const entries = snapshot.map(({ exchange, key }, position) => {
    const observed = known[0]?.[1] === key ? known.shift() : undefined;
    const turn: ChatSessionCompanionTurn = observed?.[0] ?? { status: "answered", ...exchange };
    return { turn, key, position, fresh: !observed };
  });
  const remaining = [...entries];
  const positions = new Map<ChatSessionCompanionTurn, number>();
  // Pruned responses still anchor older unseen history before the retained turns.
  const pruned = new Set(
    entries
      .filter(({ turn, fresh }) => !fresh && !thread.turns.includes(turn))
      .map(({ turn }) => turn),
  );
  const turns = [...pruned, ...thread.turns].flatMap((turn) => {
    const index = remaining.findIndex(({ turn: answer, fresh }) =>
      turn.status === "answered"
        ? turn === answer
        : turn.status === "failed" && turn.question === answer.question && fresh,
    );
    const match = index < 0 ? undefined : remaining.splice(index, 1)[0];
    if (match) {
      Object.assign(turn, match.turn);
      match.turn = turn;
      positions.set(turn, match.position);
    }
    return !match && turn.status === "answered" ? [] : [turn];
  });
  for (const { turn, position } of remaining) {
    // Gateway order places new answers around retries that keep their original local slot.
    const last = turns.findLastIndex(
      (candidate) => (positions.get(candidate) ?? Infinity) < position,
    );
    const next = turns.findIndex(
      (candidate, index) => index > last && candidate.status === "answered",
    );
    positions.set(turn, position);
    turns.splice(next < 0 ? turns.length : next, 0, turn);
  }
  thread.turns = turns.filter((turn) => !pruned.has(turn)).slice(-MAX_COMPANION_EXCHANGES);
  thread.responses = new Map(
    entries.slice(-MAX_COMPANION_EXCHANGES).map(({ turn, key }) => [turn, key]),
  );
}

function companionThreadKey(sessionKey: string, agentId?: string | null): string {
  return `${agentId?.trim() ?? ""}\0${sessionKey.trim()}`;
}

/** Pane-owned ephemeral companion threads, keyed by the exact selected session. */
export class ChatSessionCompanionThreads {
  private readonly threads = new Map<string, MutableCompanionThread>();
  private readonly hydrationTokens = new Map<string, symbol>();
  private readonly submissionTokens = new Map<string, Deferred>();

  constructor(private readonly notify: () => void = () => {}) {}

  view(sessionKey: string, agentId?: string | null): ChatSessionCompanionThread {
    return this.get(sessionKey, agentId);
  }

  setDraft(sessionKey: string, draft: string, agentId?: string | null): void {
    const thread = this.get(sessionKey, agentId);
    if (thread.draft === draft) {
      return;
    }
    thread.draft = draft;
    thread.revision += 1;
    this.notify();
  }

  async hydrate(
    sessionKey: string,
    load: (sessionKey: string) => Promise<SessionsCompanionStateResult>,
    agentId?: string | null,
  ): Promise<void> {
    const targetSessionKey = sessionKey.trim();
    if (!targetSessionKey) {
      return;
    }
    const key = companionThreadKey(targetSessionKey, agentId);
    const thread = this.get(targetSessionKey, agentId);
    const token = Symbol(key);
    this.hydrationTokens.set(key, token);
    thread.loading = true;
    this.notify();
    try {
      while (this.submissionTokens.has(key)) {
        await this.submissionTokens.get(key)?.promise;
      }
      if (this.hydrationTokens.get(key) !== token) {
        return;
      }
      const revision = thread.revision;
      const result = await load(targetSessionKey);
      if (this.hydrationTokens.get(key) !== token || thread.revision !== revision) {
        return;
      }
      reconcileTurns(thread, result.exchanges);
      thread.revision += 1;
      this.notify();
    } catch {
      // A disconnected Gateway should not erase a thread already
      // visible in this pane. Ask failures surface an actionable inline hint.
    } finally {
      if (this.hydrationTokens.get(key) === token) {
        this.hydrationTokens.delete(key);
        thread.loading = false;
        this.notify();
      }
    }
  }

  async submit(
    sessionKey: string,
    question: string | ChatSessionCompanionTurn,
    ask: (sessionKey: string, question: string) => Promise<SessionsCompanionAskResult>,
    agentId?: string | null,
  ): Promise<void> {
    const targetSessionKey = sessionKey.trim();
    const normalized = typeof question === "string" ? question.trim() : question.question;
    if (!targetSessionKey || !normalized) {
      return;
    }
    const key = companionThreadKey(targetSessionKey, agentId);
    const thread = this.get(targetSessionKey, agentId);
    if (thread.turns.some((turn) => turn.status === "pending")) {
      return;
    }
    const turn: ChatSessionCompanionTurn =
      typeof question === "string" ? { question: normalized, status: "pending" } : question;
    if (
      typeof question !== "string" &&
      (!thread.turns.includes(turn) || turn.status !== "failed")
    ) {
      return;
    }
    Object.assign(turn, { status: "pending" });
    if (typeof question === "string") {
      thread.turns = [...thread.turns, turn].slice(-MAX_COMPANION_EXCHANGES);
    }
    thread.draft = "";
    thread.revision += 1;
    const token = createDeferredCore();
    this.submissionTokens.set(key, token);
    this.notify();
    try {
      const result = await ask(targetSessionKey, normalized);
      if (this.submissionTokens.get(key) !== token) {
        return;
      }
      Object.assign(turn, { status: "answered", answer: result.answer, ts: result.ts });
      thread.responses.set(turn, exchangeKey({ question: normalized, ...result }));
      thread.responses = new Map([...thread.responses].slice(-MAX_COMPANION_EXCHANGES));
    } catch (error) {
      if (this.submissionTokens.get(key) !== token) {
        return;
      }
      const details = asRecord(asRecord(error).details);
      const reason = readStringField(details, "reason") ?? null;
      const hint =
        details.code === COMPANION_BUSY_DETAIL_CODE
          ? "busy"
          : reason === "context-unavailable"
            ? "history-unavailable"
            : reason === "session-missing"
              ? "missing"
              : reason === "rate-limited"
                ? "rate-limited"
                : reason === "utility-model-unavailable"
                  ? "model-unavailable"
                  : "unavailable";
      Object.assign(turn, {
        status: "failed",
        hint,
        retryable: Boolean(asRecord(error).retryable) || reason === null,
      });
    } finally {
      token.resolve();
      if (this.submissionTokens.get(key) === token) {
        this.submissionTokens.delete(key);
        thread.revision += 1;
        this.notify();
      }
    }
  }

  async reset(
    sessionKey: string,
    clear: (sessionKey: string) => Promise<SessionsCompanionResetResult>,
    agentId?: string | null,
  ): Promise<void> {
    const targetSessionKey = sessionKey.trim();
    if (!targetSessionKey) {
      return;
    }
    await clear(targetSessionKey);
    this.retire(targetSessionKey, agentId);
  }

  retire(sessionKey?: string, agentId?: string | null): void {
    const key = sessionKey ? companionThreadKey(sessionKey, agentId) : null;
    for (const store of [this.threads, this.hydrationTokens, this.submissionTokens]) {
      void (key ? store.delete(key) : store.clear());
    }
    this.notify();
  }

  private get(sessionKey: string, agentId?: string | null): MutableCompanionThread {
    const key = companionThreadKey(sessionKey, agentId);
    let thread = this.threads.get(key);
    if (!thread) {
      thread = { turns: [], loading: false, draft: "", revision: 0, responses: new Map() };
      this.threads.set(key, thread);
    }
    return thread;
  }
}

export function requestSessionCompanionAnswer(
  client: Pick<GatewayBrowserClient, "request">,
  sessionKey: string,
  question: string,
  agentId?: string | null,
): Promise<SessionsCompanionAskResult> {
  return client.request<SessionsCompanionAskResult>(
    "sessions.companion.ask",
    { sessionKey, ...(agentId ? { agentId } : {}), question },
    { timeoutMs: COMPANION_ASK_TIMEOUT_MS },
  );
}

export function requestSessionCompanionState(
  client: Pick<GatewayBrowserClient, "request">,
  sessionKey: string,
  agentId?: string | null,
): Promise<SessionsCompanionStateResult> {
  return client.request<SessionsCompanionStateResult>("sessions.companion.state", {
    sessionKey,
    ...(agentId ? { agentId } : {}),
  });
}

export function resetSessionCompanion(
  client: Pick<GatewayBrowserClient, "request">,
  sessionKey: string,
  agentId?: string | null,
): Promise<SessionsCompanionResetResult> {
  return client.request<SessionsCompanionResetResult>("sessions.companion.reset", {
    sessionKey,
    ...(agentId ? { agentId } : {}),
  });
}
