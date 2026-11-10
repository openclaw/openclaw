import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { claimCompletedAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { listAgentEntries } from "../agents/agent-scope.js";
import { deferWorkspaceBootstrap } from "../agents/workspace-preparation.js";
import { pruneAgentConfig } from "../commands/agents.config.js";
import { readConfigFileSnapshotForWrite, transformConfigFileWithRetry } from "../config/config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import { copyRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { hasErrnoCode } from "../infra/errno.js";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type {
  TemplateInstallEvent,
  TemplateInstallOutcome,
} from "../shared/template-install-notice.js";
import { readAgentDeletionJournalAsync } from "../state/agent-deletion-journal.js";
import { resolveUserPath } from "../utils.js";
import { addTemplateAgentToConfig } from "./add-agent-config.js";
import {
  configuredPlanDigest,
  configuredSourceIntegrity,
  workspaceIdentity,
} from "./add-checkpoint.js";
import { TemplateAddMutationError } from "./add-mutation-error.js";
import { sameCommittedAgent } from "./add-plan-helpers.js";
import { rollbackWorkspaceBootstrapSeedForAdd } from "./add-state-write.js";
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

type TemplateConfiguredAgentCheckpoint = {
  config: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
  workspaceIdentity: string;
  /** Plan content normalized across verified source extraction roots. */
  planDigest: string;
  /** Manifest, profile, bootstrap and declared workspace source bytes. */
  sourceIntegrity: string;
};

