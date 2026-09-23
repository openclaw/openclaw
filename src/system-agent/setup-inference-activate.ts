import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import type { SetupRuntimeCredential } from "../agents/auth-profiles/setup-access.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import { resolveCliRuntimeCanonicalProvider } from "../agents/cli-backends.js";
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
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { stripPendingPluginInstallRecords } from "../plugins/install-record-commit.js";
import { createPluginCache } from "../plugins/plugin-cache.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveUserPath } from "../utils.js";
import { WizardCancelledError, WizardNavigationError } from "../wizard/prompts.js";
import { appendSystemAgentAuditEntry } from "./audit.js";
import {
  projectInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  sameDefaultInferenceRoute,
} from "./inference-route.js";
import { stageCodexCandidate } from "./setup-inference-codex.js";
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
  validateSetupModelTarget,
} from "./setup-inference-core.js";
import {
  withPreparedSetupCredentialAccess,
  activatePreparedSetupCredential,
} from "./setup-inference-credential-access.js";
import {
  stageProviderAuthCandidate,
  stageProviderAutoCandidate,
  stageSavedAuthCandidate,
} from "./setup-inference-credentials.js";
import {
  commitSetupInferenceActivation,
  captureSetupInferenceFileUndo,
  setupConfigPatchConflicts,
  type SetupInferenceConfigTarget,
} from "./setup-inference-transition.js";
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

async function stageCandidate(ctx: StageContext): Promise<StagedCandidate | StageFailure> {
  const { params, cfg } = ctx;
  const hasProviderTarget =
    params.kind.startsWith("saved-auth:") ||
    parseProviderAutoSetupChoiceId(params.kind) ||
    params.kind === "existing-model" ||
    params.kind === "provider-auth" ||
    params.kind === "api-key";
  const roleError = hasProviderTarget
    ? undefined
    : validateSetupModelTarget(undefined, params.modelTarget);
  if (roleError) {
    return roleError;
  }
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
          ...(params.modelTarget ? { modelTarget: params.modelTarget } : {}),
        },
        ctx.snapshot,
      );
      if (!route) {
        return { error: "No configured default-agent inference route is available." };
      }
      const routeRoleError = validateSetupModelTarget(route.modelTarget, params.modelTarget);
      if (routeRoleError) {
        return routeRoleError;
      }
      const requested = params.modelRef?.trim();
      if (requested && normalizeAgentModelRefForConfig(requested) !== route.modelLabel) {
        return {
          error: `The configured default model changed from ${requested} to ${route.modelLabel}. Try setup again.`,
        };
      }
      return {
        modelRef: route.modelLabel,
        ...(route.modelTarget ? { modelTarget: route.modelTarget } : {}),
        config: cfg,
        ...(route.authProfileId ? { authProfileId: route.authProfileId } : {}),
      };
    }
    case "codex-cli": {
      const modelRef = resolveRouteModelRef(ctx, CODEX_APP_SERVER_DEFAULT_MODEL_REF);
      return typeof modelRef === "string" ? await stageCodexCandidate(ctx, modelRef) : modelRef;
    }
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

async function withSetupInferenceErrorRedaction<T>(
  operation: () => Promise<T>,
  apiKey: string | undefined,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const redacted = await redactSetupInferenceError(error, apiKey);
    if (error instanceof WizardCancelledError) {
      throw new WizardCancelledError(redacted);
    }
    if (error instanceof WizardNavigationError) {
      throw new WizardNavigationError(error.direction);
    }
    if (error instanceof SetupInferenceCancelledError) {
      throw new SetupInferenceCancelledError();
    }
    if (error instanceof SetupInferenceActivationUnavailableError) {
      throw new SetupInferenceActivationUnavailableError(redacted);
    }
    if (error instanceof SetupInferenceOwnerDriftError) {
      throw new SetupInferenceOwnerDriftError(redacted);
    }
    if (error instanceof SetupInferenceActivationIndeterminateError) {
      throw new SetupInferenceActivationIndeterminateError(redacted);
    }
    // oxlint-disable-next-line preserve-caught-error -- The original cause can contain the submitted setup secret.
    throw new Error(redacted);
  }
}

