import type { CronModelImpactIssue } from "../../packages/gateway-protocol/src/schema/cron-model-impact.js";
import {
  cliBackendAcceptsAuthProfileForwarding,
  selectCliExecutionAuthProfile,
} from "../agents/cli-execution-auth.js";
import { resolveAgentHarnessAvailabilityDecision } from "../agents/harness/availability.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import { createModelAuthAvailabilityResolver } from "../agents/model-auth-availability.js";
import { resolveModelCatalogAuthRef } from "../agents/model-catalog-auth-ref.js";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import { createModelCatalogSnapshotView } from "../agents/model-catalog-view.js";
import { resolveCliRuntimeExecutionProvider } from "../agents/model-runtime-aliases.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { isCliProvider } from "../agents/model-selection-cli.js";
import { getModelRefStatus } from "../agents/model-selection-resolve.js";
import { resolveConfiguredModelPolicyAllow } from "../agents/model-selection-shared.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import {
  resolveCronInferenceCandidateMismatch,
  resolveCronRuntimeSessionEntry,
} from "./inference-binding.js";
import type { CronModelImpactOwner } from "./model-impact.js";
import type { CronStoredJob } from "./types.js";

const accountRecovery =
  "Select a model and runtime compatible with the recorded account, or deliberately select an authorized account with openclaw automations edit <jobId> --model <provider/model>@<profileId>. Doctor leaves existing bindings unchanged.";

