import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import type { buildLocalUserMessage } from "../pages/chat/user-message-content.ts";

type RetainedMessage = NonNullable<ReturnType<typeof buildLocalUserMessage>>;

type Submission = {
  message: RetainedMessage;
  pendingRunId: string;
  sessionKey: string;
  /** Logical client, not the hello object that rotates on reconnect. */
  owner: object;
} & (
  | { kind: "initial"; sessionId?: string; consumedByEventId?: string }
  | { kind: "delivered"; deliveryKey: string; agentId?: string; sessionId?: string }
);
type RetainedInitialSubmission = Omit<Extract<Submission, { kind: "initial" }>, "message"> &
  ({ pending: true; message: RetainedMessage } | { pending: false; message: null });
export type RetainedChatSubmission =
  | RetainedInitialSubmission
  | (Extract<Submission, { kind: "delivered" }> & { pending: boolean });

/** Preserve identity for late handoffs without retaining submitted text or attachment bytes. */
export function retireInitialChatSubmission(submission: RetainedInitialSubmission): void {
  Object.assign(submission, { pending: false, message: null });
}

type PendingChatCreate = Readonly<{
  creation: Readonly<{ sessionKey: string; admitted: boolean }>;
  message: RetainedMessage | null;
  canDisplay: () => boolean;
}>;

export type ApplicationChatSubmissions = ReturnType<typeof createChatSubmissions>;
/** App-owned display bytes only. Outbox payloads, attempts, and retries stay with the outbox. */
export function createChatSubmissions() {
  const initial = new Map<string, RetainedChatSubmission>();
  // Only the foreground handoff owns a provisional display; accepted turns are separate.
  let pendingCreate: PendingChatCreate | undefined;
  const createListeners = new Set<() => void>();
  const setPendingCreate = (pending: typeof pendingCreate) => {
    pendingCreate = pending;
    for (const listener of createListeners) {
      listener();
    }
  };
  let delivered = new WeakMap<object, Map<string, RetainedChatSubmission>>();
  const initialKey = (sessionKey: string) =>
    [...initial.keys()].find((key) => areUiSessionKeysEquivalent(key, sessionKey));
  const readInitial = (sessionKey: string, owner: object | null, sessionId?: string | null) => {
    const entry = initial.get(initialKey(sessionKey) ?? "");
    return entry?.kind === "initial" &&
      entry.owner === owner &&
      (!entry.sessionId || !sessionId || entry.sessionId === sessionId)
      ? entry
      : null;
  };
  const retain = (submission: Submission | null): RetainedChatSubmission | undefined => {
    if (!submission) {
      return undefined;
    }
    const isInitial = submission.kind === "initial";
    const entries = isInitial
      ? initial
      : (delivered.get(submission.owner) ?? new Map<string, RetainedChatSubmission>());
    const key = isInitial
      ? (initialKey(submission.sessionKey) ?? submission.sessionKey)
      : submission.deliveryKey;
    const previous = entries.get(key);
    if (
      isInitial &&
      previous?.kind === "initial" &&
      previous.owner === submission.owner &&
      previous.pendingRunId === submission.pendingRunId
    ) {
      // Replayed completion cannot revive a consumed/reset turn or discard its physical binding.
      previous.consumedByEventId ??= submission.consumedByEventId;
      return previous;
    }
    if (!isInitial) {
      delivered.set(submission.owner, entries);
    }
    const retained: RetainedChatSubmission = { ...submission, pending: true };
    entries.delete(key);
    entries.set(key, retained);
    // Preserve the initial app limit and delivered per-client lifetime/limit.
    const limit = isInitial ? 32 : 64;
    if (entries.size > limit) {
      entries.delete(entries.keys().next().value!);
    }
    return retained;
  };
  return {
    retain,
    // Display-only admission state; no run id, outbox attempt or accepted send.
    beginCreate: (pending: PendingChatCreate) => {
      setPendingCreate(pending);
      return () => {
        if (pendingCreate === pending) {
          setPendingCreate(undefined);
        }
      };
    },
    // Routes retain only admission metadata after private display bytes are revoked.
    get creation(): Readonly<{ sessionKey: string; admitted: boolean }> | undefined {
      return pendingCreate?.creation;
    },
    readCreateMessage: (sessionKey: string) =>
      pendingCreate?.creation.sessionKey === sessionKey && pendingCreate.canDisplay()
        ? pendingCreate.message
        : null,
    subscribeCreate: (listener: () => void) => {
      createListeners.add(listener);
      return () => createListeners.delete(listener);
    },
    readInitial,
    observeInitialSession: (sessionKey: string, owner: object | null, sessionId: string | null) => {
      const submission = readInitial(sessionKey, owner);
      if (!submission?.pending || !sessionId) {
        return;
      }
      if (submission.sessionId && submission.sessionId !== sessionId) {
        retireInitialChatSubmission(submission);
      } else {
        submission.sessionId = sessionId;
      }
    },
    readDelivered: (key: string, owner: object) => delivered.get(owner)?.get(key),
    clear: () => {
      initial.clear();
      delivered = new WeakMap();
      setPendingCreate(undefined);
    },
  };
}
