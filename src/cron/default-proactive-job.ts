/** Setup-owned default automation identity. Startup and config reload never provision jobs. */
import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBundledProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { AgentDeletionRecoveryHoldPredicate } from "../state/agent-deletion-journal.types.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { readDefaultProactiveJobReceiptsAsync } from "./proactive-job-receipt.js";
import { computeJobNextRunAtMs } from "./service/jobs-scheduling.js";
import { runCronRuntimeMutation } from "./service/runtime-mutation.js";
import { publishCronJobsStoreMutation } from "./store.js";
import type { CronStoredJob } from "./types.js";

export const DEFAULT_PROACTIVE_PROMPT =
  "Review your automation scratch checklist and relevant session context. Do not infer or repeat old tasks from prior conversations. Take useful action only when needed. Use NO_REPLY when there is nothing to tell the user.";

export function createDefaultProactiveJob(
  cfg: OpenClawConfig,
  agentId: string,
  nowMs: number,
  cadenceMs = 30 * 60 * 1000,
): CronStoredJob {
  const owner = normalizeAgentId(agentId);
  const sessionKey =
    cfg.session?.scope === "global"
      ? "global"
      : resolveAgentMainSessionKey({ cfg, agentId: owner });
  const job: CronStoredJob = {
    id: randomUUID(),
    agentId: owner,
    name: `Proactive check (${owner})`,
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "every", everyMs: cadenceMs, anchorMs: nowMs },
    sessionTarget: `session:${sessionKey}`,
    sessionKey,
    wakeMode: "now",
    idleOnly: true,
    payload: { kind: "agentTurn", message: DEFAULT_PROACTIVE_PROMPT, skipIfScratchEmpty: true },
    delivery: { mode: "announce", target: "owner" },
    state: {},
  };
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, nowMs);
  return job;
}

/** Resolve setup's provider-owned cadence before publishing a staged first agent. */
export function resolveDefaultProactiveCadenceMs(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const provider = resolveDefaultModelForAgent({ cfg, agentId }).provider;
  return resolveBundledProviderPolicySurface(provider)?.resolveProactiveCadenceMs?.({
    provider,
    config: cfg,
    env,
  });
}

/** Explicit setup creates the ambient owner's job once; a deletion remains a deletion. */
export async function provisionDefaultProactiveJob(
  cfg: OpenClawConfig,
  agentId: string,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
    cadenceMs?: number;
    commitGuard?: () => void;
    recoveryHoldPredicate?: AgentDeletionRecoveryHoldPredicate;
  } = {},
): Promise<CronStoredJob | undefined> {
  const owner = normalizeAgentId(agentId);
  if (owner !== tryResolveAmbientOwnerAgentId(cfg)) {
    return undefined;
  }
  const recoveryHoldPredicate = structuredClone(options.recoveryHoldPredicate);
  const context = captureOpenClawStateWorkerContext(options);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.commitGuard?.();
  };
  assertCurrent();
  const configuredStore = asOptionalRecord(cfg.cron)?.store;
  const storePath = typeof configuredStore === "string" ? configuredStore : undefined;
  const previous = (
    await readDefaultProactiveJobReceiptsAsync(storePath, [owner], options, {
      context,
      current: true,
    })
  )[owner];
  assertCurrent();
  const nowMs = Date.now();
  const cadenceMs =
    options.cadenceMs ??
    (previous ? undefined : resolveDefaultProactiveCadenceMs(cfg, owner, options.env));
  const planned = createDefaultProactiveJob(cfg, owner, nowMs, cadenceMs);
  let job: CronStoredJob | undefined;
  await runCronRuntimeMutation({
    context,
    type: "cron.provisionDefaultProactive",
    input: { storePath, agentId: owner, planned, recoveryHoldPredicate },
    assertCurrent,
    prepare: () => ({ value: {}, assertCurrent }),
    publish: (outcome) => {
      if (outcome.created) {
        publishCronJobsStoreMutation(outcome.storeKey);
      }
      job = outcome.job;
    },
  });
  return job;
}