/** Inspect prepared observations; never acquire credential material, enroll authorization, or discover inventory. */
export function assessCronModelCompatibility(params: {
  cfg: OpenClawConfig;
  owner: CronModelImpactOwner;
  job: CronStoredJob;
  provider: string;
  model: string;
  sessionEntry?: Partial<SessionEntry>;
  configuredProfileId?: string;
}): CronModelImpactIssue[] {
  return withPluginRuntimeGenerationScope(params.owner, () => {
    const { cfg, owner, job, provider, model } = params;
    const issues: CronModelImpactIssue[] = [];
    const block = (code: string, message: string, recovery = accountRecovery) =>
      issues.push({ code, severity: "blocker", message, recovery });
    const unknown = (code: string, message: string) =>
      issues.push({ code, severity: "warning", message });
    const policy = getModelRefStatus({
      cfg,
      agentId: owner.agentId,
      catalog: owner.modelCatalog.entries,
      defaultProvider: provider,
      defaultModel: { provider, model },
      ref: { provider, model },
      manifestPlugins: owner.metadataSnapshot,
    });
    if (!policy.allowed) {
      block(
        "model-selection-rejected",
        "The effective automation model is outside " +
          (resolveConfiguredModelPolicyAllow({ cfg, agentId: owner.agentId }).configPath ??
            "the agent's model policy") +
          ".",
        "Inspect the execution agent's modelPolicy.allow and choose an allowed model. Preview does not widen policy.",
      );
    }
    const binding = job.inferenceBinding;
    if (binding && resolveCronInferenceCandidateMismatch(binding, { provider }) === "provider") {
      block(
        "recorded-provider-incompatible",
        "The proposed model uses a different provider from this automation's recorded inference account.",
      );
      return issues;
    }
    if (job.runtimeAuthority || job.runtimeAuthorityRecoveryRequired) {
      unknown(
        "execution-path-not-assessed",
        "This automation has runtime-owned authority. Its native account and app compatibility must be checked by that runtime at execution.",
      );
      return issues;
    }
    const selectedProfileId = binding?.profileId ?? params.configuredProfileId;
    if (
      selectedProfileId &&
      isUserModelAuthProfileId(selectedProfileId) &&
      !owner.authStore.profiles[selectedProfileId]
    ) {
      unknown(
        "personal-account-observation-unavailable",
        "The recorded personal account is not part of the shared prepared model metadata. Its owner must inspect that account; this is not evidence of sign-out.",
      );
      return issues;
    }
    const evaluate = () => {
      const runtimeEntry = resolveCronRuntimeSessionEntry(binding, params.sessionEntry ?? {});
      const cli = (id: string) => isCliProvider(id, cfg, owner.metadataSnapshot);
      const configuredRuntime = resolveModelRuntimePolicy({
        config: cfg,
        agentId: owner.agentId,
        provider,
        modelId: model,
      }).policy?.id;
      const orderedProfileId =
        owner.authStore.order?.[provider]?.[0] ?? cfg.auth?.order?.[provider]?.[0];
      const routingProfileId = selectedProfileId ?? orderedProfileId;
      const candidates = [
        provider,
        runtimeEntry.agentRuntimeOverride,
        configuredRuntime,
        routingProfileId
          ? (owner.authStore.profiles[routingProfileId]?.provider ??
            cfg.auth?.profiles?.[routingProfileId]?.provider)
          : undefined,
      ];
      // The execution alias owner can infer a CLI from a sole configured profile. Keep that
      // read on prepared registrations too, rather than allowing setup-module fallback.
      if (
        !runtimeEntry.agentRuntimeOverride &&
        !routingProfileId &&
        (!configuredRuntime || configuredRuntime === "auto")
      ) {
        const authAlias = { config: cfg, metadataSnapshot: owner.metadataSnapshot };
        const authProvider = resolveProviderIdForAuth(provider, authAlias);
        for (const profile of Object.values(cfg.auth?.profiles ?? {})) {
          if (
            resolveProviderIdForAuth(profile.provider, { ...authAlias, storedCredential: true }) ===
            authProvider
          ) {
            candidates.push(profile.provider);
          }
        }
      }
      const loadedCli = new Set(owner.pluginRegistry?.cliBackends.map(({ backend }) => backend.id));
      if (
        candidates.some((candidate) => candidate && cli(candidate) && !loadedCli.has(candidate))
      ) {
        unknown(
          "runtime-support-unknown",
          "The selected CLI runtime has no loaded prepared backend metadata. Preview does not load setup plugins.",
        );
        return;
      }
      const runtimeOverride = resolveSessionRuntimeOverrideForProvider({
        provider,
        cfg,
        entry: runtimeEntry,
      });
      const executionProvider = runtimeOverride
        ? cli(runtimeOverride)
          ? runtimeOverride
          : provider
        : (resolveCliRuntimeExecutionProvider({
            cfg,
            agentId: owner.agentId,
            provider,
            modelId: model,
            authProfileId: binding?.profileId ?? params.configuredProfileId,
            preparedAuthStore: owner.authStore,
            metadataSnapshot: owner.metadataSnapshot,
          }) ?? provider);
      if (!binding && cli(executionProvider)) {
        unknown(
          "execution-path-not-assessed",
          "This unbound automation uses the CLI runtime's own login, not a stored host account. Native account/model readiness is not established by this host-account preview.",
        );
        return;
      }
      const view = createModelCatalogSnapshotView(cfg, owner.modelCatalog);
      const entry = findModelInCatalog(view.logicalEntries, provider, model);
      const authRef = resolveModelCatalogAuthRef(
        entry ?? { provider, id: model },
        entry ? view.variantsOf(entry) : [],
      );
      const resolver = createModelAuthAvailabilityResolver({
        cfg,
        agentId: owner.agentId,
        agentDir: owner.agentDir,
        workspaceDir: owner.workspaceDir,
        authStore: owner.authStore,
        preparedRuntimeAuthStore: owner.authStore,
        preparedRuntimeAuthModes: owner.authModes,
        preparedRuntimeAuthMaterializations: owner.authMaterializations,
        preparedCliRuntimeAuthDirectories: { agentDir: owner.agentDir },
        metadataSnapshot: owner.metadataSnapshot,
        // No external CLI discovery. Existing runtime observations are the only native-login evidence.
        externalCliProviderIds: [],
        accountListedModelIds: (requestedProvider, profileId) => {
          const observations = owner.modelCatalog.providerOutcomes?.filter(
            (outcome) =>
              outcome.status === "ready" &&
              outcome.provider === requestedProvider &&
              outcome.profileId === profileId &&
              outcome.listedModelIds !== undefined,
          );
          return observations?.length
            ? new Set(observations.flatMap((outcome) => outcome.listedModelIds ?? []))
            : undefined;
        },
      });
      const evaluation = resolver.evaluateRuntimeModelAuth(provider, {
        ...authRef,
        ...(runtimeOverride ? { runtimeId: runtimeOverride } : {}),
        ...(binding
          ? { requiredProfileId: binding.profileId }
          : params.configuredProfileId
            ? { pinnedProfileId: params.configuredProfileId }
            : {}),
      });
      const route = evaluation.selectedRoute;
      const harness = resolveAgentHarnessAvailabilityDecision({
        config: cfg,
        agentId: owner.agentId,
        provider,
        modelId: model,
        mode: "projection",
        agentHarnessRuntimeOverride: runtimeOverride,
        preparedModelProvider: true,
        modelProvider: {
          api: route?.api ?? entry?.api,
          baseUrl: route?.baseUrl ?? entry?.baseUrl,
          runtimePolicy: route?.runtimePolicy,
          requestTransportOverrides: route?.requestTransportOverrides,
          preparedAuth: evaluation.selectedCredential,
        },
      });
      const runtime = harness.policy.runtime;
      if (harness.support && !harness.support.supported && runtime !== "openclaw") {
        block(
          "recorded-runtime-incompatible",
          "The selected runtime cannot reproduce the model's prepared request route.",
        );
      } else if (
        runtime !== "openclaw" &&
        runtime !== "auto" &&
        !cli(runtime) &&
        !getRegisteredAgentHarness(runtime)
      ) {
        unknown(
          "runtime-support-unknown",
          "The selected runtime has no loaded support metadata for this preview.",
        );
      }
      if (
        binding &&
        runtime !== "auto" &&
        resolveCronInferenceCandidateMismatch(binding, { provider, runtime }) === "runtime"
      ) {
        block(
          "recorded-runtime-incompatible",
          "The selected model cannot run on the runtime recorded for this automation's account.",
        );
      }
      if (binding && cli(executionProvider)) {
        if (
          !cliBackendAcceptsAuthProfileForwarding({
            provider: executionProvider,
            config: cfg,
            agentId: owner.agentId,
          })
        ) {
          block(
            "cli-account-forwarding-incompatible",
            "The selected CLI runtime cannot forward this automation's recorded account.",
          );
        } else {
          try {
            const selected = selectCliExecutionAuthProfile({
              cliExecutionProvider: executionProvider,
              authProfileProvider: provider,
              config: cfg,
              store: owner.authStore,
              readinessMode: "read-only",
              selected: { authProfileId: binding.profileId, authProfileIdSource: "user" },
              metadataSnapshot: owner.metadataSnapshot,
            });
            if (selected?.profileId !== binding.profileId) {
              block(
                "cli-account-forwarding-incompatible",
                "The selected CLI runtime cannot use this automation's exact recorded account.",
              );
            }
          } catch {
            block(
              "cli-account-forwarding-incompatible",
              "The selected CLI runtime cannot use this automation's recorded account.",
            );
          }
        }
      }
      if (
        evaluation.routeResolution?.kind === "incompatible" ||
        (binding &&
          evaluation.selectedCredential?.source !== "harness" &&
          evaluation.selectedCredential?.requirement &&
          evaluation.selectedCredential.requirement !== binding.authRequirement)
      ) {
        block(
          "recorded-route-incompatible",
          "The selected model's authentication route is incompatible with the recorded account route.",
        );
      } else if (evaluation.availability === false) {
        block(
          "recorded-account-unavailable",
          "Prepared metadata reports no usable authentication for the selected model and account route.",
          binding
            ? accountRecovery
            : "Inspect the selected agent's model authentication and restore or explicitly select the intended account.",
        );
      } else if (evaluation.availability === undefined) {
        unknown(
          "runtime-support-unknown",
          "Prepared metadata cannot establish authentication and route compatibility for this model.",
        );
      }
      if (!binding && evaluation.selectedProfileId && !evaluation.runtimeAuth) {
        block(
          "recorded-account-unavailable",
          "This automation has no recorded inference account, but prepared selection would use a stored account.",
          job.payload.kind === "systemEvent"
            ? "Inspect this scheduled system event from its owning conversation, or recreate it as an owner-authorized agent-turn automation with the intended account. A model/profile edit applies only to agent-turn jobs. Do not automatically replay expired occurrences."
            : "Run openclaw doctor to inspect adoption guidance, or deliberately select an authorized account with openclaw automations edit <jobId> --model <provider/model>@<profileId>. Preview does not adopt accounts.",
        );
      }
    };
    evaluate();
    return issues;
  });
}
