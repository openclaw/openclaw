import { isDeepStrictEqual } from "node:util";
import { classifyAgentRunTerminalOutcome } from "@openclaw/normalization-core/agent-run-terminal-outcome";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { MAX_PAYLOAD_BYTES } from "../../gateway/server-constants.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import { attachSessionEntrySnapshots } from "./session-entry-snapshot-values.js";
import type { SessionPendingInputAuthorityFacts } from "./session-pending-input-authority.js";
import { SessionPendingInputCustodyError } from "./session-pending-input-custody-error.js";
import type {
  PendingInputCustodyCandidate,
  PendingInputHistoryGrant,
  PendingInputHistoryQuery,
  PendingInputHistoryReceipt,
  PendingInputHistorySnapshot,
} from "./session-pending-input-history.types.js";
import type {
  PendingInputCustodyGrant,
  PendingInputMutation,
  PendingInputMutationReceipt,
  PendingInputRead,
  PendingInputSnapshot,
  PendingInputSourceSnapshot,
} from "./session-pending-input-operations.types.js";
import {
  isFinalInputCompletion,
  normalizePendingInputReceiptRunIds,
  projectPendingInputReceipts,
  resolvePendingInputHistoryLimit,
  selectPendingInputHistoryPage,
  parseSessionPendingInputMessage,
} from "./session-pending-input-value.js";
import type {
  SessionInputCompletion,
  SessionPendingInputRow,
} from "./session-pending-input.types.js";

type PendingIdentity = Pick<PendingInputRead, "sessionKey" | "sessionId" | "idempotencyKey">;

