import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../../../agents/agent-scope.js";
import type { AuthProfileAuthorization } from "../../../agents/auth-profiles/authorization-contract.js";
import { captureAuthProfileAuthorization } from "../../../agents/auth-profiles/authorization.js";
import {
  isStoredCredentialCompatibleWithAuthProvider,
  resolveAuthProfileOrderWithMetadata,
} from "../../../agents/auth-profiles/order.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../../../agents/auth-profiles/store-runtime.js";
import { resolveProviderModelAuthPolicy } from "../../../agents/model-auth-policy.js";
import {
  hasSyntheticLocalProviderAuthConfig,
  resolveProviderEntryApiKeyProfileReference,
} from "../../../agents/model-auth-provider-config.js";
import {
  isCliRuntimeProvider,
  resolveCliRuntimeExecutionProvider,
} from "../../../agents/model-runtime-aliases.js";
import { resolveModelRuntimePolicy } from "../../../agents/model-runtime-policy.js";
import { isConfiguredKeyAuthSource } from "../../../agents/provider-model-auth-source-plan.js";
import { prepareAgentRuntimeAuth } from "../../../agents/runtime-plan/prepare-auth.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../../agents/session-runtime-compat.js";
import { quoteCliArg } from "../../../cli/quote-cli-arg.js";
import { resolveMergedModelProviderConfig } from "../../../config/model-provider-config.js";
import { captureRuntimeConfig } from "../../../config/runtime-source-projection.js";
import { resolveSessionAuthProfileOverrideSource } from "../../../config/sessions/auth-profile-override-provenance.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../../../cron/agent-id.js";
import type { CronInferenceBinding } from "../../../cron/inference-binding.js";
import { resolveCronModelSelection } from "../../../cron/isolated-agent/model-selection.js";
import { resolveCronAgentSessionKey } from "../../../cron/isolated-agent/session-key.js";
import { prepareCronSession } from "../../../cron/isolated-agent/session.js";
import { normalizeCronJobCreate } from "../../../cron/normalize.js";
import {
  isDetachedCronSessionTarget,
  isInvalidCronSessionTargetIdError,
  resolveCronSessionTargetSessionKey,
} from "../../../cron/session-target.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import type { PluginDoctorCronJob } from "../../../plugins/doctor-contract-module.js";
import { resolveProviderAuthProfileId } from "../../../plugins/provider-runtime.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { isUserModelAuthProfileId } from "../../../state/user-model-account-id.js";
import { inspectCronJobsForDoctor, repairCronInferenceBindingsForDoctor } from "./store-repair.js";

