import { asRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCompanionExchange,
  SessionsCompanionAskResult,
  SessionsCompanionResetResult,
  SessionsCompanionStateResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { buildChatApiAttachments } from "./attachment-api.ts";
import {
  releaseChatAttachmentPayloads,
  releaseDisplacedChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";

const COMPANION_BUSY_DETAIL_CODE = "SESSION_COMPANION_BUSY";
const MAX_COMPANION_EXCHANGES = 24;
const COMPANION_ASK_TIMEOUT_MS = 70_000;

export type ChatSessionCompanionTurn = {
  question: string;
  attachments?: ChatAttachment[];
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
        | "image-unsupported"
        | "rate-limited"
        | "unavailable";
      /** Whether the user can explicitly retry; independent of automatic transport retry. */
      retryable: boolean;
    }
);

export type ChatSessionCompanionThread = {
  turns: ChatSessionCompanionTurn[];
  loading: boolean;
  draft: string;
  attachments?: ChatAttachment[];
  attachmentReads?: ChatAttachmentReadLifecycle;
};

type MutableCompanionThread = ChatSessionCompanionThread & {
  revision: number;
  draftRevision: number;
  pendingResets: Set<Deferred>;
  // Bounded response identities retain the canonical turn even after UI pruning.
  responses: Map<ChatSessionCompanionTurn, string>;
};

function exchangeKey(exchange: SessionCompanionExchange): string {
  return JSON.stringify([exchange.question, exchange.answer, exchange.ts]);
}

function reconcileTurns(thread: MutableCompanionThread, exchanges: SessionCompanionExchange[]) {
  const previousAttachments = thread.turns.flatMap((turn) => turn.attachments ?? []);
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
      delete turn.attachments;
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
  releaseDisplacedChatAttachmentPayloads(previousAttachments, [
    thread.turns.flatMap((turn) => turn.attachments ?? []),
  ]);
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
    thread.draftRevision += 1;
    this.notify();
  }

  setAttachments(sessionKey: string, attachments: ChatAttachment[], agentId?: string | null): void {
    const thread = this.get(sessionKey, agentId);
    thread.attachments = attachments;
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
      while (this.submissionTokens.has(key) || thread.pendingResets.size) {
        await Promise.all([
          this.submissionTokens.get(key)?.promise,
          ...[...thread.pendingResets].map((reset) => reset.promise),
        ]);
      }
      if (this.hydrationTokens.get(key) !== token) {
        return;
      }
      const revision = thread.revision;
      const result = await load(targetSessionKey);
      while (thread.pendingResets.size) {
        await Promise.all([...thread.pendingResets].map((reset) => reset.promise));
      }
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
    ask: (
      sessionKey: string,
      question: string,
      attachments?: ChatAttachment[],
    ) => Promise<SessionsCompanionAskResult>,
    agentId?: string | null,
  ): Promise<void> {
    const targetSessionKey = sessionKey.trim();
    const normalized = typeof question === "string" ? question.trim() : question.question;
    if (!targetSessionKey || !normalized) {
      return;
    }
    const key = companionThreadKey(targetSessionKey, agentId);
    const thread = this.get(targetSessionKey, agentId);
    if (
      thread.turns.some((turn) => turn.status === "pending") ||
      thread.attachmentReads?.pendingReads
    ) {
      return;
    }
    if (
      typeof question !== "string" &&
      (!thread.turns.includes(question) || question.status !== "failed")
    ) {
      return;
    }
    const attachments = typeof question === "string" ? thread.attachments : question.attachments;
    const turn: ChatSessionCompanionTurn = {
      question: normalized,
      status: "pending",
      ...(attachments?.length ? { attachments } : {}),
    };
    if (typeof question === "string") {
      const turns = [...thread.turns, turn];
      for (const retired of turns.slice(0, -MAX_COMPANION_EXCHANGES)) {
        releaseChatAttachmentPayloads(retired.attachments ?? []);
      }
      thread.turns = turns.slice(-MAX_COMPANION_EXCHANGES);
      thread.attachments = [];
      thread.draft = "";
      thread.draftRevision += 1;
    } else {
      // A retry is new intent in the same slot, outside any earlier Clear snapshot.
      thread.turns = thread.turns.map((previous) => (previous === question ? turn : previous));
    }
    thread.revision += 1;
    const token = createDeferredCore();
    this.submissionTokens.set(key, token);
    this.notify();
    try {
      const result = await ask(targetSessionKey, normalized, turn.attachments);
      if (this.submissionTokens.get(key) !== token) {
        return;
      }
      releaseChatAttachmentPayloads(turn.attachments ?? []);
      delete turn.attachments;
      Object.assign(turn, { status: "answered", answer: result.answer, ts: result.ts });
      thread.responses.set(turn, exchangeKey({ question: normalized, ...result }));
      thread.responses = new Map([...thread.responses].slice(-MAX_COMPANION_EXCHANGES));
    } catch (error) {
      if (this.submissionTokens.get(key) !== token) {
        return;
      }
      const details = asRecord(asRecord(error).details);
      const reason = readStringField(details, "reason") ?? null;
      const imageUnsupported = reason === "image-input-unsupported";
      const hint =
        details.code === COMPANION_BUSY_DETAIL_CODE
          ? "busy"
          : reason === "context-unavailable"
            ? "history-unavailable"
            : reason === "session-missing"
              ? "missing"
              : reason === "rate-limited"
                ? "rate-limited"
                : imageUnsupported
                  ? "image-unsupported"
                  : reason === "utility-model-unavailable"
                    ? "model-unavailable"
                    : "unavailable";
      Object.assign(turn, {
        status: "failed",
        hint,
        // Changing the model is a user action, not an automatic retry condition.
        retryable: imageUnsupported || Boolean(asRecord(error).retryable) || reason === null,
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
    const key = companionThreadKey(targetSessionKey, agentId);
    const thread = this.get(targetSessionKey, agentId);
    const priorTurns = new Set([...thread.turns, ...thread.responses.keys()]);
    const draftRevision = thread.draftRevision;
    const reads = thread.attachmentReads;
    const priorReads = [...(reads?.project(thread.attachments ?? []) ?? [])];
    const priorAttachmentIds = new Set([
      ...(thread.attachments ?? []).map(({ id }) => id),
      ...priorReads.map(({ attachment }) => attachment.id),
    ]);
    const submission = this.submissionTokens.get(key);
    const hydration = this.hydrationTokens.get(key);
    const reset = createDeferredCore();
    thread.pendingResets.add(reset);
    try {
      await clear(targetSessionKey);
      if (this.threads.get(key) !== thread) {
        return;
      }
      const previousAttachments = [
        ...(thread.attachments ?? []),
        ...thread.turns.flatMap((turn) => turn.attachments ?? []),
      ];
      // Clear owns the content present at the click, not later composer or send intent.
      thread.turns = thread.turns.filter((turn) => !priorTurns.has(turn));
      thread.responses = new Map([...thread.responses].filter(([turn]) => !priorTurns.has(turn)));
      if (thread.draftRevision === draftRevision) {
        thread.draft = "";
        thread.draftRevision += 1;
      }
      for (const entry of priorReads) {
        reads?.remove(entry);
      }
      thread.attachments = (thread.attachments ?? []).filter(
        ({ id }) => !priorAttachmentIds.has(id),
      );
      if (submission && this.submissionTokens.get(key) === submission) {
        this.submissionTokens.delete(key);
        submission.resolve();
      }
      if (hydration && this.hydrationTokens.get(key) === hydration) {
        this.hydrationTokens.delete(key);
        thread.loading = false;
      }
      releaseDisplacedChatAttachmentPayloads(previousAttachments, [
        thread.attachments ?? [],
        thread.turns.flatMap((turn) => turn.attachments ?? []),
      ]);
      thread.revision += 1;
      this.notify();
    } finally {
      thread.pendingResets.delete(reset);
      reset.resolve();
    }
  }

  retire(sessionKey?: string, agentId?: string | null): void {
    const key = sessionKey ? companionThreadKey(sessionKey, agentId) : null;
    for (const [threadKey, thread] of this.threads) {
      if (key && key !== threadKey) {
        continue;
      }
      thread.attachmentReads?.abortReads();
      releaseChatAttachmentPayloads(thread.attachments ?? []);
      for (const turn of thread.turns) {
        releaseChatAttachmentPayloads(turn.attachments ?? []);
      }
    }
    for (const store of [this.threads, this.hydrationTokens, this.submissionTokens]) {
      void (key ? store.delete(key) : store.clear());
    }
    this.notify();
  }

  private get(sessionKey: string, agentId?: string | null): MutableCompanionThread {
    const key = companionThreadKey(sessionKey, agentId);
    let thread = this.threads.get(key);
    if (!thread) {
      thread = {
        turns: [],
        loading: false,
        draft: "",
        attachments: [],
        attachmentReads: new ChatAttachmentReadLifecycle(this.notify),
        revision: 0,
        draftRevision: 0,
        pendingResets: new Set(),
        responses: new Map(),
      };
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
  attachments?: ChatAttachment[],
): Promise<SessionsCompanionAskResult> {
  return client.request<SessionsCompanionAskResult>(
    "sessions.companion.ask",
    {
      sessionKey,
      ...(agentId ? { agentId } : {}),
      question,
      ...(attachments?.length ? { attachments: buildChatApiAttachments(attachments) } : {}),
    },
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
