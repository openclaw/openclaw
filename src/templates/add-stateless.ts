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
import { addTemplateAgentToConfig } from "./add-agent-config.js";
import { TemplateAddMutationError } from "./add-mutation-error.js";
import { planWithPackageActions, sameCommittedAgent } from "./add-plan-helpers.js";
import { TEMPLATE_ADD_RESULT_SCHEMA_VERSION } from "./add.js";
import { seedTemplatePackageBootstrap } from "./bootstrap.js";
import {
  TemplateCronInstallError,
  templateCronGatewayJobConfigRevision,
  templateCronGatewayJobMatchesRef,
  installTemplateCronJobsStateless,
  type TemplateCronGateway,
  type PersistedTemplateCronRef,
} from "./cron.js";
import { digestTemplateValue } from "./digest.js";
import {
  installTemplateMcpServersStateless,
  rollbackStatelessTemplateMcpServers,
  type PersistedTemplateMcpServerRef,
} from "./mcp.js";
import {
  TemplatePackageInstallError,
  installTemplatePackages,
  rollbackStatelessTemplatePackages,
  type TemplatePluginInstallConsent,
  type TemplateSkillInstallConsent,
} from "./packages.js";
import type { TemplatePluginRuntimeOptions } from "./plugin-runtime.js";
import type { PersistedTemplatePackageRef } from "./provenance.js";
import type { TemplateMutationStateOptions } from "./state-mutation-options.js";
import { TEMPLATE_OUTPUT_STABILITY, type TemplateAddPlan } from "./types.js";
import { createTemplateWorkspaceFiles, type PersistedTemplateWorkspaceFile } from "./workspace.js";

type ConfigCommit = (
  transform: (config: OpenClawConfig, runtimeConfig?: OpenClawConfig) => OpenClawConfig,
) => Promise<void>;

export type StatelessTemplateAddOptions = TemplateMutationStateOptions & {
  assertForwardCurrent?: () => void;
  assertReviewedConfig?: (config: OpenClawConfig, phase?: "after-agent-commit") => void;
  getCurrentConfig?: () => OpenClawConfig;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  consentPlanIntegrity?: string;
  pluginConsent?: TemplatePluginInstallConsent;
  skillConsent?: TemplateSkillInstallConsent;
  reloadPlugins?: PluginInstallBatchReload;
  runtimeBatch?: TemplatePluginRuntimeOptions["runtimeBatch"];
  cronGateway?: Pick<
    TemplateCronGateway,
    "add" | "list" | "waitUntilAgentAvailable" | "writeScratch" | "enable"
  > &
    Partial<Pick<TemplateCronGateway, "get" | "remove">>;
  commitConfig?: ConfigCommit;
  configWriteOptions?: ConfigWriteOptions;
  rollbackNewAgent?: (plan: TemplateAddPlan, cronJobs: PersistedTemplateCronRef[]) => Promise<void>;
};

export type StatelessTemplateAddResult = {
  schemaVersion: typeof TEMPLATE_ADD_RESULT_SCHEMA_VERSION;
  stability: typeof TEMPLATE_OUTPUT_STABILITY;
  dryRun: false;
  mutationAllowed: true;
  planIntegrity: string;
  status: "complete" | "partial";
  template: TemplateAddPlan["template"];
  agent: TemplateAddPlan["agent"];
  workspaceCreated: boolean;
  configCommitted: boolean;
  workspaceFiles: PersistedTemplateWorkspaceFile[];
  packages: PersistedTemplatePackageRef[];
  mcpServers: PersistedTemplateMcpServerRef[];
  cronJobs: PersistedTemplateCronRef[];
  error?: { code: string; message: string };
};

export type StatelessTemplateAddStage =
  | { kind: "partial"; result: StatelessTemplateAddResult }
  | {
      kind: "ready";
      continue: (options?: StatelessTemplateAddOptions) => Promise<StatelessTemplateAddResult>;
      stageAgent: (
        options?: StatelessTemplateAddOptions,
      ) => Promise<StatelessTemplateAddAgentStage>;
      failBeforeContinue: (error: unknown, code: string) => Promise<StatelessTemplateAddResult>;
    };

type StatelessTemplateAddAgentStage =
  | { kind: "partial"; result: StatelessTemplateAddResult }
  | {
      kind: "ready";
      finish: (options?: StatelessTemplateAddOptions) => Promise<StatelessTemplateAddResult>;
      fail: (
        error: unknown,
        code: string,
        options?: StatelessTemplateAddOptions,
      ) => Promise<StatelessTemplateAddResult>;
    };

