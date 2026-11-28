import { existsSync } from "node:fs";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../../../agents/agent-scope.js";
import {
  type AuthProfileAuthorization,
  AuthProfileAuthorizationError,
} from "../../../agents/auth-profiles/authorization-contract.js";
import { captureAuthProfileAuthorization } from "../../../agents/auth-profiles/authorization.js";
import { resolveAuthProfileDatabasePath } from "../../../agents/auth-profiles/sqlite.js";
import { quoteCliArg } from "../../../cli/quote-cli-arg.js";
import { resolveStateDir } from "../../../config/paths.js";
import { captureRuntimeConfig } from "../../../config/runtime-source-projection.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { prepareSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../../../cron/agent-id.js";
import {
  normalizeCronInferenceBinding,
  type CronInferenceBinding,
} from "../../../cron/inference-binding.js";
import { prepareCronInferenceDiagnosticSession } from "../../../cron/inference-diagnostics.js";
import { resolveCronModelSelection } from "../../../cron/isolated-agent/model-selection.js";
import { normalizeCronJobCreate } from "../../../cron/normalize.js";
import { isInvalidCronSessionTargetIdError } from "../../../cron/session-target.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { prepareArtifactPreservingSqliteRead } from "../../../infra/sqlite-snapshot-source.js";
import type { PluginDoctorCronJob } from "../../../plugins/doctor-contract-module.js";
import { prepareProviderModelPolicySurfaces } from "../../../plugins/provider-model-routes.js";
import { isArtifactPreservingStateRead } from "../../../state/artifact-preserving-state-reads.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { readAppliedUpgradeShadowRoots } from "../../../state/state-upgrade-receipts.js";
import { isUserModelAuthProfileId } from "../../../state/user-model-account-id.js";
import { inspectCronJobsForDoctor, repairCronInferenceBindingsForDoctor } from "./store-repair.js";

