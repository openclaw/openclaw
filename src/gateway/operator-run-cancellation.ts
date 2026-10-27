import { missingScopeErrorShape } from "../../packages/gateway-protocol/src/index.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
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
import { authorizeOperatorScopesForRequiredScope } from "./method-scopes.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import {
  captureAbortedPartial,
  deferAbortedPartialPersistence,
  prepareChatAbortSessionSnapshot,
  retainChatAbortSessionSnapshot,
  type ChatAbortSessionSnapshot,
} from "./server-methods/chat-aborted-partial.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
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
    /** Canonical admission snapshot; public/plugin projections omit the private workspace reference. */
    workspaceSession?: {
      agentId: string;
      sessionKey: string;
      entry: InternalSessionEntry;
    };
    entry?: RpcSourceRef;
    abortSession?: Extract<ChatAbortSessionSnapshot, { ok: true }>["value"];
  },
) {
  let captured = await captureGatewayOperatorRunAuthority({
    ...params,
    // Every child owns its accepted work beyond the requester's recovery turn.
    independentContinuation: params.spawnedBy ? true : undefined,
  });
  const workspaceSession = params.workspaceSession;
  if (workspaceSession?.entry.inheritedWorktreeId) {
    const resources = new DisposableStack();
    const capturedSource = captured;
    resources.defer(() => capturedSource?.release());
    try {
      const context = params.context.resolveGatewayContext?.();
      if (!context) {
        throw new Error("Inherited project access requires its current Gateway binding");
      }
      const assertSourceCurrent = () => {
        capturedSource?.authority.assertCurrent();
        if (params.context.resolveGatewayContext?.() !== context) {
          throw new Error("Inherited project Gateway authority changed");
        }
      };
      const { resolveLocalWorkspaceOwner } =
        await import("./worker-environments/local-workspace-projection.js");
      const owner = await resolveLocalWorkspaceOwner({
        cfg: context.getRuntimeConfig(),
        agentId: workspaceSession.agentId,
        sessionKey: workspaceSession.sessionKey,
        workspaceDir: workspaceSession.entry.spawnedWorkspaceDir,
        inheritWorkspace: true,
        assertCurrent: assertSourceCurrent,
      });
      if (!owner || owner.worktree.id !== workspaceSession.entry.inheritedWorktreeId) {
        owner?.[Symbol.dispose]();
        throw new Error("Inherited project workspace is no longer available");
      }
      resources.use(owner);
      const { resolveSessionMutationAuthorizationAsync } =
        await import("./session-sharing-authorization-async.js");
      // Chat and native child admission choose broad write before the own-session alternative. The
      // retained source already intersects the initiating caller and transport ceilings.
      const scope = authorizeOperatorScopesForRequiredScope(
        "operator.write",
        capturedSource?.authority.scopes ?? params.client?.connect.scopes ?? [],
        "operator.sessions.write",
      );
      if (capturedSource && !scope.allowed) {
        throw new SessionMutationAuthorizationChangedError(
          missingScopeErrorShape({
            missingScope: scope.missingScope,
            requiredScopes: [scope.missingScope],
          }),
        );
      }
      const assertions: Array<() => void> = [owner.assertCurrent];
      for (const sessionKey of owner.sourceSessionKeys) {
        const { authorization, error } = await resolveSessionMutationAuthorizationAsync({
          client: params.client,
          context,
          method: "agent",
          requestParams: { agentId: workspaceSession.agentId, sessionKey },
          sessionScope: scope.allowed ? scope.sessionScope : undefined,
          assertInvocationCurrent: assertSourceCurrent,
        });
        if (error) {
          throw new SessionMutationAuthorizationChangedError(error);
        }
        if (authorization) {
          resources.defer(() => authorization.release?.());
          assertions.push(authorization.assertCurrent);
        }
      }
      let references = 1;
      const assertCurrent = composeSessionSourceAssertion(
        [assertSourceCurrent, ...assertions],
        (assertSources) => {
          if (resources.disposed) {
            throw new Error("Inherited project run authority is no longer active");
          }
          assertSources();
        },
      );
      const releaseHold = () => {
        let released = false;
        return () => {
          if (!released) {
            released = true;
            if (--references === 0) {
              resources.dispose();
            }
          }
        };
      };
      assertCurrent();
      // Accepted descendants retain the source policy and session chain, never the parent's turn.
      if (capturedSource) {
        const authority = createAdmittedRunOperatorAuthority({
          ...capturedSource.authority,
          assertCurrent,
          retain: () => {
            authority.assertCurrent();
            references++;
            return releaseHold();
          },
          get modelPolicy() {
            return capturedSource.authority.modelPolicy;
          },
        });
        captured = { authority, release: releaseHold() };
      } else {
        // Trusted system runs have no operator to bind. Their runtime keeps the same workspace owner.
        resources.dispose();
      }
    } catch (error) {
      resources.dispose();
      throw error;
    }
  }
  const releaseSource =
    captured?.release ?? retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  const signal = captured?.authority.signal;
  let partialSession: ReturnType<typeof retainChatAbortSessionSnapshot> | undefined;
  try {
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
  } catch (error) {
    releaseSource?.();
    throw error;
  }
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
