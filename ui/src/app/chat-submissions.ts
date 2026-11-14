import { createChangeListeners } from "../../../src/shared/listeners.js";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import type { buildLocalUserMessage } from "../pages/chat/user-message-content.ts";
import type { CreationComposer } from "../pages/new-session/creation-composer.ts";

type RetainedMessage = NonNullable<ReturnType<typeof buildLocalUserMessage>>;

type Submission = {
  message: RetainedMessage;
  pendingRunId: string;
  sessionKey: string;
  /** Logical client, not the hello object that rotates on reconnect. */
  owner: object;
} & (
  | { kind: "initial"; sessionId?: string }
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
  composer?: CreationComposer;
  displayName?: string;
  /** Custom group requested by the create; its admitted row lands in that section. */
  category?: string;
  /** A background start the Gateway refused; its route offers Try again. */
  failure?: Readonly<{ error: string; retry: () => void }>;
}>;
type AcceptedChatCreate = Omit<PendingChatCreate, "message" | "composer">;

export type ApplicationChatSubmissions = ReturnType<typeof createChatSubmissions>;
/** App-owned display bytes only. Delivery and retries stay with the outbox. */
export function createChatSubmissions() {
  const initial = new Map<string, RetainedChatSubmission>();
  // Only the foreground handoff owns a provisional display; accepted turns are separate.
  let pendingCreate: PendingChatCreate | undefined;
  // Accepted metadata survives admission without retaining the draft's message or composer.
  let acceptedCreate: AcceptedChatCreate | undefined;
  // Background starts never navigate; each previews only its own session route.
  const backgroundCreates = new Map<string, PendingChatCreate>();
  const readCreateFor = (sessionKey: string) => {
    const pending =
      pendingCreate?.creation.sessionKey === sessionKey
        ? pendingCreate
        : backgroundCreates.get(sessionKey);
    return pending?.canDisplay() ? pending : undefined;
  };
  const createListeners = createChangeListeners();
  const setPendingCreate = (pending: typeof pendingCreate) => {
    pendingCreate = pending;
    createListeners.publish();
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
    /** Display-only preview of a background start until its owner admits or retires it. */
    beginBackgroundCreate: (pending: PendingChatCreate) => {
      const key = pending.creation.sessionKey;
      let current = pending;
      backgroundCreates.set(key, current);
      createListeners.publish();
      const owns = () => backgroundCreates.get(key) === current;
      return {
        update: (next: PendingChatCreate) => {
          if (owns()) {
            current = next;
            backgroundCreates.set(key, next);
            createListeners.publish();
          }
        },
        clear: () => {
          if (owns()) {
            backgroundCreates.delete(key);
            createListeners.publish();
          }
        },
      };
    },
    // Routes retain only admission metadata after private display bytes are revoked.
    get creation(): Readonly<{ sessionKey: string; admitted: boolean }> | undefined {
      return pendingCreate?.creation;
    },
    get creating(): boolean {
      return pendingCreate?.creation.admitted === false || backgroundCreates.size > 0;
    },
    /** The foreground handoff or a background start previewing this session route. */
    creationFor: (sessionKey: string) =>
      pendingCreate?.creation.sessionKey === sessionKey
        ? pendingCreate.creation
        : readCreateFor(sessionKey)?.creation,
    readCreateFor,
    readCreate: () => (pendingCreate?.canDisplay() ? pendingCreate : undefined),
    acceptCreate: (accepted: AcceptedChatCreate) => {
      acceptedCreate = accepted;
      createListeners.publish();
    },
    readAcceptedCreate: () => (acceptedCreate?.canDisplay() ? acceptedCreate : undefined),
    retireAcceptedCreate: () => {
      if (acceptedCreate) {
        acceptedCreate = undefined;
        createListeners.publish();
      }
    },
    readCreateMessage: (sessionKey: string) => readCreateFor(sessionKey)?.message ?? null,
    readCreateComposer: (sessionKey: string) => readCreateFor(sessionKey)?.composer,
    subscribeCreate: createListeners.subscribe,
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
      acceptedCreate = undefined;
      backgroundCreates.clear();
      setPendingCreate(undefined);
    },
  };
}