function assertWorkspacePathUnchanged(workspace: string): void {
  const current = resolvePathViaExistingAncestorSync(workspace);
  const normalize = (path: string) =>
    process.platform === "win32" ? normalizeWindowsPathForComparison(path) : path;
  if (normalize(current) !== normalize(workspace)) {
    throw new TemplateAddMutationError(
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
  return digestTemplateValue(entries);
}

async function commitConfig(
  transform: Parameters<ConfigCommit>[0],
  options: StatelessTemplateAddOptions,
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

export async function applyTemplateAddPlanStateless(
  plan: TemplateAddPlan,
  options: StatelessTemplateAddOptions = {},
): Promise<StatelessTemplateAddResult> {
  const staged = await stageTemplateAddHostRequirementsStateless(plan, options);
  return staged.kind === "partial" ? staged.result : await staged.continue();
}

/** Stage host plugins before the Gateway activates its runtime batch. */
export async function stageTemplateAddHostRequirementsStateless(
  plan: TemplateAddPlan,
  initialOptions: StatelessTemplateAddOptions = {},
): Promise<StatelessTemplateAddStage> {
  if (plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
    throw new TemplateAddMutationError("plan_blocked", "The Template add plan contains blockers.");
  }
  if (initialOptions.consentPlanIntegrity !== plan.planIntegrity) {
    throw new TemplateAddMutationError(
      "plan_integrity_mismatch",
      "Consent does not match the current Template add plan.",
    );
  }
  let options = initialOptions;
  const workspace = resolve(resolveUserPath(plan.agent.workspace));
  let workspaceCreated = false;
  let workspaceExposed = false;
  let workspaceBeforeExposure: string | undefined;
  let configCommitted = false;
  let configCommitAttempted = false;
  let workspaceFiles: PersistedTemplateWorkspaceFile[] = [];
  let packages: PersistedTemplatePackageRef[] = [];
  const mcpServers: PersistedTemplateMcpServerRef[] = [];
  let cronJobs: PersistedTemplateCronRef[] = [];
  let continued = false;
  const result = (
    status: StatelessTemplateAddResult["status"],
    error?: StatelessTemplateAddResult["error"],
  ): StatelessTemplateAddResult => ({
    schemaVersion: TEMPLATE_ADD_RESULT_SCHEMA_VERSION,
    stability: TEMPLATE_OUTPUT_STABILITY,
    dryRun: false,
    mutationAllowed: true,
    planIntegrity: plan.planIntegrity,
    status,
    template: plan.template,
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
            if (!templateCronGatewayJobMatchesRef(plan.agent.finalId, ref, live)) {
              throw new Error(
                "Agent automations changed during Template Add; rollback left it intact.",
              );
            }
            const revision = templateCronGatewayJobConfigRevision(live);
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
  const fail = async (error: unknown, code: string): Promise<StatelessTemplateAddResult> => {
    const cleanupErrors = await rollback();
    if (!workspaceExposed && !configCommitted) {
      cleanupErrors.push(
        ...(await rollbackStatelessTemplateMcpServers(mcpServers, options)),
        ...(await rollbackStatelessTemplatePackages(packages, options)),
      );
    }
    const message = coerceErrorMessage(error);
    const sharedRetained =
      packages.some(
        (pkg) =>
          pkg.kind === "plugin" &&
          pkg.origin === "template-introduced" &&
          pkg.status !== "rolled_back",
      ) || mcpServers.some((server) => server.origin === "template-introduced");
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
      packages = await installTemplatePackages(hostPlan, stageOptions());
    }
  } catch (error) {
    if (error instanceof TemplatePackageInstallError) {
      packages = error.installedPackages;
    }
    return { kind: "partial", result: await fail(error, "package_install_failed") };
  }
  const stageAgent = async (agentOptions = options): Promise<StatelessTemplateAddAgentStage> => {
    if (continued) {
      throw new Error("Template Add was already continued");
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
        throw new TemplateAddMutationError(
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
      await seedTemplatePackageBootstrap(plan, stageOptions());
      workspaceFiles = await createTemplateWorkspaceFiles(plan, stageOptions());
      const workspacePlan = planWithPackageActions(
        plan,
        (action) => action.details?.kind !== "plugin",
      );
      if (workspacePlan.actions.some((action) => action.kind === "package")) {
        packages = [...packages, ...(await installTemplatePackages(workspacePlan, stageOptions()))];
      }
      await installTemplateMcpServersStateless(plan, { ...stageOptions(), refs: mcpServers });
      workspaceBeforeExposure = await workspaceIdentity(workspace);
      const deletion = await readAgentDeletionJournalAsync(plan.agent.finalId);
      if (deletion && !deletion.cleanupCompleted) {
        throw new TemplateAddMutationError(
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
          throw new TemplateAddMutationError(
            "agent_id_collision",
            `Agent ${JSON.stringify(plan.agent.finalId)} was created after planning.`,
          );
        }
        return addTemplateAgentToConfig(config, plan, workspace);
      }, options);
      configCommitted = true;
      workspaceExposed = true;
      if (deletion?.cleanupCompleted) {
        await options.prepareEffect?.();
        assertForwardCurrent("after-agent-commit");
        if (!(await claimCompletedAgentDeletion(plan.agent.finalId, deletion.operationId))) {
          throw new TemplateAddMutationError(
            "agent_deletion_changed",
            `Agent ${JSON.stringify(plan.agent.finalId)} deletion changed during Add.`,
          );
        }
      }
      let finished = false;
      const finishOnce = (nextOptions: StatelessTemplateAddOptions) => {
        if (finished) {
          throw new Error("Template Add was already finished");
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
            cronJobs = await installTemplateCronJobsStateless(plan, {
              ...stageOptions("after-agent-commit"),
              gateway: options.cronGateway,
            });
            return result("complete");
          } catch (error) {
            if (error instanceof TemplateCronInstallError) {
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
              error instanceof TemplateAddMutationError ? error.code : "add_failed",
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
      if (error instanceof TemplatePackageInstallError) {
        packages = [...packages, ...error.installedPackages];
      }
      return {
        kind: "partial",
        result: await fail(
          error,
          error instanceof TemplateAddMutationError ? error.code : "add_failed",
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
        throw new Error("Template Add was already continued");
      }
      continued = true;
      return await fail(error, code);
    },
  };
}
