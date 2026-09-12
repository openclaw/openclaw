import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { withSetupCredentialAccess } from "../agents/auth-profiles/setup-access.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import { resolveCliRuntimeCanonicalProvider } from "../agents/cli-backends.js";
import { readCodexCliActiveApiKey } from "../agents/cli-credentials.js";
import {
  ANTHROPIC_API_DEFAULT_MODEL_REF,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CODEX_APP_SERVER_DEFAULT_MODEL_REF,
  GEMINI_CLI_DEFAULT_MODEL_REF,
  OPENAI_API_DEFAULT_MODEL_REF,
} from "../commands/onboard-inference.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { materializeRuntimeConfig } from "../config/materialize.js";
import { applyMergePatch, createMergePatch } from "../config/merge-patch.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { normalizePluginTargetConfig } from "../plugins/config-state.js";
import { enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { stripPendingPluginInstallRecords } from "../plugins/install-record-commit.js";
import { createPluginCache } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../process/gateway-work-admission.js";
import { resolveUserPath } from "../utils.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import { WizardCancelledError, WizardNavigationError } from "../wizard/prompts.js";
import { appendSystemAgentAuditEntry } from "./audit.js";
import {
  projectInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  sameDefaultInferenceRoute,
} from "./inference-route.js";
import { createQuickstartNotePrompter } from "./setup-apply.js";
import {
  type ActivateSetupInferenceParams,
  type StagedCandidate,
  type StageContext,
  type StageFailure,
  type ActivateSetupInferenceResult,
  invalidSetupConfigError,
  parseInferenceRef,
  resolveSetupModel,
  parseProviderAutoSetupChoiceId,
  parseSavedAuthSetupProfileId,
  redactSetupInferenceError,
  resolveSetupInferenceWorkspace,
  SetupInferenceActivationIndeterminateError,
  SetupInferenceActivationUnavailableError,
  SetupInferenceCancelledError,
  SetupInferenceOwnerDriftError,
  throwIfSetupInferenceCancelled,
  validateSetupInferenceOwnerEvidence,
} from "./setup-inference-core.js";
import {
  activateSavedSetupCredential,
  saveSetupCredential,
  stageProviderAuthCandidate,
  stageProviderAutoCandidate,
  stageSavedAuthCandidate,
} from "./setup-inference-credentials.js";
import {
  loadSetupInferencePluginGeneration,
  revalidateStableSetupInferenceOwner,
  runSetupInferenceTurn,
} from "./setup-inference-turn.js";
import { createSystemAgentModelSelectionUpdater } from "./setup-model-selection.js";
import {
  applySetupNativeSessionCatalogPreference,
  listSetupNativeSessionCatalogs,
  requiresSetupNativeSessionCatalogConsent,
  resolveSetupNativeSessionCatalogPreference,
} from "./setup-native-session-catalogs.js";
import { captureSystemAgentOwnerPluginArtifacts } from "./verified-inference.js";

function resolveRouteModelRef(ctx: StageContext, defaultModelRef: string): string | StageFailure {
  return resolveSetupModel({
    label: ctx.params.kind,
    providerId: parseInferenceRef(defaultModelRef).provider,
    defaultModel: defaultModelRef,
    modelRef: ctx.params.modelRef,
  });
}

async function stageCodexCandidate(ctx: StageContext): Promise<StagedCandidate | StageFailure> {
  const modelRef = resolveRouteModelRef(ctx, CODEX_APP_SERVER_DEFAULT_MODEL_REF);
  if (typeof modelRef !== "string") {
    return modelRef;
  }
  return await withPluginLifecycleLease({ signal: ctx.params.signal }, async () => {
    const enabled = await enablePluginWithCapabilityConsent(
      normalizePluginTargetConfig(stripPendingPluginInstallRecords(ctx.cfg), "codex"),
      "codex",
      {
        workspaceDir: ctx.workspace,
        beforePersistentEffect: ctx.beforePersistentEffect,
        onCapabilityConsent: ctx.params.prompter
          ? createPluginCapabilityConsentPrompter(ctx.params.prompter)
          : undefined,
      },
    );
    if (!enabled.enabled) {
      return { error: `Could not enable the Codex runtime plugin: ${enabled.reason}.` };
    }
    const ensureCodex =
      ctx.deps.ensureCodexRuntimePlugin ??
      (await import("../commands/codex-runtime-plugin-install.js"))
        .ensureCodexRuntimePluginForModelSelection;
    const ensured = await ensureCodex({
      cfg: enabled.config,
      model: modelRef,
      agentId: ctx.routeAgentId,
      prompter: ctx.params.prompter ?? createQuickstartNotePrompter(ctx.params.runtime),
      runtime: ctx.params.runtime,
      workspaceDir: ctx.workspace,
      beforePersistentEffect: ctx.beforePersistentEffect,
    });
    if (!ensured.ok) {
      return { error: ensured.message };
    }
    const install = ensured.cfg.plugins?.installs?.codex;
    if (install?.source === "npm" && install.installPath) {
      const markRetained =
        ctx.deps.markRetainedManagedNpmInstall ??
        (await import("../plugins/managed-npm-retention.js")).markRetainedManagedNpmInstall;
      if (
        !(await markRetained({
          packageDir: install.installPath,
          pluginId: "codex",
          reason: "openclaw-inference-activation-not-committed",
        }))
      ) {
        throw new SetupInferenceActivationIndeterminateError(
          "Could not retain the installed Codex package. Restart the Gateway before retrying setup.",
        );
      }
    }
    const config = normalizePluginTargetConfig(ensured.cfg, "codex");
    const entry = config.plugins?.entries?.codex;
    const pluginConfig = entry?.config ?? {};
    const appServer = isRecord(pluginConfig.appServer) ? pluginConfig.appServer : {};
    if (typeof appServer.transport === "string" && appServer.transport !== "stdio") {
      return {
        error:
          "Codex setup needs a local stdio app-server. Finish sign-in on the remote app-server host or remove the transport override before retrying.",
      };
    }
    const credential = (ctx.deps.readCodexCliActiveApiKey ?? readCodexCliActiveApiKey)({
      allowKeychainPrompt: true,
    });
    let authProfileId: string | undefined;
    let authenticatedConfig: OpenClawConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        entries: {
          ...config.plugins?.entries,
          codex: {
            ...entry,
            enabled: true,
            config: {
              ...pluginConfig,
              appServer: {
                ...appServer,
                transport: "stdio",
                homeScope: credential ? "agent" : "user",
              },
            },
          },
        },
      },
    };
    if (credential) {
      registerSecretValueForRedaction(credential.key);
      const saved = await saveSetupCredential({
        profile: { profileId: "openai:codex-cli-api-key", credential },
        config: authenticatedConfig,
        baseConfig: ctx.cfg,
        modelRef,
        pluginId: "codex",
        agentRuntimeId: "codex",
        agentDir: ctx.agentDir,
        beforePersistentEffect: () => ctx.beforePersistentEffect("credential"),
      });
      ctx.credentialsSaved = true;
      authProfileId = saved.profile.profileId;
      authenticatedConfig = saved.config;
    }
    return {
      modelRef,
      agentRuntimeId: "codex",
      ...(authProfileId ? { authProfileId } : {}),
      pendingPluginInstalls: config.plugins?.installs,
      config: authenticatedConfig,
    };
  });
}