/** Adopt a current, unambiguous account once; never reinterpret run telemetry as authority. */
export async function maybeRepairCronInferenceBindings(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const warnings: string[] = [];
  const retained: AuthProfileAuthorization[] = [];
  const changes: Array<{ job: PluginDoctorCronJob; binding: CronInferenceBinding }> = [];
  const descriptions: string[] = [];
  const capturedConfigs = new Map<OpenClawConfig, OpenClawConfig>();
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
    for (const stored of inventory.jobs) {
      const definition = stored.definition;
      if (
        !definition ||
        stored.invalidReason ||
        definition.inferenceBinding !== undefined ||
        definition.runtimeAuthority !== undefined ||
        definition.runtimeAuthorityRecoveryRequired
      ) {
        continue;
      }
      let modelRef: string | undefined;
      const label = `${normalizeOptionalString(definition.name) ?? stored.id} (${stored.id})`;
      try {
        // Malformed legacy rows must not abandon adoption for unrelated jobs or partitions.
        // Normalize only resolver input; the committed definition retains every authored field.
        const job = normalizeCronJobCreate(definition);
        if (!job || job.payload.kind !== "agentTurn" || job.sessionTarget === "main") {
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
        // Resolve legacy ownership before capturing; matching provider loads share this generation.
        // Account selection and authorization still use each job's own agent and session.
        const config = captureConfig(params.cfg);
        const baseKey =
          resolveCronSessionTargetSessionKey(job.sessionTarget) ?? `cron:${stored.id}`;
        const sessionKey = resolveCronAgentSessionKey({
          cfg: config,
          agentId,
          sessionKey: baseKey,
        });
        const sourceSessionKey =
          job.sessionTarget === "current" && job.sessionKey
            ? resolveCronAgentSessionKey({ cfg: config, agentId, sessionKey: job.sessionKey })
            : undefined;
        const session = await prepareCronSession({
          cfg: config,
          agentId,
          sessionKey,
          sourceSessionKey,
          forceNew: isDetachedCronSessionTarget(job.sessionTarget),
          exactRunSession: true,
          nowMs: Date.now(),
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
        if (
          isCliRuntimeProvider(selected.provider, { config: cfg }) ||
          resolveCliRuntimeExecutionProvider({
            cfg,
            agentId,
            provider: selected.provider,
            modelId: selected.model,
          })
        ) {
          continue;
        }
        const runtime =
          resolveSessionRuntimeOverrideForProvider({
            cfg,
            provider: selected.provider,
            entry: session.sessionEntry,
          }) ??
          resolveModelRuntimePolicy({
            config: cfg,
            agentId,
            provider: selected.provider,
            modelId: selected.model,
          }).policy?.id;
        if (runtime && runtime !== "openclaw" && runtime !== "auto") {
          warnings.push(
            `Automation ${label}: runtime ${runtime} inference ownership was left unchanged; no host account was adopted. Use that runtime's account/recovery flow if this job needs adoption.`,
          );
          continue;
        }
        const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(
          selected.owner.agentDir,
        );
        const sessionPin = resolveSessionAuthProfileOverrideSource(session.sessionEntry);
        const sessionProfileId = session.sessionEntry.authProfileOverride;
        const sessionCredential = sessionProfileId ? store.profiles[sessionProfileId] : undefined;
        const compatibleSessionPin =
          !sessionCredential ||
          isStoredCredentialCompatibleWithAuthProvider({
            cfg,
            provider: selected.provider,
            credential: sessionCredential,
          });
        let explicitProfileId =
          selected.configuredProfileId ??
          ((sessionPin === "user" || sessionPin === "user-link") && compatibleSessionPin
            ? sessionProfileId
            : undefined);
        const explicitUserSelection = Boolean(explicitProfileId);
        const currentAuth = prepareAgentRuntimeAuth({
          config: cfg,
          provider: selected.provider,
          modelId: selected.model,
          agentId,
          agentDir: selected.owner.agentDir,
          workspaceDir: selected.owner.workspaceDir,
          // A rate-limit cooldown only defers the usual account; recording around it would make
          // a temporary fallback permanent. Disabled and blocked accounts stay excluded.
          authProfileStore: {
            ...store,
            usageStats: Object.fromEntries(
              Object.entries(store.usageStats ?? {}).map(
                ([
                  profileId,
                  {
                    cooldownUntil: _until,
                    cooldownReason: _reason,
                    cooldownModel: _model,
                    ...stats
                  },
                ]) => [profileId, stats],
              ),
            ),
          },
          sessionAuthProfileId: explicitProfileId,
          sessionAuthProfileSource: explicitProfileId ? "user" : undefined,
          ...(explicitProfileId
            ? { requiredAuthProfileId: explicitProfileId, allowAuthProfileFallback: false }
            : {}),
          // Same hook as a run, so the first attempt is the account an unbound run used.
          resolveProviderPreferredProfileId: (context) =>
            resolveProviderAuthProfileId({
              provider: selected.provider,
              config: cfg,
              workspaceDir: selected.owner.workspaceDir,
              env,
              context,
            }),
        });
        // Synthetic, env and provider-config routes have no stored account to record; the
        // runtime keeps such a job on that key and refuses it once a stored account is eligible.
        const firstSource = currentAuth.attempts[0]?.plan.credentialSource;
        if (isConfiguredKeyAuthSource(firstSource)) {
          continue;
        }
        if (firstSource?.kind === "direct") {
          throw new Error(
            "The current route uses an ambient credential, not a durable stored account.",
          );
        }
        if (!explicitProfileId) {
          const providerPin = resolveProviderEntryApiKeyProfileReference({
            cfg,
            provider: selected.provider,
            store,
          });
          const firstAttempt = currentAuth.attempts[0];
          if (
            providerPin.kind === "profile" &&
            firstAttempt?.kind === "profile" &&
            firstAttempt.profileId === providerPin.profileId
          ) {
            explicitProfileId = providerPin.profileId;
          }
        }
        const order = explicitProfileId
          ? [explicitProfileId]
          : resolveAuthProfileOrderWithMetadata({
              cfg,
              store,
              provider: selected.provider,
              forModel: selected.model,
              readinessMode: "read-only",
              includePendingOAuthRefresh: true,
            }).profileIds;
        const candidates: Array<{
          profileId: string;
          authRequirement: CronInferenceBinding["authRequirement"];
        }> = [];
        for (const profileId of order) {
          try {
            const prepared = prepareAgentRuntimeAuth({
              config: cfg,
              provider: selected.provider,
              modelId: selected.model,
              agentId,
              agentDir: selected.owner.agentDir,
              workspaceDir: selected.owner.workspaceDir,
              authProfileStore: store,
              requiredAuthProfileId: profileId,
              allowAuthProfileFallback: false,
            });
            const [attempt] = prepared.attempts;
            const credential = store.profiles[profileId];
            const authRequirement =
              attempt?.plan.modelRoute?.authRequirement ??
              (credential &&
                resolveProviderModelAuthPolicy({
                  provider: selected.provider,
                  mode: credential.type,
                  authFlow: credential.type === "oauth" ? credential.authFlow : undefined,
                }).authRequirement);
            if (attempt?.kind === "profile" && attempt.profileId === profileId && authRequirement) {
              candidates.push({ profileId, authRequirement });
            }
          } catch (error) {
            if (explicitProfileId) {
              throw error;
            }
          }
        }
        if (candidates.length === 0 && !explicitProfileId) {
          const prepared = prepareAgentRuntimeAuth({
            config: cfg,
            provider: selected.provider,
            modelId: selected.model,
            agentId,
            agentDir: selected.owner.agentDir,
            authProfileStore: store,
          });
          if (
            prepared.attempts.every(
              ({ plan }) =>
                plan.credentialSource?.kind === "direct" &&
                plan.credentialSource.evidence === "synthetic",
            ) ||
            hasSyntheticLocalProviderAuthConfig({
              cfg,
              provider: selected.provider,
              route: resolveMergedModelProviderConfig(cfg, selected.provider),
            })
          ) {
            continue;
          }
        }
        // Several eligible accounts: record the one a run would take now. With auth.order that is the
        // account every earlier run used; without it, runs rotated by last use. The log names the others.
        const plannedProfileId =
          currentAuth.attempts[0]?.kind === "profile"
            ? currentAuth.attempts[0].profileId
            : undefined;
        const candidate =
          candidates.length === 1
            ? candidates[0]
            : explicitProfileId
              ? undefined
              : candidates.find((c) => c.profileId === plannedProfileId);
        if (!candidate) {
          throw new Error(
            candidates.length > 1
              ? `More than one inference account is eligible: ${candidates.map((c) => c.profileId).join(", ")}.`
              : "No available stored inference account can be retained.",
          );
        }
        const alternatives = candidates
          .filter((c) => c.profileId !== candidate.profileId)
          .map((c) => c.profileId);
        if (isUserModelAuthProfileId(candidate.profileId)) {
          throw new Error(
            "A personal inference account requires explicit adoption by its authorized owner.",
          );
        }
        const description = `Automation ${label}: retain ${candidate.profileId} for ${modelRef}; model/default/fallback selections stay unchanged.${alternatives.length > 0 ? ` Also eligible: ${alternatives.join(", ")}; to change, run openclaw automations edit ${quoteCliArg(stored.id)} --model ${quoteCliArg(`${modelRef}@<profileId>`)}.` : ""}`;
        if (!params.shouldRepair) {
          warnings.push(
            `${description} Run openclaw doctor --fix to record its inference account.`,
          );
          continue;
        }
        const authority = await captureAuthProfileAuthorization({
          profileId: candidate.profileId,
          agentDir: selected.owner.agentDir,
          cfg,
          // The credential owner captures and revalidates the Doctor maintenance scope.
          assertCurrent() {},
        });
        retained.push(authority);
        authority.assertCurrent();
        changes.push({
          job: stored,
          binding: {
            version: 1,
            provider: selected.provider,
            profileId: candidate.profileId,
            authorizationId: authority.authorizationId,
            authRequirement: candidate.authRequirement,
            source: explicitUserSelection
              ? "user"
              : (currentAuth.plan.forwardedAuthProfileSource ?? "auto"),
          },
        });
        descriptions.push(description);
      } catch (error) {
        const recovery = isInvalidCronSessionTargetIdError(error)
          ? `Repair its session target with openclaw automations edit ${quoteCliArg(stored.id)} --session <target>, then retry Doctor.`
          : `Explicitly adopt the intended stored account with openclaw automations edit ${quoteCliArg(stored.id)} --model ${quoteCliArg(`${modelRef ?? "<provider/model>"}@<profileId>`)}.`;
        warnings.push(
          `Automation ${label}: inference account was not migrated: ${formatErrorMessage(error)} ${recovery}`,
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
      changes: [...descriptions, `Saved pre-repair cron backup: ${result.backupPath}`],
      warnings,
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
