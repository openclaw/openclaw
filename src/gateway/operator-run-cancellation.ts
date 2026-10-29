import { isAgentEventLifecycleGenerationCurrent } from "../infra/agent-events.js";
import { throwIfSettledRejected } from "../infra/error-graph-internal.js";
import { captureSessionControllerSourceSettlement } from "../sessions/session-controller.mailbox.js";
import {
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  isRpcSourceQueued,
  isRpcSourceRegistered,
  requestRpcSourceCancellation,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import { waitForChatAbortTerminalPersistence } from "./chat-abort-lifecycle-internal.js";
import { createChatAbortOps } from "./chat-abort-ops.js";
import { abortChatRunById } from "./chat-abort.js";
import { retainGatewayDeviceRevocation } from "./device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import {
  captureAbortedPartial,
  deferAbortedPartialPersistence,
  prepareChatAbortSessionSnapshot,
  retainChatAbortSessionSnapshot,
  type ChatAbortSessionSnapshot,
} from "./server-methods/chat-aborted-partial.js";
import { resolveAuthenticatedPersonalGatewayProfileId } from "./server-methods/gateway-personal-caller.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";
import { formatForLog } from "./ws-log.js";

type OperatorRunCancellationContext = Pick<
  GatewayRequestContext,
  keyof Parameters<typeof createChatAbortOps>[0] | "logGateway" | "trackExecution"
>;

/** Retain authority before its execution or queue owner can arm cancellation. */
export async function retainGatewayOperatorRun(
  params: Omit<
    Parameters<typeof captureGatewayOperatorRunAuthority>[0],
    "independentContinuation"
  > & {
    context: OperatorRunCancellationContext;
    runId: string;
    /** Canonical child relationship from the admitted session. */
    spawnedBy?: string;
    entry?: RpcSourceRef;
    abortSession?: Extract<ChatAbortSessionSnapshot, { ok: true }>["value"];
    /** Present only for a trusted host-originated input with no explicit human requester. */
    systemTurn?: Parameters<typeof prepareSessionSystemTurnAuthority>[0];
  },
) {
  const captured = params.systemTurn
    ? await prepareSessionSystemTurnAuthority(params.systemTurn)
    : await captureGatewayOperatorRunAuthority({
        ...params,
        // Every child owns its accepted work beyond the requester's recovery turn.
        independentContinuation: params.spawnedBy ? true : undefined,
      });
  const releaseSource =
    captured?.release ?? retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  const signal = captured?.authority.signal;
  let partialSession: ReturnType<typeof retainChatAbortSessionSnapshot> | undefined;
  try {
    if (
      !params.systemTurn &&
      captured &&
      params.entry &&
      isRpcSourceRegistered(params.entry) &&
      resolveAuthenticatedPersonalGatewayProfileId(params.client) === captured.authority.profileId
    ) {
      // Retain human initiation across live queue handoffs. System-turn authority
      // can come from the current session owner and must not mint this fact.
      params.entry.adapter.initiatingPersonalOperator = captured.authority;
    }
    partialSession =
      signal && params.entry
        ? retainChatAbortSessionSnapshot(
            params.abortSession
              ? { ok: true, value: params.abortSession }
              : await prepareChatAbortSessionSnapshot({
                  cfg: params.context.getRuntimeConfig(),
                  key: getRpcSourceIdentity(params.entry).sessionKey,
                  agentId: getRpcSourceIdentity(params.entry).agentId,
                }),
          )
        : undefined;
    const cancellation =
      signal && params.entry && partialSession
        ? createGatewayOperatorRunCancellation({
            signal,
            runId: params.runId,
            entry: params.entry,
            context: params.context,
            session: partialSession.read,
          })
        : undefined;
    return {
      authority: captured?.authority,
      armCancellation: () => cancellation?.arm(),
      retireCancellation: () => {
        cancellation?.release();
        partialSession?.release();
      },
      release: () => {
        cancellation?.release();
        partialSession?.release();
        releaseSource?.();
      },
    };
  } catch (error) {
    partialSession?.release();
    releaseSource?.();
    throw error;
  }
}

/** Queue retirement detaches cancellation while the original authority can still settle work. */
function createGatewayOperatorRunCancellation(params: {
  signal: AbortSignal;
  runId: string;
  entry: RpcSourceRef;
  context: OperatorRunCancellationContext;
  session: () => ChatAbortSessionSnapshot;
}) {
  const { signal, runId, entry, context } = params;
  const sessionKey = getRpcSourceIdentity(entry).sessionKey;
  const lifecycleGeneration = getRpcSourceLifecycleGeneration(entry);
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
    isRpcSourceRegistered(entry) &&
    getRpcSourceIdentity(entry).sessionKey === sessionKey &&
    entry.adapter.projectSessionTerminalPersistence === undefined &&
    entry.adapter.projectSessionTerminalPersisted !== true;
  const cancelQueuedTurn = () => {
    if (!ownsLifetime() || !isRpcSourceRegistered(entry) || !isRpcSourceQueued(entry)) {
      return false;
    }
    entry.adapter.abortStopReason = "rpc";
    entry.adapter.abortDiagnosticReason = "authority-revoked";
    return requestRpcSourceCancellation(entry, signal.reason, () => {
      if (!ownsLifetime() || !isRpcSourceRegistered(entry)) {
        throw new Error("Operator cancellation source is no longer current");
      }
    });
  };
  const cancel = async () => {
    // Queue custody supersedes the source admission even before its active entry
    // is removed. A collected source cannot fall back to aborting another owner.
    if (isRpcSourceRegistered(entry) && isRpcSourceQueued(entry)) {
      if (cancelQueuedTurn()) {
        await captureSessionControllerSourceSettlement(entry.input);
      }
      return;
    }
    if (!ownsActiveRun()) {
      return;
    }
    // A provider can settle and release its run during source abortion. Capture
    // and stop this exact owner before yielding; children retain their own source.
    const text = context.chatRunState.resolveBuffer(runId, { final: true }).text;
    const identity = getRpcSourceIdentity(entry);
    // Internal runs use a separate transcript target; coordination and progress
    // refresh output stay hidden. This snapshot would create a visible reply.
    const snapshot =
      entry.adapter.controlUiVisible !== false && text.trim()
        ? captureAbortedPartial({
            runId,
            sessionKey,
            sessionId: identity.sessionId,
            text,
            abortOrigin: "rpc",
            resolveTerminalProducer: entry.adapter.resolveTerminalProducer,
            session: params.session(),
          })
        : undefined;
    const { aborted } = abortChatRunById(createChatAbortOps(context), {
      runId,
      sessionKey,
      stopReason: "rpc",
      diagnosticReason: "authority-revoked",
      expectedEntry: entry,
      assertCurrent: () => {
        if (!ownsActiveRun()) {
          throw new Error("Operator cancellation source is no longer current");
        }
      },
      onAbortPrepared: () => deferAbortedPartialPersistence(snapshot, context),
    });
    if (!aborted) {
      return;
    }
    // Listener release cannot revoke already accepted terminal persistence.
    // The asynchronous writer stays outside admission's eager module graph.
    const settled = await Promise.allSettled([
      waitForChatAbortTerminalPersistence(entry),
      captureSessionControllerSourceSettlement(entry.input),
      ...(snapshot
        ? [
            import("./server-methods/chat-transcript-persistence.runtime.js").then((transcript) =>
              transcript.persistAbortedPartials({ context, snapshots: [snapshot] }),
            ),
          ]
        : []),
    ]);
    throwIfSettledRejected(settled, "Operator access cancellation did not fully settle");
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
