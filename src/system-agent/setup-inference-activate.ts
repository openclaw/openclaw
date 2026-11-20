import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentDir, resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import type { SetupRuntimeCredential } from "../agents/auth-profiles/setup-access.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import { findModelInCatalog } from "../agents/model-catalog-lookup.js";
import { loadManifestModelCatalog } from "../agents/model-catalog.js";
import { hasResolvedRosterBeforeMigrations } from "../config/agent-roster-provenance.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { materializeRuntimeConfig } from "../config/materialize.js";
import { applyMergePatch, createMergePatch } from "../config/merge-patch.js";
import { copyRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { stripPendingPluginInstallRecords } from "../plugins/install-record-commit.js";
import { createPluginCache } from "../plugins/plugin-cache.js";
import type { PluginCache } from "../plugins/plugin-cache.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveUserPath } from "../utils.js";
import { WizardCancelledError, WizardNavigationError } from "../wizard/prompts.js";
import { appendSystemAgentAuditEntry } from "./audit.js";
import {
  projectInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
import { stageSetupInferenceCandidate } from "./setup-inference-candidates.js";
import {
  type ActivateSetupInferenceParams,
  type StagedCandidate,
  type StageContext,
  type ActivateSetupInferenceResult,
  describeSetupInferenceError,
  invalidSetupConfigError,
  redactSetupInferenceError,
  resolveSetupInferenceWorkspace,
  SetupInferenceActivationIndeterminateError,
  SetupInferenceActivationUnavailableError,
  SetupInferenceCancelledError,
  SetupInferenceOwnerDriftError,
  throwIfSetupInferenceCancelled,
  validateSetupInferenceEvidence,
} from "./setup-inference-core.js";
import {
  withPreparedSetupCredentialAccess,
  activatePreparedSetupCredential,
} from "./setup-inference-credential-access.js";
import {
  prepareSetupNativeRuntimeConsent,
  prepareSetupVerificationGeneration,
  verifySetupHarness,
  type SetupHarnessVerification,
} from "./setup-inference-harness.js";
import {
  commitSetupInferenceActivation,
  captureSetupInferenceFileUndo,
  setupConfigPatchConflicts,
  type SetupInferenceConfigTarget,
} from "./setup-inference-transition.js";
import {
  revalidateStableSetupInferenceOwner,
  runSetupInferenceTurn,
} from "./setup-inference-turn.js";
import type { SetupInferencePluginGeneration } from "./setup-inference-turn.js";
import { createSystemAgentModelSelectionUpdater } from "./setup-model-selection.js";
import {
  applySetupNativeSessionCatalogPreference,
  listSetupNativeSessionCatalogs,
  requiresSetupNativeSessionCatalogConsent,
  resolveSetupNativeSessionCatalogPreference,
} from "./setup-native-session-catalogs.js";
import { captureSystemAgentOwnerPluginArtifacts } from "./verified-inference.js";

async function withSetupInferenceErrorRedaction<T>(
  operation: () => Promise<T>,
  apiKey: string | undefined,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const redacted = await redactSetupInferenceError(error, apiKey);
    if (error instanceof WizardNavigationError) {
      throw new WizardNavigationError(error.direction);
    }
    if (error instanceof SetupInferenceCancelledError) {
      throw new SetupInferenceCancelledError();
    }
    // Original causes and stacks can contain the submitted secret.
    const RedactedError =
      [
        WizardCancelledError,
        SetupInferenceActivationUnavailableError,
        SetupInferenceOwnerDriftError,
        SetupInferenceActivationIndeterminateError,
      ].find((ErrorType) => error instanceof ErrorType) ?? Error;
    throw new RedactedError(redacted);
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
  callerParams: ActivateSetupInferenceParams,
): Promise<ActivateSetupInferenceResult> {
  const effects = { credentialsSaved: false, configPersisted: false };
  // Like cancellation, caller authority governs activation until its config is persisted;
  // a saved activation then completes like any other committed config write.
  const params: ActivateSetupInferenceParams = {
    ...callerParams,
    assertCurrent: () => {
      if (!effects.configPersisted) {
        callerParams.assertCurrent?.();
      }
    },
  };
  const { readConfigFileSnapshot: readSnapshot } = await import("../config/config.js");
  const snapshot = await readSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(invalidSetupConfigError(snapshot));
  }
  const cfg = snapshot.runtimeConfig ?? snapshot.config;
  const routeAgentId = resolveAmbientOwnerAgentId(cfg, params.agentId);
  const ctx: StageContext = {
    params,
    snapshot,
    cfg,
    routeAgentId,
    agentDir: resolveAgentDir(cfg, routeAgentId),
    workspace: params.workspace?.trim()
      ? resolveUserPath(params.workspace)
      : resolveSetupInferenceWorkspace(snapshot),
    effects,
    beforePersistentEffect: async () => {
      throwIfSetupInferenceCancelled(params);
      params.onActivationStarted?.();
      await params.beforePersistentEffect?.();
      throwIfSetupInferenceCancelled(params);
    },
  };
  const staged = await stageSetupInferenceCandidate(ctx);
  const failure = (result: Extract<ActivateSetupInferenceResult, { ok: false }>) => ({
    ...result,
    ...(ctx.effects.credentialsSaved
      ? {
          error: `Credentials saved; default unchanged. ${result.error} Choose the saved sign-in in Model Setup to retry without signing in again.`,
        }
      : {}),
    disposition: "rejected-before-promotion" as const,
  });
  if ("error" in staged) {
    return failure({ ok: false, status: "unavailable", error: staged.error });
  }
  await using cache = createPluginCache();
  const prepared = await prepareSetupNativeRuntimeConsent(ctx, staged, cache);
  staged.config = prepared.config;
  const verify = (runtimeCredential?: SetupRuntimeCredential) =>
    verifyAndActivateCandidate(ctx, staged, failure, cache, prepared.generation, runtimeCredential);
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
  cache: PluginCache,
  preparedGeneration: SetupInferencePluginGeneration | undefined,
  runtimeCredential?: SetupRuntimeCredential,
): Promise<ActivateSetupInferenceResult> {
  const { params, snapshot, cfg, routeAgentId } = ctx;
  const source = snapshot.sourceConfig;
  const { readConfigFileSnapshot: readSnapshot } = await import("../config/config.js");
  const catalogPreference = params.automaticSetup
    ? false
    : resolveSetupNativeSessionCatalogPreference({
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
          onlyUnset: params.automaticSetup === true,
          workspaceDir: ctx.workspace,
        });
  const providerPatch = createMergePatch(cfg, stripPendingPluginInstallRecords(prepared));
  // Gateway setup that chooses the first primary model on an install without
  // an authored roster also creates the canonical first agent. Existing
  // installs, CLI activation and access-only sign-in keep their prior shape.
  // The UI may select implicit main before it has an authored roster. Runtime
  // metadata must remain in defaults until canonical first-agent provisioning.
  const pendingFirstAgent =
    params.surface === "gateway" &&
    !hasResolvedRosterBeforeMigrations(snapshot) &&
    !resolveAgentEffectiveModelPrimary(source, routeAgentId) &&
    (!params.agentId || routeAgentId === resolveAmbientOwnerAgentId(cfg));
  const createFirstAgent =
    pendingFirstAgent && params.selectModel !== false && staged.modelTarget !== "utility";
  const selectModel: (config: OpenClawConfig, previousConfig: OpenClawConfig) => OpenClawConfig =
    params.kind === "existing-model"
      ? (config: OpenClawConfig) => config
      : await createSystemAgentModelSelectionUpdater({
          model: staged.modelRef,
          ...(staged.modelTarget ? { modelTarget: staged.modelTarget } : {}),
          ...(params.agentId && !pendingFirstAgent ? { targetAgentId: routeAgentId } : {}),
          ...(staged.agentRuntimeId ? { agentRuntimeId: staged.agentRuntimeId } : {}),
          runtimeInDefaults:
            (!params.agentId || pendingFirstAgent) && !hasResolvedRosterBeforeMigrations(snapshot),
          ...(staged.authProfileId ? { authProfileId: staged.authProfileId } : {}),
        });
  const buildCandidate = (base: OpenClawConfig) => {
    let patched = base;
    if (!isRecord(providerPatch) || Object.keys(providerPatch).length > 0) {
      // SAFETY: The patch is derived from typed configs and preserves their config shape.
      patched = applyMergePatch(base, providerPatch) as OpenClawConfig;
    }
    const selected = params.selectModel === false ? patched : selectModel(patched, base);
    return staged.pendingPluginInstalls
      ? { ...selected, plugins: { ...selected.plugins, installs: staged.pendingPluginInstalls } }
      : selected;
  };
  const candidate = buildCandidate(cfg);
  const sourceCandidate = buildCandidate(source);
  // Verify the candidate's route without persisting a new primary model for access-only sign-in.
  const candidateRouteConfig = (config: OpenClawConfig) =>
    params.selectModel === false ? selectModel(config, config) : config;
  const { generation, metadata } = await prepareSetupVerificationGeneration(
    ctx,
    staged,
    candidate,
    cache,
    preparedGeneration,
  );
  const routeDeps = {
    ...(staged.modelTarget ? { modelTarget: staged.modelTarget } : {}),
    pluginMetadataPlugins: metadata.plugins,
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
      candidateRouteConfig(config),
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
  let verifiedRoute = await project(
    candidateRouteConfig(candidate),
    candidateRouteConfig(sourceCandidate),
  );
  const withGeneration = <T>(run: () => T): T =>
    generation ? withPluginRuntimeGenerationScope(generation, run) : run();
  const artifacts = withGeneration(() =>
    captureSystemAgentOwnerPluginArtifacts({
      config: route.runConfig,
      executionRoute: route,
    }),
  );
  params.onPreparationComplete?.();
  throwIfSetupInferenceCancelled(params);
  const progress = params.prompter?.progress("Testing your AI connection…");
  // A silent spinner reads as a hang once a provider is slow; show the wait and the way out.
  const checkStarted = Date.now();
  const elapsed = progress
    ? setInterval(() => {
        const seconds = Math.round((Date.now() - checkStarted) / 1000);
        if (seconds >= 3) {
          progress.update(
            `Testing your AI connection… ${seconds}s. You can cancel; nothing changes until the check passes.`,
          );
        }
      }, 1000)
    : undefined;
  elapsed?.unref?.();
  const verification = await withGeneration(async () => {
    try {
      const native = await verifySetupHarness({
        route,
        cache,
        generation,
        signal: params.signal,
        assertCurrent: () => throwIfSetupInferenceCancelled(params),
      });
      if (native) {
        return native;
      }
      return await runSetupInferenceTurn({
        route,
        requireExecutionOwner: true,
        signal: params.signal,
        runtime: params.runtime,
      });
    } catch (error) {
      return { ok: false as const, ...describeSetupInferenceError(error, route) };
    }
  }).finally(() => {
    clearInterval(elapsed);
    progress?.stop();
  });
  throwIfSetupInferenceCancelled(params);
  if (!verification.ok) {
    return failure(verification);
  }
  const evidence =
    "auth" in verification ? validateSetupInferenceEvidence(route, verification, params) : {};
  if (evidence.failure) {
    return failure(evidence.failure);
  }
  if (evidence.warning && params.prompter) {
    await params.prompter.note(evidence.warning, "Context window");
    throwIfSetupInferenceCancelled(params);
  }
  const savedCredential = staged.authProfileId
    ? (await loadAuthProfileStoreWithoutExternalProfilesAsync(ctx.agentDir)).profiles[
        staged.authProfileId
      ]
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
  params.onActivationStarted?.();
  const revalidateOwner = async (candidateRoute: SystemAgentConfiguredRoute) => {
    if ("binding" in verification) {
      let current: SetupHarnessVerification | undefined;
      try {
        current = await withGeneration(() =>
          verifySetupHarness({
            route: candidateRoute,
            cache,
            generation,
            signal: params.signal,
            assertCurrent: () => throwIfSetupInferenceCancelled(params),
          }),
        );
      } catch (error) {
        throw new SetupInferenceOwnerDriftError(
          `The native connection changed before activation. Retry setup. (${formatErrorMessage(error)})`,
          { cause: error },
        );
      }
      if (!current || !isDeepStrictEqual(current.binding, verification.binding)) {
        throw new SetupInferenceOwnerDriftError(
          "The native setup verification owner changed before activation. Retry setup.",
        );
      }
      return;
    }
    await withGeneration(() =>
      revalidateStableSetupInferenceOwner({
        route: candidateRoute,
        auth: verification.auth,
        stagedOwnerPluginArtifacts: artifacts,
      }),
    );
  };
  const revalidate = async (currentSnapshot: ConfigFileSnapshot) => {
    const config = currentSnapshot.runtimeConfig ?? currentSnapshot.config;
    const sourceConfig = currentSnapshot.sourceConfig;
    if (
      !isDeepStrictEqual(await project(config, sourceConfig), baselineRoute) ||
      setupConfigPatchConflicts(source, sourceConfig, createMergePatch(source, sourceCandidate))
    ) {
      throw new SetupInferenceOwnerDriftError(
        "Connection settings changed during verification. Choose the saved sign-in to test the current connection.",
      );
    }
    const next = buildCandidate(config);
    if (
      !isDeepStrictEqual(
        await project(
          candidateRouteConfig(next),
          candidateRouteConfig(buildCandidate(sourceConfig)),
        ),
        verifiedRoute,
      )
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
    await revalidateOwner(nextRoute);
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
        if (!isDeepStrictEqual(await project(current, latest.sourceConfig), verifiedRoute)) {
          throw new SetupInferenceOwnerDriftError(
            "The connection changed before credential activation. Test the saved sign-in again.",
          );
        }
        await revalidateOwner(route);
      },
      assertCurrent,
    );
  };
  if (!isDeepStrictEqual(sourceCandidate, source) || savedCredential?.setup || createFirstAgent) {
    let createdFirstAgent: OpenClawConfig | undefined;
    const finishFirstAgent = async () => {
      if (!createdFirstAgent) {
        return;
      }
      try {
        const { provisionDefaultProactiveJob } = await import("../cron/default-proactive-job.js");
        await provisionDefaultProactiveJob(createdFirstAgent, routeAgentId, {
          commitGuard: () => throwIfSetupInferenceCancelled(params),
        });
      } catch (error) {
        // The model and agent are already applied; the default check-in job is optional.
        params.runtime.error?.(
          `Your agent is ready, but OpenClaw couldn't schedule its default check-in: ${formatErrorMessage(error)}`,
        );
      }
    };
    const configTarget: SetupInferenceConfigTarget = {
      read: async () => ({
        config: (await readSnapshot()).sourceConfig,
        write: configTarget.write,
      }),
      write: async (_candidate, { writeOptions, captureUndo }) => {
        const { transformConfigWithPendingPluginInstalls: transform } =
          await import("../plugins/install-record-commit.js");
        const captureFileUndo = (base: ConfigFileSnapshot, written: OpenClawConfig) => {
          let previous = stripPendingPluginInstallRecords(base.sourceConfig);
          if (createFirstAgent && previous.agents) {
            // A load-time implicit main is not an authored roster to retain on rollback.
            const { entries: _implicit, ...agents } = previous.agents;
            const entries = base.sourceConfigBeforeMigrations?.agents?.entries;
            previous = { ...previous, agents: { ...agents, ...(entries ? { entries } : {}) } };
          }
          const undo = captureSetupInferenceFileUndo(
            { ...base, sourceConfig: previous },
            stripPendingPluginInstallRecords(written),
          );
          captureUndo(
            createFirstAgent
              ? (options) =>
                  undo(
                    copyRuntimeConfigWriteApplication(options, {
                      ...options,
                      allowedAgentRosterRemovals: [routeAgentId],
                      // The conditional inverse removes only this first-agent publication.
                      allowConfigSizeDrop: true,
                    }),
                  )
              : undo,
          );
        };
        if (createFirstAgent) {
          const { readConfigFileSnapshotForWrite } = await import("../config/config.js");
          const { createSetupFirstAgent } = await import("./setup-first-agent.js");
          const writeSnapshot = await readConfigFileSnapshotForWrite();
          await ctx.beforePersistentEffect();
          await revalidate(writeSnapshot.snapshot);
          params.onCommitStarted?.(writeSnapshot.snapshot.sourceConfig);
          const published = await createSetupFirstAgent({
            agentId: routeAgentId,
            config: buildCandidate(writeSnapshot.snapshot.sourceConfig),
            writeSnapshot: {
              ...writeSnapshot,
              writeOptions: copyRuntimeConfigWriteApplication(writeOptions, {
                ...writeSnapshot.writeOptions,
                ...writeOptions,
              }),
            },
            beforePersistentApply: () => throwIfSetupInferenceCancelled(params),
            prepareConfigCommit: async (next) => {
              // Canonical creation adds the real roster/workspace to the verified route.
              verifiedRoute = await project(candidateRouteConfig(next), next);
              captureFileUndo(writeSnapshot.snapshot, next);
            },
            onCommitted: (next) => {
              captureFileUndo(writeSnapshot.snapshot, next);
              ctx.effects.configPersisted = true;
            },
          });
          createdFirstAgent = published;
          return published;
        }
        const committed = await transform({
          base: "source",
          writeOptions,
          transform: async (current, context) => {
            await ctx.beforePersistentEffect();
            await revalidate(context.snapshot);
            throwIfSetupInferenceCancelled(params);
            params.onCommitStarted?.(current);
            const nextConfig = buildCandidate(current);
            // Covers a write that fails after persisting; success replaces it below.
            captureFileUndo(context.snapshot, nextConfig);
            return { nextConfig };
          },
        });
        // Undo what reached disk: the write pipeline adds metadata the candidate lacks.
        captureFileUndo(
          committed.snapshot,
          committed.persistedSourceConfig ?? committed.nextConfig,
        );
        ctx.effects.configPersisted = true;
        return committed.nextConfig;
      },
    };
    await commitSetupInferenceActivation({
      // Access-only setup leaves the primary route intact and may reload its new runtime plugin.
      preserveWorkingConnection: Boolean(
        savedCredential?.setup?.replacement ||
        (params.selectModel !== false &&
          (baselineRoute.route || resolveAgentEffectiveModelPrimary(cfg, routeAgentId))),
      ),
      requireApplied: params.automaticSetup || createFirstAgent ? true : undefined,
      assertCurrent: () => throwIfSetupInferenceCancelled(params),
      activate: activateCredential,
      deferCompletion: params.onActivationCompletion
        ? (complete) =>
            params.onActivationCompletion?.(async () => {
              const restart = await complete();
              if (!restart) {
                await finishFirstAgent();
              }
              return restart;
            })
        : undefined,
      configTarget,
      config: sourceCandidate,
    });
    if (!params.onActivationCompletion) {
      await finishFirstAgent();
    }
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
        details: {
          modelRef: staged.modelRef,
          inferenceKind: params.kind,
          ...(params.automaticSetup ? { source: "automatic-setup" } : {}),
        },
      });
    } catch (error) {
      const warning = `Inference was verified, but OpenClaw could not record its audit entry: ${formatErrorMessage(error)}`;
      params.runtime.error?.(warning);
      lines.push(warning);
    }
  }
  const modelName = findModelInCatalog(
    loadManifestModelCatalog({ config: candidate, metadataSnapshot: metadata }),
    route.provider,
    route.model,
  )?.name;
  return {
    ok: true,
    modelRef: staged.modelRef,
    ...(modelName ? { modelName } : {}),
    ...(staged.modelTarget ? { modelTarget: staged.modelTarget } : {}),
    latencyMs: verification.latencyMs,
    lines: evidence.warning && !params.prompter ? [...lines, evidence.warning] : lines,
  };
}
