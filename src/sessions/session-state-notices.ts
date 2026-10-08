/** Stale-state notice text, coalescing keys, and watcher eligibility. */
import { createInboundDebouncer } from "../auto-reply/inbound-debounce.js";
import {
  assertSessionEventTargetCurrent,
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
  type SessionEventTarget,
} from "../auto-reply/reply/session-event-handoff.js";
import { isSystemEventStoreCurrent } from "../infra/system-event-ownership.js";
import {
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  type SystemEvent,
} from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { acknowledgeSessionStateNoticesInWorker } from "./session-state-notice-acknowledgment.js";

const SESSION_STATE_CONTEXT_PREFIX = "session-state:";
const log = createSubsystemLogger("sessions/state-notices");
type PendingNotice = {
  sessionKey: string;
  changedSessionKey: string;
  agentId: string;
  target: SessionEventTarget;
  occurrence: SystemEvent;
};

function noticeKey(notice: PendingNotice): string {
  return JSON.stringify([
    notice.sessionKey,
    notice.target.storePath,
    notice.target.sessionId,
    notice.target.lifecycleRevision,
    notice.target.generation,
    notice.occurrence.contextKey,
  ]);
}

const notices = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionStateNotices"),
  () => {
    const pendingKeys = new Set<string>();
    const debouncer = createInboundDebouncer<PendingNotice>({
      debounceMs: 20_000,
      buildKey: noticeKey,
      onCancel: (items) => {
        for (const item of items) {
          pendingKeys.delete(noticeKey(item));
        }
      },
      onFlush: (items, createFlush) => {
        for (const item of items) {
          pendingKeys.delete(noticeKey(item));
        }
        return createFlush({
          dispatch: async (lifecycle) => {
            const latest = items.at(-1);
            if (!latest) {
              return;
            }
            const pending = peekSystemEventEntries(latest.sessionKey);
            // A user turn or store replacement can consume the notice before admission.
            const outcomes = await Promise.allSettled(
              items
                .filter((item) => pending.some((event) => event.id === item.occurrence.id))
                .map(async (selected) => {
                  const receipt = enqueueSessionEventForHost(selected.occurrence.text, {
                    agentId: selected.agentId,
                    sessionKey: selected.sessionKey,
                    source: "session",
                    expectedTarget: selected.target,
                    occurrence: selected.occurrence,
                    onAdopted: async () => {
                      await lifecycle.onAdopted();
                      await acknowledgeSessionStateNoticesInWorker(
                        selected.sessionKey,
                        [
                          {
                            targetSessionKey: selected.changedSessionKey,
                            watcherStorePath: selected.occurrence.sessionStorePath ?? null,
                          },
                        ],
                        enqueueSessionStateNotice,
                        {
                          assertCurrent: () => assertSessionEventTargetCurrent(selected.target),
                        },
                      );
                    },
                  });
                  const outcome = await receipt.settled;
                  if (outcome.status === "failed") {
                    throw new Error(outcome.error ?? "Session state notice failed");
                  }
                }),
            );
            const failed = outcomes.find((outcome) => outcome.status === "rejected");
            if (failed?.status === "rejected") {
              throw failed.reason;
            }
          },
        });
      },
      onError: (error) => log.warn(`Session state notice was not delivered: ${String(error)}`),
    });
    return {
      enqueue(notice: PendingNotice) {
        pendingKeys.add(noticeKey(notice));
        return runInDetachedAsyncContext(() => debouncer.enqueue(notice));
      },
      async close() {
        for (const key of pendingKeys) {
          debouncer.cancelKey(key);
        }
        pendingKeys.clear();
        await debouncer.drain();
      },
    };
  },
  (owner) => owner.close(),
);

export function decodeSessionStateNoticeContextKey(contextKey: string): string | undefined {
  if (!contextKey.startsWith(SESSION_STATE_CONTEXT_PREFIX)) {
    return undefined;
  }
  const encoded = contextKey.slice(SESSION_STATE_CONTEXT_PREFIX.length);
  if (!encoded || encoded.length % 2 !== 0 || !/^[0-9a-f]+$/.test(encoded)) {
    return undefined;
  }
  // The notice writer always encodes a valid UTF-8 session key, so a
  // payload that fails strict UTF-8 decoding is corrupt: fail closed instead of
  // letting U+FFFD collisions acknowledge an unrelated watcher cursor.
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.from(encoded, "hex"),
    );
  } catch {
    return undefined;
  }
}

// Terse on purpose: this line lands in model prompts, possibly repeatedly across
// turns. Text must stay byte-stable per frozen watermark so queue dedupe holds,
// and the reconciliation call must be self-contained (explicit target sessionKey).
function sessionStateNoticeText(targetSessionKey: string, lastSeenSequence: number): string {
  return `Session "${targetSessionKey}" changed (other actor). Reconcile before acting: session_status sessionKey "${targetSessionKey}" changesSince ${lastSeenSequence}.`;
}

export function enqueueSessionStateNotice(params: {
  watcherSessionKey: string;
  watcherStorePath?: string | null;
  targetSessionKey: string;
  lastSeenSequence: number;
  queueOnly?: boolean;
}): void {
  const agentId = parseAgentSessionKey(params.watcherSessionKey)?.agentId;
  if (!agentId) {
    return;
  }
  const storePath = params.watcherStorePath ?? null;
  const occurrence = enqueueSystemEventEntry(
    sessionStateNoticeText(params.targetSessionKey, params.lastSeenSequence),
    {
      sessionKey: params.watcherSessionKey,
      sessionStorePath: storePath,
      contextKey: `${SESSION_STATE_CONTEXT_PREFIX}${Buffer.from(params.targetSessionKey, "utf8").toString("hex")}`,
      ...(params.queueOnly ? { replace: true } : {}),
    },
  );
  // Ambient group and nested-session notices remain context for the next ordinary turn.
  if (!occurrence || params.queueOnly || isSubagentSessionKey(params.watcherSessionKey)) {
    return;
  }
  const assertCurrent = () => {
    if (!isSystemEventStoreCurrent(params.watcherSessionKey, storePath)) {
      throw new Error("Session state notice watcher store was replaced");
    }
  };
  void captureSessionEventTargetForHost(agentId, params.watcherSessionKey, { assertCurrent })
    .then((target) => {
      assertCurrent();
      if (
        peekSystemEventEntries(params.watcherSessionKey).some((event) => event.id === occurrence.id)
      ) {
        return notices.enqueue({
          sessionKey: params.watcherSessionKey,
          changedSessionKey: params.targetSessionKey,
          agentId,
          target,
          occurrence,
        });
      }
      return undefined;
    })
    .catch((error: unknown) => log.warn(`Session state notice was not admitted: ${String(error)}`));
}