async function stageCandidate(ctx: StageContext): Promise<StagedCandidate | StageFailure> {
  const { params, cfg } = ctx;
  if (params.kind.startsWith("saved-auth:")) {
    const profileId = parseSavedAuthSetupProfileId(params.kind);
    if (!profileId) {
      return { error: "Invalid saved sign-in choice. Open Model Setup and choose again." };
    }
    return await stageSavedAuthCandidate(ctx, profileId);
  }
  const choiceId = parseProviderAutoSetupChoiceId(params.kind);
  if (choiceId) {
    return await stageProviderAutoCandidate(ctx, choiceId);
  }
  switch (params.kind) {
    case "existing-model": {
      const route = await resolveSystemAgentConfiguredRouteFromConfig(
        cfg,
        params.agentId,
        {
          loadAuthProfileStoreForRuntime: ctx.deps.loadAuthProfileStoreForRuntime,
        },
        ctx.snapshot,
      );
      if (!route) {
        return { error: "No configured default-agent inference route is available." };
      }
      const requested = params.modelRef?.trim();
      if (requested && normalizeAgentModelRefForConfig(requested) !== route.modelLabel) {
        return {
          error: `The configured default model changed from ${requested} to ${route.modelLabel}. Try setup again.`,
        };
      }
      return {
        modelRef: route.modelLabel,
        config: cfg,
        ...(route.authProfileId ? { authProfileId: route.authProfileId } : {}),
      };
    }
    case "codex-cli":
      return await stageCodexCandidate(ctx);
    case "api-key":
      return await stageProviderAuthCandidate(ctx, false);
    case "provider-auth":
      return await stageProviderAuthCandidate(ctx, true);
    case "claude-cli": {
      const modelRef = resolveRouteModelRef(ctx, CLAUDE_CLI_DEFAULT_MODEL_REF);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      const ref = parseInferenceRef(modelRef);
      const provider =
        resolveCliRuntimeCanonicalProvider({
          runtime: ref.provider,
          config: cfg,
          env: process.env,
          includeSetupRegistry: true,
        }) ?? ref.provider;
      return { modelRef: `${provider}/${ref.model}`, agentRuntimeId: "claude-cli", config: cfg };
    }
    case "gemini-cli":
    case "openai-api-key":
    case "anthropic-api-key": {
      const defaults = {
        "gemini-cli": GEMINI_CLI_DEFAULT_MODEL_REF,
        "openai-api-key": OPENAI_API_DEFAULT_MODEL_REF,
        "anthropic-api-key": ANTHROPIC_API_DEFAULT_MODEL_REF,
      };
      const modelRef = resolveRouteModelRef(ctx, defaults[params.kind]);
      if (typeof modelRef !== "string") {
        return modelRef;
      }
      return {
        modelRef,
        ...(params.kind === "gemini-cli" ? {} : { agentRuntimeId: "openclaw" }),
        config: cfg,
      };
    }
    default:
      return { error: `Unknown inference choice "${params.kind}".` };
  }
}

