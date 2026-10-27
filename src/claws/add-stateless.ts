import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { claimCompletedAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { pruneAgentConfig } from "../commands/agents.config.js";
import { readConfigFileSnapshotForWrite, transformConfigFileWithRetry } from "../config/config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import { copyRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { hasErrnoCode } from "../infra/errno.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { readAgentDeletionJournalAsync } from "../state/agent-deletion-journal.js";
import { resolveUserPath } from "../utils.js";
import { addClawAgentToConfig } from "./add-agent-config.js";
import { ClawAddMutationError } from "./add-mutation-error.js";
import { planWithPackageActions, sameCommittedAgent } from "./add-plan-helpers.js";
import { CLAW_ADD_RESULT_SCHEMA_VERSION } from "./add.js";
import { seedClawPackageBootstrap } from "./bootstrap.js";
import {
  ClawCronInstallError,
  clawCronGatewayJobConfigRevision,
  clawCronGatewayJobMatchesRef,
  installClawCronJobsStateless,
  type ClawCronGateway,
  type PersistedClawCronRef,
} from "./cron.js";
import { digestClawValue } from "./digest.js";
import {
  ClawMcpInstallError,
  installClawMcpServersStateless,
  rollbackStatelessClawMcpServers,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
import {
  ClawPackageInstallError,
  installClawPackages,
  rollbackStatelessClawPackages,
  type ClawPluginInstallConsent,
  type ClawSkillInstallConsent,
} from "./packages.js";
import type { ClawPluginRuntimeOptions } from "./plugin-runtime.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import type { ClawMutationStateOptions } from "./state-mutation-options.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "./types.js";
import { createClawWorkspaceFiles, type PersistedClawWorkspaceFile } from "./workspace.js";

type ConfigCommit = (
  transform: (config: OpenClawConfig, runtimeConfig?: OpenClawConfig) => OpenClawConfig,
) => Promise<void>;

export type StatelessClawAddOptions = ClawMutationStateOptions & {
  assertForwardCurrent?: () => void;
  assertReviewedConfig?: (config: OpenClawConfig, phase?: "after-agent-commit") => void;
  getCurrentConfig?: () => OpenClawConfig;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  consentPlanIntegrity?: string;
  pluginConsent?: ClawPluginInstallConsent;
  skillConsent?: ClawSkillInstallConsent;
  reloadPlugins?: PluginInstallBatchReload;
  runtimeBatch?: ClawPluginRuntimeOptions["runtimeBatch"];
  cronGateway?: Pick<
    ClawCronGateway,
    "add" | "list" | "waitUntilAgentAvailable" | "writeScratch" | "enable"
  > &
    Partial<Pick<ClawCronGateway, "get" | "remove">>;
  commitConfig?: ConfigCommit;
  configWriteOptions?: ConfigWriteOptions;
  rollbackNewAgent?: (plan: ClawAddPlan, cronJobs: PersistedClawCronRef[]) => Promise<void>;
};

export type StatelessClawAddResult = {
  schemaVersion: typeof CLAW_ADD_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  mutationAllowed: true;
  planIntegrity: string;
  status: "complete" | "partial";
  claw: ClawAddPlan["claw"];
  agent: ClawAddPlan["agent"];
  workspaceCreated: boolean;
  configCommitted: boolean;
  workspaceFiles: PersistedClawWorkspaceFile[];
  packages: PersistedClawPackageRef[];
  mcpServers: PersistedClawMcpServerRef[];
  cronJobs: PersistedClawCronRef[];
  error?: { code: string; message: string };
};

export type StatelessClawAddStage =
  | { kind: "partial"; result: StatelessClawAddResult }
  | {
      kind: "ready";
      continue: (options?: StatelessClawAddOptions) => Promise<StatelessClawAddResult>;
      stageAgent: (options?: StatelessClawAddOptions) => Promise<StatelessClawAddAgentStage>;
      failBeforeContinue: (error: unknown, code: string) => Promise<StatelessClawAddResult>;
    };

type StatelessClawAddAgentStage =
  | { kind: "partial"; result: StatelessClawAddResult }
  | {
      kind: "ready";
      finish: (options?: StatelessClawAddOptions) => Promise<StatelessClawAddResult>;
      fail: (
        error: unknown,
        code: string,
        options?: StatelessClawAddOptions,
      ) => Promise<StatelessClawAddResult>;
    };

function assertWorkspacePathUnchanged(workspace: string): void {
  const current = resolvePathViaExistingAncestorSync(workspace);
  const normalize = (path: string) =>
    process.platform === "win32" ? normalizeWindowsPathForComparison(path) : path;
  if (normalize(current) !== normalize(workspace)) {
    throw new ClawAddMutationError(
      "workspace_path_changed",
      `Workspace ancestry changed after planning: ${JSON.stringify(workspace)}.`,
    );
  }
}

async function workspaceIdentity(workspace: string): Promise<string> {
  const entries: string[] = [];
  const inspect = async (relative: string): Promise<void> => {
    const target = resolve(workspace, relative);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`Workspace path ${JSON.stringify(relative)} became a symlink.`);
    }
    entries.push(
      `${relative}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
    );
    if (stat.isDirectory()) {
      for (const name of (await readdir(target)).toSorted()) {
        await inspect(relative ? `${relative}/${name}` : name);
      }
    }
  };
  await inspect("");
  return digestClawValue(entries);
}

async function commitConfig(
  transform: Parameters<ConfigCommit>[0],
  options: StatelessClawAddOptions,
): Promise<void> {
  if (options.commitConfig) {
    await options.prepareEffect?.();
    options.assertCurrent?.();
    await options.commitConfig(transform);
    return;
  }
  await transformConfigFileWithRetry({
    afterWrite: { mode: "auto" },
    writeOptions: copyRuntimeConfigWriteApplication(options.configWriteOptions, {
      assertCurrent: options.assertCurrent,
      beforeCommit: async () => {
        await options.configWriteOptions?.beforeCommit?.();
        await options.prepareEffect?.();
      },
    }),
    transform: (config, context) => ({
      nextConfig: transform(config, context.snapshot.runtimeConfig),
    }),
  });
}

export async function applyClawAddPlanStateless(
  plan: ClawAddPlan,
  options: StatelessClawAddOptions = {},
): Promise<StatelessClawAddResult> {
  const staged = await stageClawAddHostRequirementsStateless(plan, options);
  return staged.kind === "partial" ? staged.result : await staged.continue();
}

/** Stage host plugins before the Gateway activates its runtime batch. */
export async function stageClawAddHostRequirementsStateless(
  plan: ClawAddPlan,
  initialOptions: StatelessClawAddOptions = {},
): Promise<StatelessClawAddStage> {
  if (plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
    throw new ClawAddMutationError("plan_blocked", "The Claw add plan contains blockers.");
  }
  if (initialOptions.consentPlanIntegrity !== plan.planIntegrity) {
    throw new ClawAddMutationError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw add plan.",
    );
  }
  let options = initialOptions;
  const workspace = resolve(resolveUserPath(plan.agent.workspace));
  let workspaceCreated = false;
  let workspaceExposed = false;
  let workspaceBeforeExposure: string | undefined;
  let configCommitted = false;
  let configCommitAttempted = false;
  let workspaceFiles: PersistedClawWorkspaceFile[] = [];
  let packages: PersistedClawPackageRef[] = [];
  let mcpServers: PersistedClawMcpServerRef[] = [];
  let cronJobs: PersistedClawCronRef[] = [];
  let continued = false;
  const result = (
    status: StatelessClawAddResult["status"],
    error?: StatelessClawAddResult["error"],
  ): StatelessClawAddResult => ({
    schemaVersion: CLAW_ADD_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    mutationAllowed: true,
    planIntegrity: plan.planIntegrity,
    status,
    claw: plan.claw,
    agent: plan.agent,
    workspaceCreated,
    configCommitted,
    workspaceFiles,
    packages,
    mcpServers,
    cronJobs,
    ...(error ? { error } : {}),
  });
  const assertForwardCurrent = (phase?: "after-agent-commit") => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
    if (options.getCurrentConfig && options.assertReviewedConfig) {
      options.assertReviewedConfig(options.getCurrentConfig(), phase);
    }
    options.assertCurrent?.();
  };
  const stageOptions = (phase?: "after-agent-commit") => ({
    ...options,
    assertForwardCurrent: () => assertForwardCurrent(phase),
  });
  const rollback = async (): Promise<string[]> => {
    const errors: string[] = [];
    if (configCommitted && workspaceExposed) {
      try {
        if (
          !workspaceBeforeExposure ||
          (await workspaceIdentity(workspace)) !== workspaceBeforeExposure
        ) {
          throw new Error("Workspace changed after the agent became available; left it in place.");
        }
      } catch (error) {
        errors.push(`agent cleanup skipped: ${coerceErrorMessage(error)}`);
        return errors;
      }
    }
    if (configCommitted) {
      try {
        if (options.rollbackNewAgent) {
          await options.prepareEffect?.();
          options.assertCurrent?.();
          await options.rollbackNewAgent(plan, cronJobs);
        } else {
          for (const ref of cronJobs.toReversed()) {
            if (!ref.schedulerJobId || !options.cronGateway?.get || !options.cronGateway.remove) {
              throw new Error("Gateway automation rollback is unavailable");
            }
            const live = await options.cronGateway.get(ref.schedulerJobId);
            if (!clawCronGatewayJobMatchesRef(plan.agent.finalId, ref, live)) {
              throw new Error(
                "Agent automations changed during Claw Add; rollback left it intact.",
              );
            }
            const revision = clawCronGatewayJobConfigRevision(live);
            if (!revision) {
              throw new Error(`Automation ${ref.schedulerJobId} has no rollback revision`);
            }
            await options.prepareEffect?.();
            options.assertCurrent?.();
            await options.cronGateway.remove(ref.schedulerJobId, {
              commitGuard: options.assertCurrent,
              expectedConfigRevision: revision,
            });
          }
          await commitConfig((config) => {
            const existing = listAgentEntries(config).find(
              (entry) => normalizeAgentId(entry.id) === normalizeAgentId(plan.agent.finalId),
            );
            if (!existing || !sameCommittedAgent(existing, plan)) {
              throw new Error("The new agent changed after Add; automatic rollback stopped.");
            }
            return pruneAgentConfig(config, plan.agent.finalId).config;
          }, options);
        }
        configCommitted = false;
      } catch (error) {
        errors.push(`agent cleanup failed: ${coerceErrorMessage(error)}`);
      }
    }
    if (workspaceCreated && !configCommitted) {
      try {
        options.assertCurrent?.();
        assertWorkspacePathUnchanged(workspace);
        if (
          workspaceExposed &&
          (!workspaceBeforeExposure ||
            (await workspaceIdentity(workspace)) !== workspaceBeforeExposure)
        ) {
          throw new Error("Workspace changed after the agent became available; left it in place.");
        }
        await options.prepareEffect?.();
        options.assertCurrent?.();
        await rm(workspace, { recursive: true, force: false });
        workspaceCreated = false;
      } catch (error) {
        errors.push(`workspace cleanup failed: ${coerceErrorMessage(error)}`);
      }
    }
    return errors;
  };
  const fail = async (error: unknown, code: string): Promise<StatelessClawAddResult> => {
    const cleanupErrors = await rollback();
    if (!workspaceExposed && !configCommitted) {
      cleanupErrors.push(
        ...(await rollbackStatelessClawMcpServers(mcpServers, options)),
        ...(await rollbackStatelessClawPackages(packages, options)),
      );
    }
    const message = coerceErrorMessage(error);
    const sharedRetained =
      packages.some(
        (pkg) =>
          pkg.kind === "plugin" && pkg.origin === "claw-introduced" && pkg.status !== "rolled_back",
      ) || mcpServers.some((server) => server.origin === "claw-introduced");
    const retainedMessage = sharedRetained
      ? " Shared plugins or MCP servers already added were kept; remove them separately if unused."
      : "";
    return result("partial", {
      code: cleanupErrors.length > 0 ? "add_rollback_incomplete" : code,
      message:
        (cleanupErrors.length > 0 ? `${message} ${cleanupErrors.join("; ")}.` : message) +
        retainedMessage,
    });
  };
  try {
    assertForwardCurrent();
    const hostPlan = planWithPackageActions(plan, (action) => action.details?.kind === "plugin");
    if (hostPlan.actions.some((action) => action.kind === "package")) {
      packages = await installClawPackages(hostPlan, stageOptions());
    }
  } catch (error) {
    if (error instanceof ClawPackageInstallError) {
      packages = error.installedPackages;
    }
    return { kind: "partial", result: await fail(error, "package_install_failed") };
  }
  const stageAgent = async (agentOptions = options): Promise<StatelessClawAddAgentStage> => {
    if (continued) {
      throw new Error("Claw Add was already continued");
    }
    continued = true;
    options = agentOptions;
    try {
      assertForwardCurrent();
      assertWorkspacePathUnchanged(workspace);
      const existing = await lstat(workspace).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (existing) {
        throw new ClawAddMutationError(
          "workspace_collision",
          `Workspace ${JSON.stringify(workspace)} was created after planning.`,
        );
      }
      await options.prepareEffect?.();
      assertForwardCurrent();
      await mkdir(dirname(workspace), { recursive: true });
      await options.prepareEffect?.();
      assertForwardCurrent();
      assertWorkspacePathUnchanged(workspace);
      await mkdir(workspace);
      workspaceCreated = true;
      await seedClawPackageBootstrap(plan, stageOptions());
      workspaceFiles = await createClawWorkspaceFiles(plan, stageOptions());
      const workspacePlan = planWithPackageActions(
        plan,
        (action) => action.details?.kind !== "plugin",
      );
      if (workspacePlan.actions.some((action) => action.kind === "package")) {
        packages = [...packages, ...(await installClawPackages(workspacePlan, stageOptions()))];
      }
      mcpServers = await installClawMcpServersStateless(plan, stageOptions());
      workspaceBeforeExposure = await workspaceIdentity(workspace);
      const deletion = await readAgentDeletionJournalAsync(plan.agent.finalId);
      if (deletion && !deletion.cleanupCompleted) {
        throw new ClawAddMutationError(
          "agent_deletion_pending",
          `Agent ${JSON.stringify(plan.agent.finalId)} deletion cleanup is still pending.`,
        );
      }
      configCommitAttempted = true;
      await commitConfig((config, runtimeConfig) => {
        options.assertCurrent?.();
        options.assertForwardCurrent?.();
        options.assertReviewedConfig?.(applyConfigOverrides(runtimeConfig ?? config));
        if (
          listAgentEntries(config).some(
            (entry) => normalizeAgentId(entry.id) === normalizeAgentId(plan.agent.finalId),
          )
        ) {
          throw new ClawAddMutationError(
            "agent_id_collision",
            `Agent ${JSON.stringify(plan.agent.finalId)} was created after planning.`,
          );
        }
        return addClawAgentToConfig(config, plan, workspace);
      }, options);
      configCommitted = true;
      workspaceExposed = true;
      if (deletion?.cleanupCompleted) {
        await options.prepareEffect?.();
        assertForwardCurrent("after-agent-commit");
        if (!(await claimCompletedAgentDeletion(plan.agent.finalId, deletion.operationId))) {
          throw new ClawAddMutationError(
            "agent_deletion_changed",
            `Agent ${JSON.stringify(plan.agent.finalId)} deletion changed during Add.`,
          );
        }
      }
      let finished = false;
      const finishOnce = (nextOptions: StatelessClawAddOptions) => {
        if (finished) {
          throw new Error("Claw Add was already finished");
        }
        finished = true;
        options = nextOptions;
      };
      return {
        kind: "ready",
        finish: async (nextOptions = options) => {
          finishOnce(nextOptions);
          try {
            assertForwardCurrent("after-agent-commit");
            cronJobs = await installClawCronJobsStateless(plan, {
              ...stageOptions("after-agent-commit"),
              gateway: options.cronGateway,
            });
            return result("complete");
          } catch (error) {
            if (error instanceof ClawCronInstallError) {
              cronJobs = error.cronJobs;
              if (error.code === "cron_scratch_import_incomplete") {
                // A scratch conflict or lost write acknowledgement may contain user edits.
                return result("partial", {
                  code: error.code,
                  message: `${error.message} The new agent and its automations were kept. Inspect their scratch and enabled state before retrying.`,
                });
              }
            }
            return await fail(
              error,
              error instanceof ClawAddMutationError ? error.code : "add_failed",
            );
          }
        },
        fail: async (error, code, nextOptions = options) => {
          finishOnce(nextOptions);
          return await fail(error, code);
        },
      };
    } catch (error) {
      if (configCommitAttempted && !configCommitted) {
        try {
          const current = options.commitConfig
            ? options.getCurrentConfig?.()
            : (await readConfigFileSnapshotForWrite({ observe: false })).snapshot.sourceConfig;
          if (!current) {
            throw new Error("Current config is unavailable", { cause: error });
          }
          const agent = listAgentEntries(current).find(
            (entry) => normalizeAgentId(entry.id) === normalizeAgentId(plan.agent.finalId),
          );
          if (agent) {
            if (!sameCommittedAgent(agent, plan)) {
              throw new Error("Agent config changed during Add", { cause: error });
            }
            configCommitted = true;
            workspaceExposed = true;
          }
        } catch (reconcileError) {
          return {
            kind: "partial",
            result: result("partial", {
              code: "config_commit_uncertain",
              message: `${coerceErrorMessage(error)} Could not verify whether the new agent was committed: ${coerceErrorMessage(reconcileError)}. Workspace retained for inspection.`,
            }),
          };
        }
      }
      if (error instanceof ClawPackageInstallError) {
        packages = [...packages, ...error.installedPackages];
      }
      if (error instanceof ClawMcpInstallError) {
        mcpServers = error.mcpServers;
      }
      return {
        kind: "partial",
        result: await fail(
          error,
          error instanceof ClawAddMutationError ? error.code : "add_failed",
        ),
      };
    }
  };
  return {
    kind: "ready",
    stageAgent,
    continue: async (nextOptions = options) => {
      const staged = await stageAgent(nextOptions);
      return staged.kind === "partial" ? staged.result : await staged.finish();
    },
    failBeforeContinue: async (error, code) => {
      if (continued) {
        throw new Error("Claw Add was already continued");
      }
      continued = true;
      return await fail(error, code);
    },
  };
}