/** Restore a recorded account's authorization after a state upgrade; unbound jobs select live. */
export async function maybeRepairCronInferenceBindings(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const warnings: string[] = [];
  const retained: AuthProfileAuthorization[] = [];
  const changes: Array<{
    job: PluginDoctorCronJob;
    binding: CronInferenceBinding;
    previousAuthorizationId?: string;
  }> = [];
  const descriptions: string[] = [];
  const capturedConfigs = new Map<OpenClawConfig, OpenClawConfig>();
  const inspectedAgents = new Set<string>();
  const captureConfig = (config: OpenClawConfig): OpenClawConfig => {
    let captured = capturedConfigs.get(config);
    if (!captured) {
      captured = captureRuntimeConfig(config);
      capturedConfigs.set(config, captured);
    }
    return captured;
  };
  try {
    const maintenance = getOpenClawDatabaseMaintenanceScope();
    if (params.shouldRepair && !maintenance?.ownsSchemaMaintenance) {
      throw new Error("Inference account migration requires offline Doctor maintenance.");
    }
    const inventory = await inspectCronJobsForDoctor({ env });
    await prepareProviderModelPolicySurfaces();
    let shadowRoots: string[] | undefined;
    for (const stored of inventory.jobs) {
      const definition = stored.definition;
      if (
        !definition ||
        stored.invalidReason ||
        (definition.inferenceBinding !== undefined && !params.shouldRepair) ||
        definition.runtimeAuthority !== undefined ||
        definition.runtimeAuthorityRecoveryRequired
      ) {
        continue;
      }
      let verifyingSavedAccount = false;
      let modelRef: string | undefined;
      let listAccountsCommand = "openclaw models auth list";
      const label = `${normalizeOptionalString(definition.name) ?? stored.id} (${stored.id})`;
      try {
        // Malformed legacy rows must not abandon adoption for unrelated jobs or partitions.
        // Normalize only resolver input; the committed definition retains every authored field.
        const job = normalizeCronJobCreate(definition);
        if (!job || job.payload.kind !== "agentTurn" || job.sessionTarget === "main") {
          continue;
        }
        const previous = normalizeCronInferenceBinding(definition.inferenceBinding);
        // An unbound job selects its account live, like an interactive turn; only a recorded
        // account can need its authorization restored after a state upgrade.
        if (!previous || isUserModelAuthProfileId(previous.profileId)) {
          continue;
        }
        modelRef = job.payload.model;
        const agentId = tryResolveCronJobEffectiveAgentId(
          job,
          tryResolveAmbientOwnerAgentId(params.cfg),
        );
        if (!agentId || !resolveAgentConfig(params.cfg, agentId)) {
          throw new Error("Select the job's execution agent before adopting an inference account.");
        }
        listAccountsCommand += ` --agent ${quoteCliArg(agentId)}`;
        // Resolve legacy ownership before capturing; matching provider loads share this generation.
        // Account selection and authorization still use each job's own agent and session.
        const config = captureConfig(params.cfg);
        // The inspection owner retains one image for sessions, auth and catalogs across jobs.
        if (isArtifactPreservingStateRead("agent") && !inspectedAgents.has(agentId)) {
          const sessionTarget = await prepareSqliteTargetFromSessionStorePath(
            resolveSessionStorePathCore(config.session?.store, { agentId, env }),
            { agentId, env },
          );
          for (const agentPath of new Set([
            resolveAuthProfileDatabasePath(resolveAgentDir(config, agentId, env)),
            sessionTarget.path,
          ])) {
            if (existsSync(agentPath)) {
              await prepareArtifactPreservingSqliteRead(agentPath);
            }
          }
          inspectedAgents.add(agentId);
        }
        const session = await prepareCronInferenceDiagnosticSession({
          cfg: config,
          agentId,
          job: { ...job, id: stored.id },
        });
        if (session.initialSessionEntry?.modelSelectionLocked === true) {
          warnings.push(
            `Automation ${label}: its session is owned by a native runtime; no host inference account was adopted. Recover ownership through that runtime before changing this job.`,
          );
          continue;
        }
        const selected = await resolveCronModelSelection({
          cfg: config,
          agentId,
          agentDir: resolveAgentDir(config, agentId),
          workspaceDir: resolveAgentWorkspaceDir(config, agentId),
          agentConfigOverride: resolveAgentConfig(config, agentId),
          sessionEntry: session.sessionEntry,
          payloadModel: job.payload.model,
          isGmailHook: job.payload.externalContentSource === "gmail",
        });
        if (!selected.ok) {
          throw new Error(selected.error);
        }
        modelRef = `${selected.provider}/${selected.model}`;
        const cfg = captureConfig(selected.owner.config);
        shadowRoots ??= readAppliedUpgradeShadowRoots(resolveStateDir(env));
        // With no receipt, the owner can confirm the current binding but cannot repair a mismatch.
        verifyingSavedAccount = true;
        const authority = await captureAuthProfileAuthorization({
          cfg,
          agentDir: selected.owner.agentDir,
          profileId: previous.profileId,
          upgradeRecovery: { recordedId: previous.authorizationId, shadowRoots },
          assertCurrent() {},
        });
        if (authority.authorizationId === previous.authorizationId) {
          authority.dispose();
          continue;
        }
        retained.push(authority);
        changes.push({
          job: stored,
          binding: { ...previous, authorizationId: authority.authorizationId },
          previousAuthorizationId: previous.authorizationId,
        });
        descriptions.push(
          `Automation ${label}: restored its existing ${previous.profileId} account after the state upgrade; schedule and run history unchanged.`,
        );
      } catch (error) {
        const recovery = isInvalidCronSessionTargetIdError(error)
          ? `Repair its session target with openclaw automations edit ${quoteCliArg(stored.id)} --session <target>, then retry Doctor.`
          : `Inspect available accounts with ${listAccountsCommand}, then explicitly adopt the intended stored account with openclaw automations edit ${quoteCliArg(stored.id)} --model ${quoteCliArg(`${modelRef ?? "<provider/model>"}@<profileId>`)}.`;
        const reason =
          verifyingSavedAccount &&
          error instanceof AuthProfileAuthorizationError &&
          error.code === "MCP_AUTHORIZATION_RETIRED"
            ? "The saved account no longer matches and no usable upgrade receipt proves it is the same account. The job was left unchanged."
            : formatErrorMessage(error);
        warnings.push(
          `Automation ${label}: inference account was not migrated: ${reason} ${recovery}`,
        );
      }
    }
    if (changes.length === 0) {
      return { changes: [], warnings };
    }
    if (!maintenance?.ownsSchemaMaintenance) {
      throw new Error("Inference account migration requires offline Doctor maintenance.");
    }
    const assertCurrent = () => {
      maintenance.assertDatabaseAccess(resolveOpenClawStateSqlitePath(env));
      for (const authority of retained) {
        authority.assertCurrent();
      }
    };
    const result = await repairCronInferenceBindingsForDoctor(
      { env },
      { assertCurrent, assertOwnedInTransaction: assertCurrent },
      inventory,
      changes,
    );
    return {
      changes: [
        ...descriptions,
        ...(result.backupPath ? [`Saved pre-repair cron backup: ${result.backupPath}`] : []),
      ],
      warnings: [...warnings, ...(result.warnings ?? [])],
    };
  } catch (error) {
    return {
      changes: [],
      warnings: [
        ...warnings,
        `Cron inference account migration was not committed: ${formatErrorMessage(error)}`,
      ],
    };
  } finally {
    for (const authority of retained) {
      authority.dispose();
    }
  }
}