function patchConflicts(base: unknown, current: unknown, patch: unknown): boolean {
  if (!isRecord(patch)) {
    return !isDeepStrictEqual(base, current);
  }
  if (isRecord(base) !== isRecord(current)) {
    return true;
  }
  if (!isRecord(base) && !isRecord(current) && !isDeepStrictEqual(base, current)) {
    return true;
  }
  const before = isRecord(base) ? base : {};
  const now = isRecord(current) ? current : {};
  return Object.entries(patch).some(([key, change]) =>
    patchConflicts(before[key], now[key], change),
  );
}

/** Save credentials once, confirm the candidate in memory, then commit its config. */
export async function activateSetupInference(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  try {
    const result = await activateCandidate(params);
    return result.ok
      ? {
          ...result,
          lines: await Promise.all(
            result.lines.map((line) => redactSetupInferenceError(line, params.apiKey)),
          ),
        }
      : { ...result, error: await redactSetupInferenceError(result.error, params.apiKey) };
  } catch (error) {
    const redacted = await redactSetupInferenceError(error, params.apiKey);
    if (error instanceof WizardCancelledError) {
      throw new WizardCancelledError(redacted);
    }
    if (error instanceof WizardNavigationError) {
      throw new WizardNavigationError(error.direction);
    }
    if (error instanceof SetupInferenceCancelledError || params.signal?.aborted) {
      return { ok: false, status: "unavailable", error: "Provider login was cancelled." };
    }
    if (error instanceof SetupInferenceActivationUnavailableError) {
      return { ok: false, status: "unavailable", error: redacted };
    }
    if (error instanceof SetupInferenceOwnerDriftError) {
      return { ok: false, status: "auth", error: redacted };
    }
    if (error instanceof SetupInferenceActivationIndeterminateError) {
      throw new SetupInferenceActivationIndeterminateError(redacted);
    }
    // oxlint-disable-next-line preserve-caught-error -- The original cause can contain the submitted setup secret.
    throw new Error(redacted);
  }
}

