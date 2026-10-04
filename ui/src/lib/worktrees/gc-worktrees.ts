import type { WorktreesGcResult } from "../../../../packages/gateway-protocol/src/schema/worktrees.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";

export async function gcManagedWorktrees(
  client: Pick<GatewayBrowserClient, "request">,
  isCurrent: () => boolean,
): Promise<WorktreesGcResult | undefined> {
  if (!isCurrent()) {
    return undefined;
  }
  let result = await client.request<WorktreesGcResult>("worktrees.gc", {});
  const jobId = result.jobId;
  while (result.state === "queued" || result.state === "running") {
    if (!isCurrent()) {
      return undefined;
    }
    if (!jobId) {
      throw new Error(t("sessionsView.deletePreservedReasons.cleanup-failed"));
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_000);
    });
    if (!isCurrent()) {
      return undefined;
    }
    result = await client.request<WorktreesGcResult>("worktrees.gc", { jobId });
  }
  if (!isCurrent()) {
    return undefined;
  }
  if (result.state === "failed" || result.outcome === "partial") {
    throw new Error(
      result.error ||
        result.issues?.map((issue) => issue.reason).join("; ") ||
        t("sessionsView.deletePreservedReasons.cleanup-failed"),
    );
  }
  return result;
}