/** The memory owner lends its working state and installs it only after the phase commits. */
export function createSessionActorMemoryPending(
  state: SessionActorMemoryWindow,
  options: {
    agentId: string;
    path: string;
    admit(stage: "transaction" | "commit", grant: PendingInputCustodyGrant): void;
  },
) {
  const owns = (input: PendingIdentity) =>
    input.sessionKey === state.hot.target.sessionKey &&
    state.hot.entry?.sessionId === input.sessionId;
  const pending = (input: PendingIdentity) => {
    const row = state.pendingInputs.get(input.idempotencyKey);
    return row?.session_key === input.sessionKey && row.session_id === input.sessionId
      ? row
      : undefined;
  };
  const completion = (input: PendingIdentity) => {
    const row = state.completions.get(input.idempotencyKey);
    return row?.session_key === input.sessionKey && row.session_id === input.sessionId
      ? row
      : undefined;
  };
  const committed = (input: PendingIdentity, checkEventBytes: boolean) => {
    const identity = state.hot.transcript.idempotency.findLast(
      ({ key }) => key === input.idempotencyKey,
    );
    const row = identity && state.events.find(({ rawSeq }) => rawSeq === identity.rawSeq);
    const message = asOptionalRecord(row?.event)?.message;
    if (!identity || message === undefined) {
      return undefined;
    }
    const messageJson = JSON.stringify(message);
    if (messageJson === undefined) {
      return undefined;
    }
    const readJson = checkEventBytes ? row?.eventJson : messageJson;
    if (readJson && Buffer.byteLength(readJson, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new Error(
        `${checkEventBytes ? "Submitted" : "Pending"} input exceeds the Gateway payload limit`,
      );
    }
    return { messageId: identity.eventId, message: parseSessionPendingInputMessage(messageJson) };
  };
  const readStage = (input: Extract<PendingInputRead, { kind: "stage" }>): PendingInputSnapshot => {
    if (!owns(input)) {
      return { kind: "stage", current: false };
    }
    const existing = pending(input);
    const previous = input.trackCompletion ? completion(input) : undefined;
    if (existing && Buffer.byteLength(existing.message_json, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new Error("Pending input exceeds the Gateway payload limit");
    }
    return structuredClone({
      kind: "stage",
      current: true,
      existing,
      previous,
      committed:
        existing?.consumed_event_id != null ||
        (previous && isFinalInputCompletion(previous.outcome))
          ? undefined
          : committed(input, false),
    });
  };
  const authority = (agentId = options.agentId): SessionPendingInputAuthorityFacts => {
    const database = state.hot.target.database;
    return {
      agentId,
      storePath: options.path,
      sessionKey: toAgentStoreSessionKey({ agentId, requestKey: state.hot.target.sessionKey }),
      entry: state.hot.entry
        ? structuredClone(attachSessionEntrySnapshots({ ...state.hot.entry }, {}, "list"))
        : undefined,
      readSource: {
        agentId: options.agentId,
        path: options.path,
        databaseIdentity:
          database.kind === "file" ? database.physicalIdentity : database.incarnation,
        ...(database.kind === "file" ? { databaseBirthtime: database.birthtime } : {}),
      },
      members: structuredClone(state.hot.members),
    };
  };
  return {
    authority,
    read(input: PendingInputRead): PendingInputSnapshot | PendingInputSourceSnapshot {
      if (input.kind === "stage") {
        return readStage(input);
      }
      const snapshot: PendingInputSourceSnapshot = { kind: "source", current: owns(input) };
      if (!snapshot.current) {
        return snapshot;
      }
      const row = pending(input);
      if (row) {
        if (Buffer.byteLength(row.message_json, "utf8") > MAX_PAYLOAD_BYTES) {
          throw new Error("Submitted input exceeds the Gateway payload limit");
        }
        snapshot.pending = structuredClone(row);
      } else if (!input.pendingOnly) {
        snapshot.committed = committed(input, true)?.message;
      }
      return snapshot;
    },
    history(query: PendingInputHistoryQuery): PendingInputHistorySnapshot {
      const rows = [...state.pendingInputs.values()].filter(
        (row) =>
          row.session_key === query.sessionKey &&
          row.session_id === query.sessionId &&
          row.consumed_event_id === null,
      );
      const total = query.id === undefined ? rows.length : undefined;
      if (total === 0) {
        return { rows: [], total };
      }
      const limit = resolvePendingInputHistoryLimit(query.limit);
      const page = rows
        .filter(
          (row) =>
            (query.before === undefined || row.seq < query.before) &&
            (query.id === undefined || row.input_id === query.id),
        )
        .toSorted((left, right) => right.seq - left.seq)
        .slice(0, limit + 1);
      const { selected, nextBefore } = selectPendingInputHistoryPage(
        page.map((row) => ({
          seq: row.seq,
          serialized_bytes: Buffer.byteLength(row.message_json, "utf8"),
        })),
        limit,
      );
      return {
        rows: structuredClone(page.slice(0, selected.length)),
        total,
        currentSessionId:
          page.length && query.sessionKey === state.hot.target.sessionKey
            ? state.hot.entry?.sessionId
            : undefined,
        nextBefore,
      };
    },
    receipts(input: { sessionKey: string; sessionId: string; runIds: readonly string[] }) {
      const runIds = new Set(normalizePendingInputReceiptRunIds(input.runIds));
      const rows = [...state.pendingInputs.values()]
        .filter(
          (row) =>
            row.session_key === input.sessionKey &&
            row.session_id === input.sessionId &&
            runIds.has(row.run_id),
        )
        .toSorted((left, right) => left.seq - right.seq)
        .slice(0, 51);
      return projectPendingInputReceipts(rows);
    },
    interruptHistory(
      input: { sessionKey: string; sessionId: string; ids: string[] },
      custody: {
        isProtected(
          candidate: PendingInputCustodyCandidate,
          currentSessionId: string | undefined,
        ): boolean;
        admit(stage: "transaction" | "commit", grant: PendingInputHistoryGrant): void;
      },
    ): PendingInputHistoryReceipt {
      if (input.ids.length > 20) {
        throw new Error("Pending input reconciliation exceeds its page bound");
      }
      const selected = [...state.pendingInputs.values()].filter(
        (row) =>
          row.session_key === input.sessionKey &&
          row.session_id === input.sessionId &&
          input.ids.includes(row.input_id) &&
          row.state === "queued" &&
          row.consumed_event_id === null,
      );
      const candidates = selected.map((row) => ({
        input_id: row.input_id,
        session_key: row.session_key,
        session_id: row.session_id,
        lifecycle_generation: row.lifecycle_generation,
      }));
      const currentSessionId =
        selected.length && input.sessionKey === state.hot.target.sessionKey
          ? state.hot.entry?.sessionId
          : undefined;
      custody.admit("transaction", {
        kind: "pending-input-history-custody",
        candidates,
        currentSessionId,
      });
      // A single synchronous custody check immediately precedes this bookkeeping effect.
      const interrupted = candidates.filter(
        (candidate) => !custody.isProtected(candidate, currentSessionId),
      );
      const ids = interrupted.map((candidate) => candidate.input_id);
      for (const row of selected) {
        if (ids.includes(row.input_id)) {
          state.pendingInputs.set(row.idempotency_key, { ...row, state: "interrupted" });
        }
      }
      state.hot.pendingInputs = [...state.pendingInputs.values()].map(
        ({ message_json: _message, ...value }) => value,
      );
      custody.admit("commit", {
        kind: "pending-input-history-custody",
        candidates: interrupted,
        currentSessionId,
      });
      return { kind: "pending-input-history-interrupted", ids };
    },
    mutate(input: PendingInputMutation): PendingInputMutationReceipt {
      if (
        input.sessionKey !== state.hot.target.sessionKey ||
        (input.kind !== "finish" && !owns(input))
      ) {
        throw new SessionPendingInputCustodyError(
          "Pending input no longer owns the admitted session",
        );
      }
      const row = pending(input);
      if (input.kind === "stage") {
        if (!isDeepStrictEqual(readStage(input), input.expected)) {
          throw new SessionPendingInputCustodyError(
            "Pending input changed before staging committed",
          );
        }
      } else if (
        row &&
        (row.run_id !== input.runId ||
          row.request_hash !== input.requestHash ||
          row.lifecycle_generation !== input.lifecycleGeneration ||
          (input.kind === "finish" && row.input_id !== input.inputId))
      ) {
        throw new SessionPendingInputCustodyError(
          "Pending input settlement lost its accepted owner",
        );
      }
      const receipt: PendingInputMutationReceipt = {
        kind: "pending-input-settlement",
        operation: input.kind,
        sessionKey: input.sessionKey,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        runId: input.runId,
        requestHash: input.requestHash,
        lifecycleGeneration: input.lifecycleGeneration,
      };
      const grant: PendingInputCustodyGrant = {
        kind: "pending-input-settlement-custody",
        candidate: row && structuredClone(row),
        receipt,
        ...(input.kind !== "finish" && input.authorityAgentId
          ? { authority: authority(input.authorityAgentId) }
          : {}),
      };
      options.admit("transaction", grant);
      if (input.kind === "stage") {
        const staged: SessionPendingInputRow = row
          ? { ...row, state: "queued", lifecycle_generation: input.lifecycleGeneration }
          : {
              seq:
                [...state.pendingInputs.values()].reduce(
                  (max, value) => Math.max(max, value.seq),
                  0,
                ) + 1,
              input_id: input.inputId,
              session_key: input.sessionKey,
              session_id: input.sessionId,
              idempotency_key: input.idempotencyKey,
              run_id: input.runId,
              request_hash: input.requestHash,
              message_json: input.messageJson,
              lifecycle_generation: input.lifecycleGeneration,
              state: "queued",
              accepted_at: Date.now(),
              consumed_event_id: null,
            };
        state.pendingInputs.set(input.idempotencyKey, staged);
        receipt.stagedInput = structuredClone(staged);
      } else if (input.kind === "complete") {
        const retained = completion(input);
        if (
          retained &&
          (retained.run_id !== input.runId || retained.request_hash !== input.requestHash)
        ) {
          throw new SessionPendingInputCustodyError(
            "Input completion conflicts with the accepted input",
          );
        }
        if (retained && isFinalInputCompletion(retained.outcome)) {
          receipt.outcome = structuredClone(retained.outcome);
        } else {
          const outcome = structuredClone(input.outcome);
          const next: SessionInputCompletion = {
            session_key: input.sessionKey,
            session_id: input.sessionId,
            idempotency_key: input.idempotencyKey,
            run_id: input.runId,
            request_hash: input.requestHash,
            outcome_json: JSON.stringify(outcome),
            outcome,
            succeeded: classifyAgentRunTerminalOutcome(outcome) === "success" ? 1 : 0,
            completed_at: Date.now(),
          };
          if (!retained || retained.succeeded === 0) {
            state.completions.set(input.idempotencyKey, next);
          }
          if (isFinalInputCompletion(outcome) && row) {
            state.pendingInputs.delete(input.idempotencyKey);
          }
          receipt.outcome = structuredClone(outcome);
        }
      } else if (row?.state === "queued" && row.consumed_event_id === null) {
        state.pendingInputs.set(input.idempotencyKey, { ...row, state: input.disposition });
        if (input.disposition === "cancelled") {
          receipt.withdrawnInputId = input.inputId;
        }
      }
      state.hot.pendingInputs = [...state.pendingInputs.values()].map(
        ({ message_json: _message, ...value }) => value,
      );
      state.hot.completionKeys = [...state.completions.keys()];
      options.admit("commit", grant);
      return receipt;
    },
  };
}