async function activateCandidate(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  const deps = params.deps ?? {};
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const snapshot = await readSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(invalidSetupConfigError(snapshot));
  }
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  const routeAgentId = resolveAmbientOwnerAgentId(cfg, params.agentId);
  const ctx: StageContext = {
    params,
    deps,
    snapshot,
    cfg,
    routeAgentId,
    agentDir: resolveAgentDir(cfg, routeAgentId),
    workspace: params.workspace?.trim()
      ? resolveUserPath(params.workspace)
      : resolveSetupInferenceWorkspace(snapshot),
    credentialsSaved: false,
    beforePersistentEffect: async () => {
      throwIfSetupInferenceCancelled(params);
      await params.beforePersistentEffect?.();
      throwIfSetupInferenceCancelled(params);
    },
  };
  const staged = await stageCandidate(ctx);
  const failure = (result: Extract<ActivateSetupInferenceResult, { ok: false }>) => ({
    ...result,
    ...(ctx.credentialsSaved
      ? {
          error: `Credentials saved; default unchanged. ${result.error} Choose the saved sign-in in Model Setup to retry without signing in again.`,
        }
      : {}),
    disposition: "rejected-before-promotion" as const,
  });
  if ("error" in staged) {
    return failure({ ok: false, status: "unavailable", error: staged.error });
  }
  const verify = () => verifyAndActivateCandidate(ctx, staged, failure);
  return staged.authProfileId
    ? await withSetupCredentialAccess(
        { profileId: staged.authProfileId, agentDir: ctx.agentDir, signal: params.signal },
        verify,
      )
    : await verify();
}

