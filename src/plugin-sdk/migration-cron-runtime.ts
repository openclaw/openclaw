import { normalizeCronRunJobId } from "../cron/run-history.js";
import type { CronJobCreate } from "../cron/types.js";
import { isValidAgentId } from "../routing/session-key.js";
import type { MigrationProviderContext } from "./plugin-entry.js";

/** Portable recurring prompt; executable triggers and delivery authority are not imported. */
export type MigrationCronJob = {
  id: string;
  agentId: string;
  name: string;
  message: string;
  enabled: boolean;
  schedule: { kind: "cron"; expr: string; tz: string };
};

function nativeInput(input: MigrationCronJob): CronJobCreate {
  normalizeCronRunJobId(input.id);
  if (!isValidAgentId(input.agentId)) {
    throw new Error("Migration cron requires a valid agent id.");
  }
  if (typeof input.enabled !== "boolean" || !input.message.trim()) {
    throw new Error("Migration cron requires explicit activation and a nonempty prompt.");
  }
  if (input.schedule.kind !== "cron" || !input.schedule.tz.trim()) {
    throw new Error("Migration cron requires an explicit cron expression and timezone.");
  }
  return {
    id: input.id,
    agentId: input.agentId,
    owner: { agentId: input.agentId },
    name: input.name,
    enabled: input.enabled,
    schedule: { ...input.schedule, staggerMs: 0 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: input.message },
    delivery: { mode: "none" },
  };
}

/** Use the scheduler's own validation before presenting a migration plan. */
export async function validateMigrationCronJobCore(
  input: MigrationCronJob,
): Promise<string | undefined> {
  try {
    const { createJob } = await import("../cron/service/jobs.js");
    createJob({ deps: { nowMs: Date.now } }, nativeInput(input));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Adds through native admission without starting the scheduler or replacing an existing job. */
export async function applyMigrationCronJobCore(
  ctx: MigrationProviderContext,
  input: MigrationCronJob,
): Promise<"created" | "existing" | "conflict"> {
  const { captureMigrationOwner } = await import("./migration-owner.js");
  const owner = captureMigrationOwner(ctx);
  const [
    { resolveConfiguredAgentId },
    { readCurrentConfigForPolicyCheck },
    { resolveConfigPath },
    { CronService },
    { createJob },
    { resolveCronJobsStorePathFromConfigAsync },
    { GatewayScheduler },
    { resolveCronJobConfigRevision },
  ] = await Promise.all([
    import("../agents/agent-scope-config.js"),
    import("../config/io.runtime.js"),
    import("../config/paths.js"),
    import("../cron/service.js"),
    import("../cron/service/jobs.js"),
    import("../cron/store/paths.js"),
    import("../infra/gateway-scheduler.js"),
    import("../cron/config-revision.js"),
  ]);
  // Native agent creation publishes to disk; onboarding may still hold an older config wrapper.
  const configPath = resolveConfigPath();
  const currentConfig = () => readCurrentConfigForPolicyCheck({ configPath, env: process.env });
  const assertCurrent = () => {
    owner.assertCurrent();
    resolveConfiguredAgentId(currentConfig(), input.agentId);
  };
  assertCurrent();
  const spec = nativeInput(input);
  const expected = createJob({ deps: { nowMs: Date.now } }, spec);
  const storePath = await resolveCronJobsStorePathFromConfigAsync(currentConfig());
  assertCurrent();
  const scheduler = new GatewayScheduler();
  const unexpectedExecution = () => {
    throw new Error("Migration must not execute scheduled work.");
  };
  const service = new CronService({
    scheduler,
    storePath,
    cronEnabled: false,
    cronConfig: currentConfig().cron,
    defaultAgentId: input.agentId,
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    enqueueSystemEvent: unexpectedExecution,
    requestHeartbeat: unexpectedExecution,
    runIsolatedAgentJob: async () => unexpectedExecution(),
  });
  try {
    const existing = await service.readJob(input.id);
    assertCurrent();
    if (existing) {
      // Native revision includes every authored field and excludes mutable run state.
      return resolveCronJobConfigRevision({ ...existing, createdAtMs: 0 }) ===
        resolveCronJobConfigRevision({ ...expected, createdAtMs: 0 })
        ? "existing"
        : "conflict";
    }
    // No declarationKey: the committing store rejects an ID collision instead of converging it.
    await service.add(spec, { enabledExplicit: true, commitGuard: assertCurrent });
    assertCurrent();
    return "created";
  } finally {
    service.stop();
    await service.waitForIdle();
    await scheduler.stop();
  }
}
