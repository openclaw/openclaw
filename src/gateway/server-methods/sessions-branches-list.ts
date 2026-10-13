import {
  ErrorCodes,
  errorShape,
  type SessionsBranchesListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listSessionBranches } from "../../config/sessions/session-accessor.js";
import {
  getSessionActorStorageBinding,
  withSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import {
  captureSessionUpstreamLinkReadSource,
  prepareSessionUpstreamLink,
} from "../../sessions/session-upstream-links-runtime.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { withGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export async function listSessionBranchesForGateway(
  options: Omit<GatewayRequestHandlerOptions, "params"> & { params: SessionsBranchesListParams },
): Promise<void> {
  const { params, respond, context } = options;
  const sessionKey = params.sessionKey.trim();
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, sessionKey, params.agentId);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
  }
  // Branches depend on transcript/lifecycle state, not a label or activity update during I/O.
  const read = retainSessionScopedRead(options, sessionKey, requestedAgent.agentId, {
    allowMetadataChanges: true,
  });
  const run = () =>
    withGatewaySessionEntryReadOnly(
      {
        key: sessionKey,
        cfg,
        agentId: requestedAgent.agentId,
        excludeInternalEffects: true,
        projection: "list",
      },
      async (current, assertCurrent) => {
        const upstreamLink = current.entry?.sessionId
          ? await prepareSessionUpstreamLink(
              captureSessionUpstreamLinkReadSource(),
              current.canonicalKey,
              current.agentId,
            )
          : undefined;
        assertCurrent();
        read?.assertCurrent();
        if (!current.entry?.sessionId || upstreamLink) {
          // Fresh and upstream-owned sessions have no local branches. Only the
          // mutating siblings treat those states as errors.
          respond(true, { branches: [] }, undefined);
          return;
        }
        const memory = getSessionActorStorageBinding({
          sessionKey: current.canonicalKey,
          agentId: current.agentId,
          storePath: current.storePath,
        });
        const result = memory
          ? await memory.actor.storage!.read(
              { type: "session.history.branches", input: {} },
              memory.authority,
            )
          : await listSessionBranches({
              agentId: current.agentId,
              sessionKey: current.canonicalKey,
              sessionStoreKey: current.canonicalKey,
              storePath: current.storePath,
            });
        assertCurrent();
        read?.assertCurrent();
        if (result.status !== "ok") {
          respond(
            false,
            undefined,
            errorShape(
              result.status === "failed" ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
              {
                "missing-session": "session not found",
                "unsupported-storage": "session transcript storage does not support branch listing",
                failed: "failed to list session branches",
              }[result.status],
            ),
          );
          return;
        }
        respond(true, { branches: result.branches }, undefined);
      },
    );
  const assertCurrent = () => read?.assertCurrent();
  try {
    const handled = await withSessionActorStorage(
      { sessionKey, agentId: requestedAgent.agentId },
      {
        lifetime: { assertCurrent, assertReadable: assertCurrent },
        authority: { assertCurrent, authorize() {} },
      },
      async () => {
        await run();
        return true;
      },
    );
    if (!handled) {
      await run();
    }
  } finally {
    read?.release();
  }
}