async function verifyAndActivateCandidate(
  ctx: StageContext,
  staged: StagedCandidate,
  failure: (
    result: Extract<ActivateSetupInferenceResult, { ok: false }>,
  ) => ActivateSetupInferenceResult,
): Promise<ActivateSetupInferenceResult> {
  const { params, deps, snapshot, cfg, routeAgentId } = ctx;
  const source = snapshot.sourceConfig;
  const readSnapshot =
    deps.readConfigFileSnapshot ?? (await import("../config/config.js")).readConfigFileSnapshot;
  const catalogPreference = resolveSetupNativeSessionCatalogPreference({
    consentRequired: requiresSetupNativeSessionCatalogConsent({
      configExists: snapshot.exists,
      config: source,
      catalogs: listSetupNativeSessionCatalogs({ config: source, workspaceDir: ctx.workspace }),
    }),
    ...(params.nativeSessionCatalogsEnabled !== undefined
      ? { requested: params.nativeSessionCatalogsEnabled }
      : {}),
  });
  const prepared =
    catalogPreference === undefined
      ? staged.config
      : applySetupNativeSessionCatalogPreference({
          config: staged.config,
          enabled: catalogPreference,
          workspaceDir: ctx.workspace,
        });
  const providerPatch = createMergePatch(cfg, stripPendingPluginInstallRecords(prepared));
  const selectModel =
    params.kind === "existing-model"
      ? (config: OpenClawConfig) => config
      : await createSystemAgentModelSelectionUpdater({
          model: staged.modelRef,
          ...(params.agentId ? { targetAgentId: routeAgentId } : {}),
          ...(staged.agentRuntimeId ? { agentRuntimeId: staged.agentRuntimeId } : {}),
          runtimeInDefaults: !params.agentId && !hasResolvedRosterBeforeMigrations(snapshot),
          ...(staged.authProfileId ? { authProfileId: staged.authProfileId } : {}),
        });
  const buildCandidate = (base: OpenClawConfig) => {
    let patched = base;
    if (!isRecord(providerPatch) || Object.keys(providerPatch).length > 0) {
      // SAFETY: The patch is derived from typed configs and preserves their config shape.
      patched = applyMergePatch(base, providerPatch) as OpenClawConfig;
    }
    const selected = selectModel(patched);
    return staged.pendingPluginInstalls
      ? { ...selected, plugins: { ...selected.plugins, installs: staged.pendingPluginInstalls } }
      : selected;
  };
  const candidate = buildCandidate(cfg);
  const sourceCandidate = buildCandidate(source);
  const resolveMetadata = deps.resolvePluginMetadataSnapshot ?? resolvePluginMetadataSnapshot;
  await using cache = createPluginCache();
  const generation =
    staged.pendingPluginInstalls && Object.keys(staged.pendingPluginInstalls).length > 0
      ? await withPluginLifecycleLease({ signal: params.signal }, async () =>
          loadSetupInferencePluginGeneration({
            cache,
            config: candidate,
            workspaceDir: ctx.workspace,
            selection: {
              provider: parseInferenceRef(staged.modelRef).provider,
              modelId: parseInferenceRef(staged.modelRef).model,
              runtime: staged.agentRuntimeId ?? "openclaw",
              agentId: routeAgentId,
            },
            pendingPluginInstalls: staged.pendingPluginInstalls,
            resolvePluginMetadataSnapshot: resolveMetadata,
          }),
        )
      : undefined;
  const metadata =
    generation?.metadataSnapshot ??
    resolveMetadata({ config: candidate, workspaceDir: ctx.workspace, env: process.env });
  const routeDeps = {
    pluginMetadataPlugins: metadata.plugins,
    loadAuthProfileStoreForRuntime: deps.loadAuthProfileStoreForRuntime,
  };
  const requestedAgentId = params.agentId ? routeAgentId : undefined;
  // Saved model rows stay sparse; compare the same runtime defaults before and after writing.
  const project = (config: OpenClawConfig, sourceConfig: OpenClawConfig) =>
    projectInferenceRoute(
      materializeRuntimeConfig(config, { manifestRegistry: { plugins: [...metadata.plugins] } }),
      requestedAgentId,
      routeDeps,
      sourceConfig,
    );
  const resolveRoute = (config: OpenClawConfig, currentSnapshot = snapshot) =>
    resolveSystemAgentConfiguredRouteFromConfig(
      config,
      requestedAgentId,
      routeDeps,
      currentSnapshot,
    );
  const route = await resolveRoute(candidate);
  if (
    !route ||
    route.modelLabel !== staged.modelRef ||
    (staged.authProfileId && route.authProfileId !== staged.authProfileId)
  ) {
    return failure({
      ok: false,
      status: "unavailable",
      error:
        "The candidate route does not match the selected provider, model, and credential. Review model runtime policy and retry.",
    });
  }
  const baselineRoute = await project(cfg, source);
  const verifiedRoute = await project(candidate, sourceCandidate);
  const withGeneration = <T>(run: () => T): T =>
    generation ? withPluginRuntimeGenerationScope(generation, run) : run();
  const artifacts = withGeneration(() =>
    (deps.captureSystemAgentOwnerPluginArtifacts ?? captureSystemAgentOwnerPluginArtifacts)({
      config: route.runConfig,
      executionRoute: route,
      deps,
    }),
  );
  params.onPreparationComplete?.();
  throwIfSetupInferenceCancelled(params);
  const progress = params.prompter?.progress("Testing your AI connection…");
  const turn = await withGeneration(() =>
    runSetupInferenceTurn({
      route,
      deps,
      requireExecutionOwner: true,
      signal: params.signal,
      runtime: params.runtime,
    }),
  ).finally(() => progress?.stop());
  throwIfSetupInferenceCancelled(params);
  if (!turn.ok) {
    return failure(turn);
  }
  const ownerFailure = validateSetupInferenceOwnerEvidence({
    runner: route.runner,
    configuredHarnessId:
      route.runner === "embedded" ? route.agentHarnessRuntimeOverride : undefined,
    auth: turn.auth,
  });
  if (ownerFailure) {
    return failure(ownerFailure);
  }
  const savedCredential = staged.authProfileId
    ? loadAuthProfileStoreWithoutExternalProfiles(ctx.agentDir).profiles[staged.authProfileId]
    : undefined;
  if (savedCredential?.setup?.replacement && !params.activationConfirmed) {
    if (
      !params.prompter ||
      !(await params.prompter.confirm({
        message: "Connection verified. Activate this saved sign-in?",
        initialValue: true,
      }))
    ) {
      return failure({
        ok: false,
        status: "unavailable",
        error:
          "Activation declined. The saved sign-in is inactive and your current connection is unchanged.",
      });
    }
    throwIfSetupInferenceCancelled(params);
  }
  const revalidate = async (currentSnapshot: ConfigFileSnapshot) => {
    const config = currentSnapshot.runtimeConfig ?? currentSnapshot.config;
    const sourceConfig = currentSnapshot.sourceConfig;
    if (
      !sameDefaultInferenceRoute(await project(config, sourceConfig), baselineRoute) ||
      patchConflicts(source, sourceConfig, createMergePatch(source, sourceCandidate))
    ) {
      throw new SetupInferenceOwnerDriftError(
        "Connection settings changed during verification. Choose the saved sign-in to test the current connection.",
      );
    }
    const next = buildCandidate(config);
    if (
      !sameDefaultInferenceRoute(await project(next, buildCandidate(sourceConfig)), verifiedRoute)
    ) {
      throw new SetupInferenceOwnerDriftError(
        "The candidate route changed during verification. Retry setup before selecting it as the default.",
      );
    }
    const nextRoute = await resolveRoute(next, currentSnapshot);
    if (!nextRoute) {
      throw new SetupInferenceOwnerDriftError(
        "The selected inference route is no longer available.",
      );
    }
    await withGeneration(() =>
      revalidateStableSetupInferenceOwner({
        route: nextRoute,
        auth: turn.auth,
        stagedOwnerPluginArtifacts: artifacts,
        deps,
      }),
    );
  };
  let gatewayRestartRequired = false;
  if (!isDeepStrictEqual(sourceCandidate, source)) {
    const application = params.onRuntimeApplication
      ? createRuntimeConfigWriteApplication(captureGatewayRootWorkAdmissionContinuationScope()?.run)
      : undefined;
    if (application) {
      params.onRuntimeApplication?.(application);
    }
    const transform =
      deps.transformConfigWithPendingPluginInstalls ??
      (await import("../plugins/install-record-commit.js"))
        .transformConfigWithPendingPluginInstalls;
    let commitStarted = false;
    try {
      const committed = await transform({
        base: "source",
        writeOptions: attachRuntimeConfigWriteApplication(
          { assertCurrent: () => throwIfSetupInferenceCancelled(params) },
          application,
        ),
        transform: async (current, context) => {
          await ctx.beforePersistentEffect();
          await revalidate(context.snapshot);
          throwIfSetupInferenceCancelled(params);
          params.onCommitStarted?.(current);
          commitStarted = true;
          return { nextConfig: buildCandidate(current) };
        },
      });
      gatewayRestartRequired = committed.followUp.requiresRestart;
    } catch (error) {
      if (commitStarted) {
        throw new SetupInferenceActivationIndeterminateError(
          `Credentials are saved, but the config update could not be confirmed. Check Model Setup before retrying. ${formatErrorMessage(error)}`,
        );
      }
      throw error;
    }
  } else {
    const latest = await readSnapshot();
    await revalidate(latest);
  }
  if (staged.authProfileId && savedCredential?.setup) {
    const profileId = staged.authProfileId;
    const activate = async () => {
      await withSetupCredentialAccess(
        { profileId, agentDir: ctx.agentDir, signal: params.signal },
        async () => {
          const latest = await readSnapshot();
          const current = latest.runtimeConfig ?? latest.config;
          if (
            !sameDefaultInferenceRoute(await project(current, latest.sourceConfig), verifiedRoute)
          ) {
            throw new SetupInferenceOwnerDriftError(
              "The connection changed before credential activation. Test the saved sign-in again.",
            );
          }
          await withGeneration(() =>
            revalidateStableSetupInferenceOwner({
              route,
              auth: turn.auth,
              stagedOwnerPluginArtifacts: artifacts,
              deps,
            }),
          );
          await activateSavedSetupCredential({
            agentDir: ctx.agentDir,
            profileId,
            credential: savedCredential,
            beforeWrite: () => throwIfSetupInferenceCancelled(params),
          });
        },
      );
    };
    if (params.surface === "cli" || !gatewayRestartRequired) {
      if (params.onCredentialActivation) {
        params.onCredentialActivation(activate);
      } else {
        await activate();
      }
    }
  }
  const lines = [`Inference verified: ${staged.modelRef}`];
  if (params.surface === "gateway" && params.recordSetupAudit !== false) {
    const after = await readSnapshot().catch(() => null);
    try {
      await appendSystemAgentAuditEntry({
        operation: "openclaw.setup",
        summary: "Verified and configured AI access through OpenClaw setup",
        configPath: after?.path ?? snapshot.path,
        configHashBefore: hashConfigRaw(snapshot.raw),
        configHashAfter: after ? hashConfigRaw(after.raw) : null,
        details: { modelRef: staged.modelRef, inferenceKind: params.kind },
      });
    } catch (error) {
      const warning = `Inference setup completed, but OpenClaw could not record its audit entry: ${formatErrorMessage(error)}`;
      params.runtime.error?.(warning);
      lines.push(warning);
    }
  }
  return {
    ok: true,
    modelRef: staged.modelRef,
    latencyMs: turn.latencyMs,
    lines,
    ...(params.surface === "gateway" && gatewayRestartRequired
      ? { gatewayRestartRequired: true as const }
      : {}),
  };
}
