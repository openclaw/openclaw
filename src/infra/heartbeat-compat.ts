/** Deprecated v4 controls. Ordinary automation receipts are the only ownership source. */
import { listAgentIds } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDefaultProactiveJobReceiptsAsync } from "../cron/proactive-job-receipt.js";
import type { CronServiceContract } from "../cron/service-contract.js";

export async function getLegacyHeartbeatJobIds(cfg: OpenClawConfig): Promise<string[]> {
  const receipts = await readDefaultProactiveJobReceiptsAsync(undefined, listAgentIds(cfg));
  const ids: string[] = [];
  for (const receipt of Object.values(receipts)) {
    if (receipt.phase === "complete") {
      ids.push(receipt.jobId, ...(receipt.convertedJobIds ?? []));
    }
  }
  return ids;
}

export async function setLegacyHeartbeatsEnabled(
  cfg: OpenClawConfig,
  cron: CronServiceContract,
  enabled: boolean,
  assertCurrent?: () => void,
): Promise<void> {
  assertCurrent?.();
  const ids = new Set(await getLegacyHeartbeatJobIds(cfg));
  const jobs = (await cron.list({ includeDisabled: true })).filter((job) => ids.has(job.id));
  if (!jobs.length) {
    throw new Error(
      "No converted/default proactive automation exists. Run openclaw doctor --fix or manage ordinary automations; deleted jobs are not recreated.",
    );
  }
  for (const job of jobs) {
    assertCurrent?.();
    await cron.update(job.id, { enabled }, { commitGuard: assertCurrent });
  }
}

/** Stable hook boundary: converted/default jobs only, never unrelated cron turns. */
export async function applyLegacyHeartbeatPromptContribution(params: {
  cfg: OpenClawConfig;
  jobId: string;
  name: string;
  agentId: string;
  sessionKey: string;
  prompt: string;
  assertCurrent: () => void;
}): Promise<string> {
  params.assertCurrent();
  const { getGlobalHookRunner } = await import("../plugins/hook-runner-global.js");
  params.assertCurrent();
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("heartbeat_prompt_contribution")) {
    return params.prompt;
  }
  const ids = await getLegacyHeartbeatJobIds(params.cfg);
  params.assertCurrent();
  if (!ids.includes(params.jobId)) {
    return params.prompt;
  }
  const contribution = await runner.runHeartbeatPromptContribution(
    { agentId: params.agentId, sessionKey: params.sessionKey, heartbeatName: params.name },
    { agentId: params.agentId, sessionKey: params.sessionKey, trigger: "heartbeat" },
  );
  params.assertCurrent();
  const { sliceToolResultTextToBudget } =
    await import("../agents/embedded-agent-runner/tool-result-text-budget.js");
  params.assertCurrent();
  return [
    contribution?.prependContext && sliceToolResultTextToBudget(contribution.prependContext, 1000),
    params.prompt,
    contribution?.appendContext && sliceToolResultTextToBudget(contribution.appendContext, 1000),
  ]
    .filter(Boolean)
    .join("\n\n");
}
