import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import type { GitMergedPullHead } from "../infra/git-read-operations.js";
import { getInProcessGatewayRequestContext } from "../plugins/runtime/gateway-request-scope.js";
import { prepareControlUiSessionPrServiceTarget } from "./control-ui-session-pr-read.js";
import { withControlUiSessionPrSource } from "./control-ui-session-pr-source.js";
import { readKnownSessionBranchMergedHeads } from "./control-ui-session-prs.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

/** Optional cap-ordering evidence; never starts a GitHub request or supplies removal authority. */
export async function readKnownWorktreeMergedHeads(
  record: ManagedWorktreeRecord,
  config: OpenClawConfig,
): Promise<readonly GitMergedPullHead[]> {
  if (record.ownerKind !== "session" || !record.ownerId) {
    return [];
  }
  const owner = getInProcessGatewayRequestContext();
  const projection = getSessionRowProjection(owner);
  if (!owner || !projection) {
    return [];
  }
  const currentProjection = () =>
    getInProcessGatewayRequestContext() === owner && getRuntimeConfig() === config
      ? getSessionRowProjection(owner)
      : undefined;
  try {
    const requested = resolveRequestedSessionAgentId(config, record.ownerId);
    if (!requested.ok) {
      return [];
    }
    const target = await prepareControlUiSessionPrServiceTarget(currentProjection, {
      sessionKey: record.ownerId,
      agentId: requested.agentId,
    });
    if (!target?.assertCurrent || typeof target.source !== "string") {
      return [];
    }
    const row = projection.capture({
      key: target.params.sessionKey,
      agentId: target.params.agentId,
    });
    const binding = row?.entry?.worktree;
    if (
      binding?.id !== record.id ||
      binding.branch !== record.branch ||
      binding.repoRoot !== record.repoRoot
    ) {
      return [];
    }
    const assertTargetCurrent = target.assertCurrent;
    const root = target.source;
    return await withControlUiSessionPrSource(
      target.readSource,
      async (assertSourceCurrent, sourceIdentity) => {
        const assertCurrent = () => {
          assertTargetCurrent();
          assertSourceCurrent();
        };
        assertCurrent();
        const context = await runGitReadOperation({
          type: "checkout.context",
          input: { root, githubHost: target.githubHost },
        });
        assertCurrent();
        return context?.branch === record.branch
          ? readKnownSessionBranchMergedHeads(context, { target, sourceIdentity, assertCurrent })
          : [];
      },
    );
  } catch {
    // A missing or revoked fact affects ranking only; Git still classifies the candidate.
    return [];
  }
}
