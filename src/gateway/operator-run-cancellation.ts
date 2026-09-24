import { isAgentEventLifecycleGenerationCurrent } from "../infra/agent-events.js";
import { waitForChatAbortTerminalPersistence } from "./chat-abort-lifecycle-internal.js";
import { createChatAbortOps } from "./chat-abort-ops.js";
import {
  abortChatRunById,
  isChatAbortControllerEntryAbortable,
  type ChatAbortControllerEntry,
} from "./chat-abort.js";
import { abortQueuedChatTurnById } from "./chat-queued-turns.js";
import { retainGatewayDeviceRevocation } from "./device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import {
  captureAbortedPartial,
  deferAbortedPartialPersistence,
} from "./server-methods/chat-aborted-partial.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { formatForLog } from "./ws-log.js";

type OperatorRunCancellationContext = Pick<
  GatewayRequestContext,
  | "agentRunSeq"
  | "broadcast"
  | "cancelRunBoundApprovals"
  | "chatAbortControllers"
  | "chatQueuedTurns"
  | "chatRunState"
  | "getRuntimeConfig"
  | "logGateway"
  | "nodeSendToSession"
  | "removeChatRun"
  | "trackExecution"
>;

/** Retain authority before its execution or queue owner can arm cancellation. */
export function retainGatewayOperatorRun(
  params: Parameters<typeof captureGatewayOperatorRunAuthority>[0] & {
    context: OperatorRunCancellationContext;
    runId: string;
    entry?: ChatAbortControllerEntry;
  },
) {
  const captured = captureGatewayOperatorRunAuthority(params);
  const releaseSource =
    captured?.release ?? retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  const signal = captured?.authority.signal;
  const cancellation =
    signal && params.entry
      ? createGatewayOperatorRunCancellation({
          signal,
          runId: params.runId,
          entry: params.entry,
          context: params.context,
        })
      : undefined;
  return {
    authority: captured?.authority,
    armCancellation: () => cancellation?.arm(),
    retireCancellation: () => cancellation?.release(),
    release: () => {
      cancellation?.release();
      releaseSource?.();
    },
  };
}

/** Queue retirement detaches cancellation while the original authority can still settle work. */
function createGatewayOperatorRunCancellation(params: {
  signal: AbortSignal;
  runId: string;
  entry: ChatAbortControllerEntry;
  context: OperatorRunCancellationContext;
}) {
  const { signal, runId, entry, context } = params;
  const controller = entry.controller;
  const sessionKey = entry.sessionKey;
  const lifecycleGeneration = entry.lifecycleGeneration;
  let released = false;
  let armed = false;
  let cancellationStarted = false;
  const ownsLifetime = () =>
    !released &&
    (!lifecycleGeneration || isAgentEventLifecycleGenerationCurrent(lifecycleGeneration));
  // chat-send admission hides progress-card refreshes while execution is live.
  // Pending lifecycle errors can still retry; persistence and the execution
  // owner's abortability, not sidebar projection, distinguish terminal work.
  const ownsActiveRun = () =>
    ownsLifetime() &&
    context.chatAbortControllers.get(runId) === entry &&
    entry.controller === controller &&
    entry.sessionKey === sessionKey &&
    !entry.registrationCleanupRequested &&
    entry.projectSessionTerminalPersistence === undefined &&
    entry.projectSessionTerminalPersisted !== true &&
    isChatAbortControllerEntryAbortable(entry);
  const cancelQueuedTurn = () => {
    const queued = context.chatQueuedTurns.get(runId);
    if (!ownsLifetime() || queued?.controller !== controller || queued.abortable === false) {
      return;
    }
    abortQueuedChatTurnById(context.chatQueuedTurns, {
      runId,
      sessionKey: queued.sessionKey,
      stopReason: "rpc",
    });
  };
  const cancel = async () => {
    // Queue custody supersedes the source admission even before its active entry
    // is removed. A collected source cannot fall back to aborting another owner.
    if (context.chatQueuedTurns.get(runId)?.controller === controller) {
      cancelQueuedTurn();
      return;
    }
    if (!ownsActiveRun()) {
      return;
    }
    // A provider can settle and release its run during source abortion. Capture
    // and stop this exact owner before yielding; children retain their own source.
    const text = context.chatRunState.resolveBuffer(runId, { final: true }).text;
    // Internal runs use a separate transcript target; coordination and progress
    // refresh output stay hidden. This snapshot would create a visible reply.
    const snapshot =
      entry.controlUiVisible !== false && text.trim()
        ? captureAbortedPartial({
            runId,
            sessionKey,
            sessionId: entry.sessionId,
            agentId: entry.agentId,
            text,
            abortOrigin: "rpc",
            resolveTerminalProducer: entry.resolveTerminalProducer,
          })
        : undefined;
    const { aborted } = abortChatRunById(createChatAbortOps(context), {
      runId,
      sessionKey,
      stopReason: "rpc",
      onAbortCommitted: () => deferAbortedPartialPersistence(snapshot, context),
    });
    if (!aborted) {
      return;
    }
    // Listener release cannot revoke already accepted terminal persistence.
    // The asynchronous writer stays outside admission's eager module graph.
    const settled = await Promise.allSettled([
      waitForChatAbortTerminalPersistence(entry),
      ...(snapshot
        ? [
            import("./server-methods/chat-transcript-persistence.runtime.js").then((transcript) =>
              transcript.persistAbortedPartials({ context, snapshots: [snapshot] }),
            ),
          ]
        : []),
    ]);
    const failures = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Operator access cancellation did not fully settle");
    }
  };
  const onAbort = () => {
    if (released || cancellationStarted) {
      return;
    }
    cancellationStarted = true;
    void context.trackExecution(cancel).catch((error: unknown) => {
      context.logGateway.warn(`Operator access cancellation failed: ${formatForLog(error)}`);
    });
  };
  return {
    arm: () => {
      if (released || armed) {
        return;
      }
      armed = true;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    },
    release: () => {
      released = true;
      signal.removeEventListener("abort", onAbort);
    },
  };
}