export type StatelessTemplateAddOptions = TemplateMutationStateOptions & {
  /** Exact in-flight ordinary admission, not permission to merge an existing agent. */
  admittedAgent?: {
    config: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>[string];
    workspaceIdentity: string;
    phase?: "admitted" | "configured";
    planDigest?: string;
    sourceIntegrity?: string;
    assertCurrent: () => Promise<void>;
  };
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
  cronGateway?: Pick<TemplateCronGateway, "add" | "list" | "writeScratch" | "enable"> &
    Partial<Pick<TemplateCronGateway, "get" | "remove">>;
  commitConfig?: ConfigCommit;
  /** Save ordinary session state before publishing its new agent; returns exact owned cleanup. */
  prepareAgentSession?: (config: OpenClawConfig) => Promise<() => Promise<void>>;
  /** Persist verified configuration before runtime wait. Uncertain acknowledgement retains custody. */
  onAgentConfigured?: (checkpoint: TemplateConfiguredAgentCheckpoint) => Promise<void>;
  /** Confirm active runtime publication before transferring rollback custody. */
  waitForAgentRuntime?: (retainedAgent?: {
    agentId: string;
    config: TemplateConfiguredAgentCheckpoint["config"];
  }) => Promise<"applied" | "applied-restart-required">;
  /** Instructions, canonical chat, and active runtime are ready; setup continues here. */
  onAgentReady?: (agent: { agentId: string; sessionKey: string }) => Promise<void>;
  /** Publish each actual installation outcome without a model recap. */
  onSetupEvent?: (event: TemplateInstallEvent) => Promise<void>;
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
  agentRetained?: true;
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
  if (plan.blockers.length > 0 || plan.actions.some((action) => action.blocked)) {
    throw new TemplateAddMutationError("plan_blocked", "The Template add plan contains blockers.");
  }
  if (options.consentPlanIntegrity !== plan.planIntegrity) {
    throw new TemplateAddMutationError(
      "plan_integrity_mismatch",
      "Consent does not match the current Template add plan.",
    );
  }
  const workspace = resolve(resolveUserPath(plan.agent.workspace));
  const configuredRetry = options.admittedAgent?.phase === "configured";
  const checkpointPlanDigest = configuredPlanDigest(plan);
  let configuredCheckpoint: TemplateConfiguredAgentCheckpoint | undefined;
  let initialSourceIntegrity: string | undefined;
  let releaseBootstrapDeferral: (() => Promise<void>) | undefined;
  let workspaceCreated = false;
  let workspaceExposed = false;
  let workspaceBeforeExposure: string | undefined;
  let configCommitted = false;
  let retained = options.admittedAgent !== undefined;
  let rollbackAgentSession: (() => Promise<void>) | undefined;
  let configCommitAttempted = false;
  let workspaceFiles: PersistedTemplateWorkspaceFile[] = [];
  let rollbackWorkspaceFiles: (() => Promise<void>) | undefined;
  let bootstrapSeededAt: string | undefined;
  let packages: PersistedTemplatePackageRef[] = [];
  const mcpServers: PersistedTemplateMcpServerRef[] = [];
  let cronJobs: PersistedTemplateCronRef[] = [];
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
    ...(retained ? { agentRetained: true as const } : {}),
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
  const currentAgentConfig = async () => {
    const config = options.getCurrentConfig
      ? options.getCurrentConfig()
      : (await readConfigFileSnapshotForWrite({ observe: false })).snapshot.sourceConfig;
    const agent = config.agents?.entries?.[plan.agent.finalId];
    const entry = listAgentEntries(config).find((candidate) => candidate.id === plan.agent.finalId);
    if (!agent || !entry || !sameCommittedAgent(entry, plan)) {
      throw new Error("The configured agent changed before Template initialization");
    }
    return agent;
  };
  const assertConfigured = async (checkpoint: TemplateConfiguredAgentCheckpoint) => {
    await options.admittedAgent?.assertCurrent();
    assertForwardCurrent("after-agent-commit");
    assertWorkspacePathUnchanged(workspace);
    if (
      !checkpoint.planDigest ||
      checkpoint.planDigest !== configuredPlanDigest(plan) ||
      !checkpoint.sourceIntegrity ||
      checkpoint.sourceIntegrity !== (await configuredSourceIntegrity(plan)) ||
      checkpoint.workspaceIdentity !== (await workspaceIdentity(workspace)) ||
      !isDeepStrictEqual(checkpoint.config, await currentAgentConfig())
    ) {
      throw new Error("The configured Template plan, source, workspace or agent changed");
    }
    const deletion = await readAgentDeletionJournalAsync(plan.agent.finalId);
    if (deletion && !deletion.cleanupCompleted) {
      throw new TemplateAddMutationError(
        "agent_deletion_pending",
        "The configured agent has pending deletion cleanup.",
      );
    }
    await options.admittedAgent?.assertCurrent();
    assertForwardCurrent("after-agent-commit");
  };
  let assertPluginRequirementsCurrent: (() => Promise<void>) | undefined;
  const stageOptions = (phase?: "after-agent-commit") => ({
    ...options,
    prepareEffect: async () => {
      await options.prepareEffect?.();
      await assertPluginRequirementsCurrent?.();
      assertForwardCurrent(phase);
    },
    onSetupOutcome: async (outcome: TemplateInstallOutcome) => {
      assertForwardCurrent(phase);
      await options.onSetupEvent?.({
        ...outcome,
        agentId: plan.agent.finalId,
        sessionKey: resolveAgentMainSessionKey({
          cfg: options.getCurrentConfig?.() ?? options.config,
          agentId: plan.agent.finalId,
        }),
      });
      assertForwardCurrent(phase);
    },
    onPluginRuntimeReady: (assertCurrent: () => Promise<void>) => {
      assertPluginRequirementsCurrent = assertCurrent;
    },
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
    if (!configCommitted && rollbackAgentSession) {
      try {
        await rollbackAgentSession();
        rollbackAgentSession = undefined;
      } catch (error) {
        errors.push(`session cleanup failed; workspace retained: ` + coerceErrorMessage(error));
        return errors;
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
        if (bootstrapSeededAt) {
          // A retry must not mistake this rolled-back seed for a consumed bootstrap.
          await rollbackWorkspaceBootstrapSeedForAdd(workspace, bootstrapSeededAt, options);
        }
      } catch (error) {
        errors.push(`workspace cleanup failed: ${coerceErrorMessage(error)}`);
      }
    }
    return errors;
  };
  const fail = async (error: unknown, code: string): Promise<StatelessTemplateAddResult> => {
    // Exposure is a one-way custody transfer, not a reason to delete a usable agent.
    // Keep its workspace, chat, requirements and actual routine outcomes on later failure.
    if (retained) {
      if (!configCommitted && rollbackWorkspaceFiles) {
        try {
          await rollbackWorkspaceFiles();
          workspaceFiles = [];
        } catch (cleanupError) {
          return result("partial", {
            code: "add_rollback_incomplete",
            message: `${coerceErrorMessage(error)} Owned instruction cleanup failed: ${coerceErrorMessage(cleanupError)}. The agent and chat were kept.`,
          });
        }
      }
      return result("partial", {
        code,
        message: `${coerceErrorMessage(error)} The agent was already made available and was kept. Continue setup in this agent; do not add another copy.`,
      });
    }
    const cleanupErrors = await rollback();
    if (!workspaceExposed && !configCommitted) {
      cleanupErrors.push(
        ...(await rollbackStatelessTemplateMcpServers(mcpServers, options)),
        ...(await rollbackStatelessTemplatePackages(packages, options)),
      );
    }
    if (!configCommitted && !workspaceCreated) {
      await releaseBootstrapDeferral?.();
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
    assertForwardCurrent(configuredRetry ? "after-agent-commit" : undefined);
    assertWorkspacePathUnchanged(workspace);
    const existing = await lstat(workspace).catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (options.admittedAgent) {
      await options.admittedAgent.assertCurrent();
      if ((await workspaceIdentity(workspace)) !== options.admittedAgent.workspaceIdentity) {
        throw new Error("The admitted workspace changed before Template initialization");
      }
    } else if (existing) {
      throw new TemplateAddMutationError(
        "workspace_collision",
        `Workspace ${JSON.stringify(workspace)} was created after planning.`,
      );
    }
    if (plan.actions.some((action) => action.kind === "bootstrap")) {
      await options.prepareEffect?.();
      assertForwardCurrent();
      releaseBootstrapDeferral = await deferWorkspaceBootstrap(workspace, options);
    }
    if (configuredRetry) {
      const admitted = options.admittedAgent!;
      configuredCheckpoint = {
        config: admitted.config,
        workspaceIdentity: admitted.workspaceIdentity,
        planDigest: admitted.planDigest ?? "",
        sourceIntegrity: admitted.sourceIntegrity ?? "",
      };
      await assertConfigured(configuredCheckpoint);
      configCommitted = true;
    } else {
      if (options.onAgentConfigured) {
        initialSourceIntegrity = await configuredSourceIntegrity(plan);
      }
      await options.prepareEffect?.();
      assertForwardCurrent();
      await mkdir(dirname(workspace), { recursive: true });
      await options.prepareEffect?.();
      assertForwardCurrent();
      assertWorkspacePathUnchanged(workspace);
      if (!options.admittedAgent) {
        await mkdir(workspace);
        workspaceCreated = true;
      }
      const instructions = await createTemplateWorkspaceFiles(plan, stageOptions());
      workspaceFiles = instructions.files;
      rollbackWorkspaceFiles = instructions.rollback;
      workspaceBeforeExposure = await workspaceIdentity(workspace);
      const deletion = await readAgentDeletionJournalAsync(plan.agent.finalId);
      if (deletion && !deletion.cleanupCompleted) {
        throw new TemplateAddMutationError(
          "agent_deletion_pending",
          `Agent ${JSON.stringify(plan.agent.finalId)} deletion cleanup is still pending.`,
        );
      }
      if (deletion?.cleanupCompleted && !options.admittedAgent) {
        await options.prepareEffect?.();
        assertForwardCurrent();
        if (!(await claimCompletedAgentDeletion(plan.agent.finalId, deletion.operationId))) {
          throw new TemplateAddMutationError(
            "agent_deletion_changed",
            `Agent ${JSON.stringify(plan.agent.finalId)} deletion changed during Add.`,
          );
        }
      }
      if (options.prepareAgentSession && !options.admittedAgent) {
        const config = options.getCurrentConfig?.() ?? options.config;
        if (!config) {
          throw new Error("Current config is unavailable for ordinary session preparation");
        }
        rollbackAgentSession = await options.prepareAgentSession(
          addTemplateAgentToConfig(config, plan, workspace),
        );
        assertForwardCurrent();
      }
      configCommitAttempted = true;
      await commitConfig((sourceConfig, runtimeConfig) => {
        let config = sourceConfig;
        options.assertCurrent?.();
        options.assertForwardCurrent?.();
        options.assertReviewedConfig?.(applyConfigOverrides(runtimeConfig ?? config));
        if (options.admittedAgent) {
          const admitted = options.admittedAgent;
          if (!isDeepStrictEqual(config.agents?.entries?.[plan.agent.finalId], admitted.config)) {
            throw new Error("The admitted agent changed before Template initialization");
          }
          const entries = { ...config.agents?.entries };
          delete entries[plan.agent.finalId];
          config = { ...config, agents: { ...config.agents, entries } };
        }
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
    }
  } catch (error) {
    if (
      error instanceof TemplateAddMutationError &&
      error.code === "agent_session_outcome_uncertain"
    ) {
      return result("partial", { code: error.code, message: error.message });
    }
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
        // A refused write leaves the original admitted agent in place. It is
        // not a configured checkpoint, so only this attempt's instructions roll back.
        const admissionUnchanged =
          options.admittedAgent &&
          isDeepStrictEqual(
            current.agents?.entries?.[plan.agent.finalId],
            options.admittedAgent.config,
          );
        if (agent && !admissionUnchanged) {
          if (!sameCommittedAgent(agent, plan)) {
            throw new Error("Agent config changed during Add", { cause: error });
          }
          configCommitted = true;
          workspaceExposed = true;
        }
      } catch (reconcileError) {
        return result("partial", {
          code: "config_commit_uncertain",
          message: `${coerceErrorMessage(error)} Could not verify whether the new agent was committed: ${coerceErrorMessage(reconcileError)}. Workspace retained for inspection.`,
        });
      }
    }
    return await fail(error, error instanceof TemplateAddMutationError ? error.code : "add_failed");
  }
  try {
    if (options.onAgentConfigured && !configuredRetry) {
      await options.prepareEffect?.();
      configuredCheckpoint = {
        config: structuredClone(await currentAgentConfig()),
        workspaceIdentity: workspaceBeforeExposure!,
        planDigest: checkpointPlanDigest,
        sourceIntegrity: initialSourceIntegrity!,
      };
      await assertConfigured(configuredCheckpoint);
      // The canonical pending session now owns this configured incarnation, even
      // if persistence acknowledgement is lost. Only its owner may reconcile it.
      retained = true;
      rollbackAgentSession = undefined;
      await options.onAgentConfigured(configuredCheckpoint);
      await assertConfigured(configuredCheckpoint);
    }
    if (options.waitForAgentRuntime) {
      const outcome = await options.waitForAgentRuntime(
        configuredRetry
          ? { agentId: plan.agent.finalId, config: options.admittedAgent!.config }
          : undefined,
      );
      retained = true;
      rollbackAgentSession = undefined;
      if (outcome === "applied-restart-required") {
        throw new TemplateAddMutationError(
          "agent_runtime_recovery_required",
          "The Gateway published the agent but requires a recovery restart. Wait for Gateway recovery before continuing setup.",
        );
      }
    }
    await options.prepareEffect?.();
    assertForwardCurrent("after-agent-commit");
    if (configuredCheckpoint) {
      await assertConfigured(configuredCheckpoint);
    }
    if (options.onAgentReady) {
      if (
        (!options.prepareAgentSession && !options.admittedAgent) ||
        !options.waitForAgentRuntime
      ) {
        throw new Error("Agent-ready publication requires prepared chat and active runtime");
      }
      await options.onAgentReady({
        agentId: plan.agent.finalId,
        sessionKey: resolveAgentMainSessionKey({
          cfg: options.getCurrentConfig?.() ?? options.config,
          agentId: plan.agent.finalId,
        }),
      });
      assertForwardCurrent("after-agent-commit");
    }
    if (plan.actions.some((action) => action.kind === "package")) {
      packages = await installTemplatePackages(plan, stageOptions("after-agent-commit"));
    }
    await installTemplateMcpServersStateless(plan, {
      ...stageOptions("after-agent-commit"),
      refs: mcpServers,
    });
    cronJobs = await installTemplateCronJobsStateless(plan, {
      ...stageOptions("after-agent-commit"),
      gateway: options.cronGateway,
    });
    const bootstrapNow = Date.now();
    const bootstrap = await seedTemplatePackageBootstrap(plan, {
      ...stageOptions("after-agent-commit"),
      nowMs: bootstrapNow,
    });
    if (bootstrap === "seeded") {
      bootstrapSeededAt = new Date(bootstrapNow).toISOString();
    }
    return result("complete");
  } catch (error) {
    if (error instanceof TemplatePackageInstallError) {
      packages = error.installedPackages;
    }
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
    return await fail(error, error instanceof TemplateAddMutationError ? error.code : "add_failed");
  }
}
