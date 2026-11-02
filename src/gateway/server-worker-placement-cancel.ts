import { createChatAbortOps } from "./chat-abort-ops.js";
import { abortChatRunsForSessionKeyWithPartials } from "./server-methods/chat-abort-runtime.js";
import type { ChatAbortSessionSnapshot } from "./server-methods/chat-aborted-partial.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

export type WorkerPlacementSessionWorkCancellation = (request: {
  sessionId: string;
  sessionKeys: readonly string[];
  agentId: string;
  session?: ChatAbortSessionSnapshot;
  assertCurrent: () => void;
  onCancellationStarted?: () => void;
}) => Promise<void>;

export async function cancelGatewayWorkerSessionWork(
  context: GatewayRequestContext,
  request: Parameters<WorkerPlacementSessionWorkCancellation>[0],
): Promise<void> {
  request.assertCurrent();
  const aborted = await abortChatRunsForSessionKeyWithPartials({
    context,
    ops: createChatAbortOps(context),
    sessionId: request.sessionId,
    session: request.session,
    sessionKey: request.sessionKeys[0]!,
    sessionKeyAliases: request.sessionKeys.slice(1),
    agentId: request.agentId,
    // The revalidated session lifecycle owns every run on this resource, just as
    // archive/delete do; these internal flags do not elevate the RPC caller.
    requester: { isAdmin: true },
    includeProtectedRuns: true,
    abortOrigin: "rpc",
    stopReason: "rpc",
    stopSource: "operator-revocation",
    assertCurrent: request.assertCurrent,
    onCancellationStarted: request.onCancellationStarted,
  });
  if (aborted.unauthorized) {
    throw new Error("Session cancellation did not persist before cloud worker stop");
  }
}
