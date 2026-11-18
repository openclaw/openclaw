import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../../../agents/agent-scope.js";
import type { AuthProfileAuthorization } from "../../../agents/auth-profiles/authorization-contract.js";
import { captureAuthProfileAuthorization } from "../../../agents/auth-profiles/authorization.js";
import { loadAuthProfileStoreForRuntimeAsync } from "../../../agents/auth-profiles/store-runtime.js";
import { resolveProviderModelAuthPolicy } from "../../../agents/model-auth-policy.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { captureRuntimeConfig } from "../../../config/runtime-source-projection.js";
import { resolveSessionModelOverrideSource } from "../../../config/sessions/model-override-provenance.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../../../cron/agent-id.js";
import { resolveCronModelSelection } from "../../../cron/isolated-agent/model-selection.js";
import { resolveCronPreflightCandidates } from "../../../cron/isolated-agent/run-fallback-policy.js";
import { normalizeCronJobCreate } from "../../../cron/normalize.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { PluginDoctorCronJob } from "../../../plugins/doctor-contract-module.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { prepareCronInferenceDiagnosticSession } from "./inference-session.js";
import { inspectCronJobsForDoctor, repairCronInferenceBindingsForDoctor } from "./store-repair.js";

export async function maybeRepairCronInferenceBindings(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const changes: Array<{
    job: PluginDoctorCronJob;
    definition: Record<string, unknown>;
    paused: boolean;
  }> = [];
  const descriptions: string[] = [];
  const retained: AuthProfileAuthorization[] = [];
  try {
    const inventory = await inspectCronJobsForDoctor({ env });
    const pending = inventory.jobs.filter(
      ({ definition }) =>
        definition &&
        (Object.hasOwn(definition, "inferenceBinding") ||
          Object.hasOwn(definition, "ownerTransferPending")),
    );
    if (pending.length === 0) {
      return { changes: [], warnings: [] };
    }
    const labelFor = ({ definition, id }: PluginDoctorCronJob) =>
      `${typeof definition?.name === "string" ? definition.name : id} (${id})`;
    if (!params.shouldRepair) {
      return {
        changes: [],
        warnings: pending.map(
          (job) =>
            `Automation ${labelFor(job)}: run openclaw doctor --fix to move the saved account to the model selection.`,
        ),
      };
    }
    const maintenance = getOpenClawDatabaseMaintenanceScope();
    if (!maintenance?.ownsSchemaMaintenance) {
      throw new Error("Automation account migration requires offline Doctor maintenance.");
    }
    const cfg = captureRuntimeConfig(params.cfg);
    for (const stored of pending) {
      const { inferenceBinding: binding, ownerTransferPending, ...definition } = stored.definition!;
      const label = labelFor(stored);
      let authorization: AuthProfileAuthorization | undefined;
      try {
        if (ownerTransferPending !== undefined) {
          throw new Error("its owner changed and the new owner needs to choose the account");
        }
        if (
          !isRecord(binding) ||
          binding.version !== 1 ||
          typeof binding.provider !== "string" ||
          typeof binding.profileId !== "string" ||
          typeof binding.authorizationId !== "string" ||
          (binding.runtime !== undefined &&
            (typeof binding.runtime !== "string" || !binding.runtime.trim())) ||
          (binding.authRequirement !== "api-key" && binding.authRequirement !== "subscription")
        ) {
          throw new Error("its saved account is incomplete");
        }
        const input = normalizeCronJobCreate(definition);
        const job = input && { ...input, id: stored.id, createdAtMs: 0, updatedAtMs: 0, state: {} };
        if (
          job?.payload.kind !== "agentTurn" ||
          job.sessionTarget === "main" ||
          definition.pluginCommand !== undefined
        ) {
          throw new Error("this job does not support an explicit model selection");
        }
        const agentId = tryResolveCronJobEffectiveAgentId(job, tryResolveAmbientOwnerAgentId(cfg));
        if (!agentId) {
          throw new Error("its execution agent could not be determined");
        }
        const session = await prepareCronInferenceDiagnosticSession({
          cfg,
          agentId,
          job: { ...job, id: stored.id },
          runtimePinned: Boolean(binding.runtime),
        });
        if (session.initialSessionEntry?.modelSelectionLocked) {
          throw new Error("its session owns the model selection");
        }
        const selected = await resolveCronModelSelection({
          cfg,
          agentId,
          agentDir: resolveAgentDir(cfg, agentId),
          workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
          agentConfigOverride: resolveAgentConfig(cfg, agentId),
          sessionEntry: session.sessionEntry,
          payloadModel: job.payload.model,
          isGmailHook: job.payload.externalContentSource === "gmail",
        });
        if (!selected.ok || selected.provider !== binding.provider) {
          throw new Error("the current model no longer matches the saved account’s provider");
        }
        if (
          selected.configuredProfileId &&
          selected.modelSource === "payload" &&
          selected.configuredProfileId !== binding.profileId
        ) {
          throw new Error("the existing model and saved account name different accounts");
        }
        const model = `${selected.provider}/${selected.model}@${binding.profileId}`;
        if (splitTrailingAuthProfile(model).profile !== binding.profileId) {
          throw new Error("the saved account cannot be represented as a model suffix");
        }
        const payload = {
          ...job.payload,
          model,
          ...(binding.runtime ? { modelRuntime: binding.runtime } : {}),
        };
        const preflight = {
          cfg: selected.owner.config,
          agentId,
          provider: selected.provider,
          model: selected.model,
        };
        const before = resolveCronPreflightCandidates({
          ...preflight,
          job,
          useSubagentFallbacks: selected.useSubagentFallbacks,
          inheritDefaultFallbacksForAgentStringModel:
            selected.inheritDefaultFallbacksForAgentStringModel,
          sessionModelOverrideSource:
            selected.modelSource === "session"
              ? (resolveSessionModelOverrideSource(session.sessionEntry) ?? undefined)
              : undefined,
        });
        const after = resolveCronPreflightCandidates({ ...preflight, job: { ...job, payload } });
        if (!isDeepStrictEqual(before, after)) {
          payload.fallbacks = before
            .slice(1)
            .map((candidate) => candidate.provider + "/" + candidate.model);
          const pinned = resolveCronPreflightCandidates({ ...preflight, job: { ...job, payload } });
          if (!isDeepStrictEqual(before, pinned)) {
            throw new Error("its fallback models cannot be preserved");
          }
        }
        const store = await loadAuthProfileStoreForRuntimeAsync(selected.owner.agentDir, {
          profileId: binding.profileId,
          readOnly: true,
          allowKeychainPrompt: false,
        });
        const credential = store.profiles[binding.profileId];
        if (
          !credential ||
          resolveProviderModelAuthPolicy({
            provider: binding.provider,
            mode: credential.type,
            authFlow: credential.type === "oauth" ? credential.authFlow : undefined,
          }).authRequirement !== binding.authRequirement
        ) {
          throw new Error("its saved account is missing or no longer uses the same billing route");
        }
        authorization = await captureAuthProfileAuthorization({
          profileId: binding.profileId,
          cfg: selected.owner.config,
          agentDir: selected.owner.agentDir,
          assertCurrent() {},
        });
        if (authorization.authorizationId !== binding.authorizationId) {
          throw new Error("its saved sign-in was replaced or revoked");
        }
        authorization.assertCurrent();
        retained.push(authorization);
        authorization = undefined;
        changes.push({
          job: stored,
          definition: {
            ...definition,
            payload: {
              ...(definition.payload as Record<string, unknown>),
              model,
              ...(payload.modelRuntime ? { modelRuntime: payload.modelRuntime } : {}),
              ...(payload.fallbacks !== job.payload.fallbacks
                ? { fallbacks: payload.fallbacks }
                : {}),
            },
          },
          paused: false,
        });
        descriptions.push(
          `Automation ${label}: pinned ${model}${binding.runtime ? ` on ${binding.runtime}` : ""}.`,
        );
      } catch (error) {
        changes.push({ job: stored, definition: { ...definition, enabled: false }, paused: true });
        descriptions.push(
          `Automation ${label}: paused because ${formatErrorMessage(error)}. Review its model and account before enabling it.`,
        );
      } finally {
        authorization?.dispose();
      }
    }
    const assertCurrent = () => {
      maintenance.assertDatabaseAccess(resolveOpenClawStateSqlitePath(env));
      for (const authority of retained) {
        authority.assertCurrent();
      }
    };
    const result = await repairCronInferenceBindingsForDoctor(
      { env },
      {
        assertCurrent,
        assertOwnedInTransaction: assertCurrent,
      },
      inventory,
      changes,
    );
    return {
      changes: [...descriptions, `Saved pre-repair cron backup: ${result.backupPath}`],
      warnings: result.warnings ?? [],
    };
  } catch (error) {
    return {
      changes: [],
      warnings: [`Automation account migration was not committed: ${formatErrorMessage(error)}`],
    };
  } finally {
    for (const authority of retained) {
      authority.dispose();
    }
  }
}