/** Save credentials once, confirm the candidate in memory, then commit its config. */
export async function activateSetupInference(
  params: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  try {
    return await withSetupInferenceErrorRedaction(async () => {
      const onActivationCompletion = params.onActivationCompletion;
      const result = await activateCandidate({
        ...params,
        onActivationCompletion: onActivationCompletion
          ? (complete) =>
              onActivationCompletion(() =>
                withSetupInferenceErrorRedaction(complete, params.apiKey),
              )
          : undefined,
      });
      return result.ok
        ? {
            ...result,
            lines: await Promise.all(
              result.lines.map((line) => redactSetupInferenceError(line, params.apiKey)),
            ),
          }
        : { ...result, error: await redactSetupInferenceError(result.error, params.apiKey) };
    }, params.apiKey);
  } catch (error) {
    if (error instanceof WizardCancelledError || error instanceof WizardNavigationError) {
      throw error;
    }
    if (error instanceof SetupInferenceCancelledError || params.signal?.aborted) {
      return { ok: false, status: "unavailable", error: "Provider login was cancelled." };
    }
    if (error instanceof SetupInferenceActivationUnavailableError) {
      return { ok: false, status: "unavailable", error: error.message };
    }
    if (error instanceof SetupInferenceOwnerDriftError) {
      return { ok: false, status: "auth", error: error.message };
    }
    throw error;
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
  const verify = (runtimeCredential?: SetupRuntimeCredential) =>
    verifyAndActivateCandidate(ctx, staged, failure, runtimeCredential);
  if (!staged.authProfileId) {
    return await verify();
  }
  return await withPreparedSetupCredentialAccess(
    ctx,
    staged,
    staged.authProfileId,
    verify,
    failure,
  );
}

async function verifyAndActivateCandidate(
  ctx: StageContext,
  staged: StagedCandidate,
  failure: (
    result: Extract<ActivateSetupInferenceResult, { ok: false }>,
  ) => ActivateSetupInferenceResult,
  runtimeCredential?: SetupRuntimeCredential,
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
  const selectModel: (config: OpenClawConfig, previousConfig: OpenClawConfig) => OpenClawConfig =
    params.kind === "existing-model"
      ? (config: OpenClawConfig) => config
      : await createSystemAgentModelSelectionUpdater({
          model: staged.modelRef,
          ...(staged.modelTarget ? { modelTarget: staged.modelTarget } : {}),
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
    const selected = selectModel(patched, base);
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
    ...(staged.modelTarget ? { modelTarget: staged.modelTarget } : {}),
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
      setupConfigPatchConflicts(source, sourceConfig, createMergePatch(source, sourceCandidate))
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
  const activateCredential = async (assertCurrent: () => void) => {
    if (!staged.authProfileId || !savedCredential?.setup) {
      return undefined;
    }
    const profileId = staged.authProfileId;
    return await activatePreparedSetupCredential(
      ctx,
      profileId,
      savedCredential,
      runtimeCredential,
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
      },
      assertCurrent,
    );
  };
  if (!isDeepStrictEqual(sourceCandidate, source) || savedCredential?.setup) {
    const configTarget: SetupInferenceConfigTarget = {
      read: async () => ({
        config: (await readSnapshot()).sourceConfig,
        write: configTarget.write,
      }),
      write: async (_candidate, { writeOptions, captureUndo }) => {
        const transform =
          deps.transformConfigWithPendingPluginInstalls ??
          (await import("../plugins/install-record-commit.js"))
            .transformConfigWithPendingPluginInstalls;
        const committed = await transform({
          base: "source",
          writeOptions,
          transform: async (current, context) => {
            await ctx.beforePersistentEffect();
            await revalidate(context.snapshot);
            throwIfSetupInferenceCancelled(params);
            params.onCommitStarted?.(current);
            const nextConfig = buildCandidate(current);
            captureUndo(
              captureSetupInferenceFileUndo(
                {
                  ...context.snapshot,
                  sourceConfig: stripPendingPluginInstallRecords(context.snapshot.sourceConfig),
                },
                stripPendingPluginInstallRecords(nextConfig),
              ),
            );
            return { nextConfig };
          },
        });
        return committed.nextConfig;
      },
    };
    await commitSetupInferenceActivation({
      preserveWorkingConnection: Boolean(
        savedCredential?.setup?.replacement ||
        baselineRoute.route ||
        resolveAgentEffectiveModelPrimary(cfg, routeAgentId),
      ),
      assertCurrent: () => throwIfSetupInferenceCancelled(params),
      activate: activateCredential,
      deferCompletion: params.onActivationCompletion,
      configTarget,
      config: sourceCandidate,
    });
  } else {
    await revalidate(await readSnapshot());
  }
  const lines = [
    `${staged.modelTarget === "utility" ? "Utility inference" : "Inference"} verified: ${staged.modelRef}`,
  ];
  if (params.surface === "gateway" && params.recordSetupAudit !== false) {
    const after = await readSnapshot().catch(() => null);
    try {
      await appendSystemAgentAuditEntry({
        operation: "openclaw.setup",
        summary: "Verified an AI access candidate through OpenClaw setup",
        configPath: after?.path ?? snapshot.path,
        configHashBefore: hashConfigRaw(snapshot.raw),
        configHashAfter: after ? hashConfigRaw(after.raw) : null,
        details: { modelRef: staged.modelRef, inferenceKind: params.kind },
      });
    } catch (error) {
      const warning = `Inference was verified, but OpenClaw could not record its audit entry: ${formatErrorMessage(error)}`;
      params.runtime.error?.(warning);
      lines.push(warning);
    }
  }
  return {
    ok: true,
    modelRef: staged.modelRef,
    ...(staged.modelTarget ? { modelTarget: staged.modelTarget } : {}),
    latencyMs: turn.latencyMs,
    lines,
  };
}
