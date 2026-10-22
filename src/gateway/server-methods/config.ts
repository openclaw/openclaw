import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  validateConfigApplyParams,
  validateConfigGetParams,
  validateConfigPatchParams,
  validateConfigSchemaLookupParams,
  validateConfigSchemaParams,
  validateConfigSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ConfigPatchParams } from "../../../packages/gateway-protocol/src/schema/config.js";
import { readAgentRosterProperty } from "../../agents/agent-scope-config.js";
import {
  createConfigIO,
  parseConfigJson5,
  readConfigFileSnapshotForWrite,
} from "../../config/io.js";
import { ConfigWritePostCommitError } from "../../config/io.write-errors.js";
import { applyMergePatch, createMergePatch } from "../../config/merge-patch.js";
import { normalizeSubmittedConfigModelRefs } from "../../config/model-input-normalization.js";
import { isBuiltInModelProviderOverlayId } from "../../config/model-provider-overlay-ids.js";
import { ConfigMutationConflictError } from "../../config/mutation-conflict.js";
import { normalizeConfigPatchReplacePaths } from "../../config/patch-replace-paths.js";
import { redactConfigObject, restoreRedactedValues } from "../../config/redact-snapshot.js";
import {
  invalidateGatewayRuntimeConfigSchema,
  loadGatewayRuntimeConfigSchema,
  loadGatewayConfigRedactionHints,
} from "../../config/runtime-schema.js";
import { lookupConfigSchema } from "../../config/schema.js";
import { projectRuntimeChangesOntoSource } from "../../config/source-value-projection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactToolDetail } from "../../logging/redact.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  isRetryableSecretDegradationReason,
  redactSecretDegradationReason,
} from "../../secrets/runtime-degraded-state.js";
import {
  prepareSecretsRuntimeSnapshot,
  type PreparedSecretsRuntimeSnapshot,
} from "../../secrets/runtime.js";
import { diffGatewayReloadPaths } from "../config-diff.js";
import { invalidateConfigGetResponseCache, readConfigGetResponse } from "../config-get-response.js";
import {
  listConfigReloadRefinementPrefixes,
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  resolveConfigReloadMetadata,
} from "../config-reload-plan.js";
import type { GatewayConfigRevisionProjector } from "../config-revision-token.js";
import {
  formatControlPlaneActor,
  resolveControlPlaneActor,
  summarizeChangedPaths,
} from "../control-plane-audit.js";
import { resolveBaseHashParam } from "./base-hash.js";
import {
  prepareCustomEndpointPatch,
  createCustomEndpointHandler,
  type CustomEndpointParams,
} from "./config-custom-endpoint.js";
import {
  diffConfigLeafPaths,
  assertNoDuplicateConfigPatchIds,
  rejectDestructiveArrayPatchWithoutIntent,
  hasHashlessPatchLwwStructure,
  isHashlessPatchLwwPath,
} from "./config-patch-intent.js";
import {
  summarizeConfigValidationIssues,
  validateSubmittedConfigOrRespond,
} from "./config-submission-validation.js";
import {
  commitGatewayConfigWrite,
  didActiveSharedGatewayAuthChange,
  didSharedGatewayAuthChange,
  resolveGatewayConfigPath,
  resolveGatewayConfigRestartWriteResult,
  shouldAwaitGatewayConfigApplication,
} from "./config-write-flow.js";
import { readConfigWriteSnapshotOrRespond } from "./config-write-snapshot.js";
import {
  execOpenPath,
  formatOpenPathError,
  isHeadlessOpenPathError,
  resolveOpenPathCommand,
  sanitizePathForLog,
} from "./open-path.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlers,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler } from "./validation.js";

const configWriteRecovery = new WeakMap<
  GatewayConfigRevisionProjector,
  { configPath: string; error: ReturnType<typeof errorShape> }
>();

type ConfigRedactionHints = Parameters<typeof redactConfigObject>[1];
type ConfigRestartWriteMode = Parameters<typeof resolveGatewayConfigRestartWriteResult>[0]["mode"];

function hasOwnRecordValue(value: unknown, key: string): boolean {
  return isRecord(value) && Object.hasOwn(value, key);
}

function stripBundledProviderRuntimeDefaults(params: {
  candidate: unknown;
  sourceConfig: unknown;
}): unknown {
  if (!isRecord(params.candidate)) {
    return params.candidate;
  }
  const models = params.candidate.models;
  if (!isRecord(models) || !isRecord(models.providers)) {
    return params.candidate;
  }
  const sourceModels = isRecord(params.sourceConfig) ? params.sourceConfig.models : undefined;
  const sourceProviders = isRecord(sourceModels) ? sourceModels.providers : undefined;

  let nextProviders: Record<string, unknown> | undefined;
  for (const [providerId, provider] of Object.entries(models.providers)) {
    // Runtime overlays can materialize empty defaults that should not become persisted config.
    if (!isBuiltInModelProviderOverlayId(providerId) || !isRecord(provider)) {
      continue;
    }
    const sourceProvider = isRecord(sourceProviders) ? sourceProviders[providerId] : undefined;
    let nextProvider: Record<string, unknown> | undefined;
    if (provider.baseUrl === "" && !hasOwnRecordValue(sourceProvider, "baseUrl")) {
      nextProvider = { ...provider };
      delete nextProvider.baseUrl;
    }
    if (
      Array.isArray(provider.models) &&
      provider.models.length === 0 &&
      !hasOwnRecordValue(sourceProvider, "models")
    ) {
      nextProvider ??= { ...provider };
      delete nextProvider.models;
    }
    if (nextProvider) {
      nextProviders ??= { ...models.providers };
      nextProviders[providerId] = nextProvider;
    }
  }
  if (!nextProviders) {
    return params.candidate;
  }
  return {
    ...params.candidate,
    models: {
      ...models,
      providers: nextProviders,
    },
  };
}

async function prepareConfigReplacementOrRespond(
  params: { raw: string },
  respond: RespondFn,
  revisionProjector: GatewayConfigRevisionProjector,
) {
  const writeSnapshot = await readConfigWriteSnapshotOrRespond(params, respond, revisionProjector);
  if (!writeSnapshot) {
    return null;
  }
  const { snapshot, writeOptions } = writeSnapshot;
  const parsedRes = parseConfigJson5(params.raw);
  if (!parsedRes.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
    return null;
  }
  const uiHints = loadGatewayConfigRedactionHints();
  const restored = restoreRedactedValues(parsedRes.parsed, snapshot.config, uiHints);
  if (!restored.ok) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, restored.humanReadableMessage ?? "invalid config"),
    );
    return null;
  }
  // Full replacements may echo runtime defaults; keep only edits over the source snapshot.
  const sourceCandidate = snapshot.valid
    ? projectRuntimeChangesOntoSource(snapshot.resolved, snapshot.config, restored.result)
    : restored.result;
  const validatedSubmission = validateSubmittedConfigOrRespond({
    candidate: stripBundledProviderRuntimeDefaults({
      candidate: sourceCandidate,
      sourceConfig: snapshot.sourceConfig,
    }),
    pluginMetadataSnapshot: writeOptions.basePluginMetadataSnapshot,
    respond,
  });
  if (!validatedSubmission) {
    return null;
  }
  return {
    writeSnapshot,
    config: validatedSubmission.config,
    writeConfig: validatedSubmission.validationCandidate,
    uiHints,
  };
}

function listExplicitAgentRosterIds(config: OpenClawConfig): string[] {
  const roster = readAgentRosterProperty(config);
  if (roster?.kind === "entries" && isRecord(roster.value)) {
    return Object.keys(roster.value);
  }
  if (roster?.kind !== "list" || !Array.isArray(roster.value)) {
    return [];
  }
  return roster.value.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
  );
}

function rejectDroppedAgentRosterEntries(params: {
  currentConfig: OpenClawConfig;
  submittedConfig: OpenClawConfig;
  respond: RespondFn;
}): boolean {
  const submittedIds = new Set(
    listExplicitAgentRosterIds(params.submittedConfig).map((agentId) => normalizeAgentId(agentId)),
  );
  const droppedIds = listExplicitAgentRosterIds(params.currentConfig)
    .filter((agentId) => !submittedIds.has(normalizeAgentId(agentId)))
    .toSorted();
  if (droppedIds.length === 0) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `config.set would remove existing agent entries: ${droppedIds.join(", ")}. ` +
        "Use the agents.delete RPC or `openclaw agents delete <id>` for intentional deletion.",
    ),
  );
  return true;
}

async function ensureResolvableSecretRefsOrRespond(params: {
  config: OpenClawConfig;
  respond: RespondFn;
}): Promise<PreparedSecretsRuntimeSnapshot | null> {
  try {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: params.config,
      includeAuthStoreRefs: false,
      allowUnavailableSecretOwners: true,
    });
    for (const owner of snapshot.degradedOwners ?? []) {
      const reason = redactSecretDegradationReason(owner.reason);
      if (!isRetryableSecretDegradationReason(reason)) {
        throw new Error(reason);
      }
    }
    return snapshot;
  } catch (error) {
    const details = formatErrorMessage(error);
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid config: active SecretRef resolution failed (${details})`,
      ),
    );
    return null;
  }
}

function preparedSecretDegradationPayload(snapshot: PreparedSecretsRuntimeSnapshot) {
  const degradedSecretOwners = (snapshot.degradedOwners ?? []).map((owner) => ({
    ownerKind: owner.ownerKind,
    ownerId: owner.ownerId,
    state: owner.degradationState ?? "cold",
    paths: [...owner.paths],
    reason: redactSecretDegradationReason(owner.reason),
  }));
  return degradedSecretOwners.length > 0 ? { degradedSecretOwners } : {};
}

async function commitConfigRestartWrite(params: {
  requestParams: unknown;
  mode: ConfigRestartWriteMode;
  writeSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>;
  writeConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  actor: ReturnType<typeof resolveControlPlaneActor>;
  context: GatewayRequestContext;
  respond: RespondFn;
  uiHints: ConfigRedactionHints;
  preparedSecretsSnapshot: PreparedSecretsRuntimeSnapshot;
  summary?: boolean;
}): Promise<void> {
  const { snapshot, writeOptions } = params.writeSnapshot;
  const changedPaths = diffGatewayReloadPaths(
    snapshot.config,
    params.nextConfig,
    listConfigReloadRefinementPrefixes(),
  );
  params.context?.logGateway?.info(
    `${params.mode} write ${formatControlPlaneActor(params.actor)} changedPaths=${summarizeChangedPaths(changedPaths)} restartReason=${params.mode}`,
  );
  // Compare before the write so successful publication invalidates the previous shared secret.
  const disconnectSharedAuthClients =
    didSharedGatewayAuthChange(snapshot.config, params.nextConfig) ||
    didActiveSharedGatewayAuthChange({
      fallbackPrev: snapshot.config,
      fallbackSource: snapshot.sourceConfig,
      next: params.preparedSecretsSnapshot.config,
    });
  const writeResult = await commitGatewayConfigWriteOrRespond({
    snapshot,
    writeOptions,
    nextConfig: params.writeConfig,
    context: params.context,
    disconnectSharedAuthClients,
    awaitRuntimeApplication: shouldAwaitGatewayConfigApplication({
      changedPaths,
      previousConfig: snapshot.config,
      nextConfig: params.nextConfig,
    }),
    respond: params.respond,
  });
  if (!writeResult) {
    return;
  }
  const persistedConfig = {
    ...(writeResult.hash
      ? { hash: params.context.configRevisionProjector.projectRawHash(writeResult.hash) }
      : {}),
    ...(!params.summary ? { config: redactConfigObject(writeResult.config, params.uiHints) } : {}),
  };
  if (writeResult.application) {
    const outcome = await writeResult.application;
    if (outcome !== "applied") {
      const message =
        outcome === "applied-restart-required"
          ? `${params.mode} persisted and updated the active Gateway, but a recovery restart is required; wait for the Gateway to restart, then run config.get to confirm the active revision`
          : outcome === "restart-pending"
            ? `${params.mode} persisted and was accepted for restart; wait for the Gateway to restart, then run config.get to confirm the active revision`
            : `${params.mode} persisted but was not applied to the active Gateway (${outcome}); run config.get, then use config.apply to reapply the saved config or restart the Gateway`;
      params.respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, message, {
          details: { persistedConfig },
        }),
      );
      writeResult.queueFollowUp();
      return;
    }
  }
  const noopReload = isNoopGatewayReloadPlan(
    buildGatewayReloadPlan(changedPaths, {
      previousConfig: snapshot.config,
      candidateConfig: params.nextConfig,
    }),
  );
  if (!noopReload) {
    invalidateGatewayRuntimeConfigSchema();
  }
  if (params.summary && noopReload) {
    params.respond(true, { ok: true, path: writeResult.path, ...persistedConfig, changedPaths });
    writeResult.queueFollowUp();
    return;
  }
  const { payload, sentinelPersisted, restart } = await resolveGatewayConfigRestartWriteResult({
    requestParams: params.requestParams,
    kind: params.mode === "config.patch" ? "config-patch" : "config-apply",
    mode: params.mode,
    configPath: writeResult.path,
    changedPaths,
    previousConfig: snapshot.config,
    nextConfig: params.nextConfig,
    actor: params.actor,
    context: params.context,
  });
  params.respond(
    true,
    {
      ok: true,
      path: writeResult.path,
      // Additive ack hash: matches the hash config.get would report for the
      // persisted bytes, so writers can adopt it without a reload.
      ...persistedConfig,
      ...(params.mode === "config.patch" ? { changedPaths } : {}),
      ...preparedSecretDegradationPayload(params.preparedSecretsSnapshot),
      restart,
      sentinel: {
        persisted: sentinelPersisted,
        payload,
      },
    },
    undefined,
  );
  writeResult.queueFollowUp();
}

async function commitGatewayConfigWriteOrRespond(
  params: Parameters<typeof commitGatewayConfigWrite>[0] & {
    respond: RespondFn;
    context: GatewayRequestContext;
  },
): Promise<Awaited<ReturnType<typeof commitGatewayConfigWrite>> | null> {
  const gateway = params.context.configRevisionProjector;
  const recoveryAtStart = configWriteRecovery.get(gateway);
  try {
    const result = await commitGatewayConfigWrite(params);
    if (configWriteRecovery.get(gateway) === recoveryAtStart) {
      configWriteRecovery.delete(gateway);
    }
    return result;
  } catch (error) {
    if (error instanceof ConfigWritePostCommitError) {
      const outcome = errorShape(
        ErrorCodes.UNAVAILABLE,
        redactToolDetail(formatErrorMessage(error)),
        {
          details: {
            publication: error.publication,
            rollbackStatus: error.rollbackStatus,
            configPath: error.configPath,
            ...(error.recoveryBackupPath !== undefined
              ? { recoveryBackupPath: error.recoveryBackupPath }
              : {}),
          },
        },
      );
      if (error.rollbackStatus !== "restored") {
        configWriteRecovery.set(gateway, { configPath: error.configPath, error: outcome });
        // A pre-publication cached read must not admit a fresh tab after this failure.
        invalidateConfigGetResponseCache();
      }
      params.respond(false, undefined, outcome);
      return null;
    }
    if (!(error instanceof ConfigMutationConflictError)) {
      throw error;
    }
    if (error.retryable) {
      invalidateConfigGetResponseCache();
    }
    // Non-retryable conflicts (e.g. path ownership) will fail the retry too;
    // only advise it when a fresh base hash can actually resolve the conflict.
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        error.retryable ? `${error.message}; re-run config.get and retry` : error.message,
      ),
    );
    return null;
  }
}

async function patchConfig(
  options: GatewayRequestHandlerOptions,
  custom?: Exclude<CustomEndpointParams, { action: "discover" }>,
) {
  const { respond, client, context } = options;
  const authority = readGatewayRequestMutationAuthority(options);
  let params: ConfigPatchParams;
  if (custom) {
    params = { raw: "{}", baseHash: custom.baseHash };
  } else {
    if (!assertValidParams(options.params, validateConfigPatchParams, "config.patch", respond)) {
      return;
    }
    params = options.params;
  }
  const hashlessPatch = resolveBaseHashParam(params) === null;
  // Hash-free writes do not retry: only the client can replay fresh intent after a lost race;
  // server re-merge would replay frozen stale intent over the winner. A paused handler can still
  // commit stale state, an accepted residual instead of adding connection-liveness plumbing.
  const writeSnapshot = hashlessPatch
    ? await readConfigFileSnapshotForWrite()
    : await readConfigWriteSnapshotOrRespond(params, respond, context.configRevisionProjector);
  if (!writeSnapshot) {
    return;
  }
  const { snapshot, writeOptions } = writeSnapshot;
  const modelIdNormalizationPolicies =
    writeOptions.basePluginMetadataSnapshot?.owners.modelIdNormalizationPolicies;
  if (!snapshot.valid) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `${summarizeConfigValidationIssues(snapshot.issues)}; fix (openclaw doctor) before patching`,
        { details: { issues: snapshot.issues } },
      ),
    );
    return;
  }
  if (custom) {
    try {
      params = prepareCustomEndpointPatch(
        custom,
        snapshot.sourceConfig,
        writeOptions.basePluginMetadataSnapshot,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
      return;
    }
  }
  const parsedRes = parseConfigJson5(params.raw);
  if (!parsedRes.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, parsedRes.error));
    return;
  }
  if (!isRecord(parsedRes.parsed)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "config.patch raw must be an object"),
    );
    return;
  }
  const normalizedPatch = normalizeSubmittedConfigModelRefs(
    parsedRes.parsed as OpenClawConfig,
    modelIdNormalizationPolicies,
  );
  if (hashlessPatch && !hasHashlessPatchLwwStructure(normalizedPatch)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "config base hash required; re-run config.get and retry",
      ),
    );
    return;
  }
  const replacePaths = normalizeConfigPatchReplacePaths(params.replacePaths);
  try {
    assertNoDuplicateConfigPatchIds({
      patch: normalizedPatch,
      current: snapshot.config,
      replacePaths,
    });
  } catch (error) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
    return;
  }
  // Merge authored rows first; merging runtime rows would persist catalog defaults
  // from untouched siblings whenever an ID-keyed array changes.
  const sourceConfig = normalizeSubmittedConfigModelRefs(
    snapshot.sourceConfig,
    modelIdNormalizationPolicies,
  );
  const mergedSource = applyMergePatch(sourceConfig, normalizedPatch, {
    // Arrays with stable ids behave like maps for partial control-plane edits.
    mergeObjectArraysById: true,
    replaceArrayPaths: replacePaths,
  });
  const uiHints = loadGatewayConfigRedactionHints();
  const restoredMerge = restoreRedactedValues(mergedSource, snapshot.config, uiHints);
  if (!restoredMerge.ok) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        restoredMerge.humanReadableMessage ?? "invalid config",
      ),
    );
    return;
  }
  if (
    rejectDestructiveArrayPatchWithoutIntent({
      currentConfig: snapshot.config,
      mergedConfig: applyMergePatch(
        snapshot.config,
        createMergePatch(sourceConfig, restoredMerge.result),
      ),
      patch: normalizedPatch,
      replacePaths,
      respond,
    })
  ) {
    return;
  }
  // Patch presence is authored intent even when its value equals a runtime default.
  const restoredChangedPaths = diffConfigLeafPaths(sourceConfig, restoredMerge.result);
  if (hashlessPatch && !restoredChangedPaths.every(isHashlessPatchLwwPath)) {
    const guardedPaths = restoredChangedPaths.filter((path) => !isHashlessPatchLwwPath(path));
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `config base hash required for ${guardedPaths.join(", ")}; re-run config.get and retry with baseHash`,
      ),
    );
    return;
  }
  const actor = resolveControlPlaneActor(client);
  if (restoredChangedPaths.length === 0) {
    context?.logGateway?.info(
      `config.patch noop ${formatControlPlaneActor(actor)} (no changed paths)`,
    );
    respond(
      true,
      {
        ok: true,
        noop: true,
        changedPaths: [],
        path: resolveGatewayConfigPath(snapshot),
        ...(params.response !== "summary"
          ? { config: redactConfigObject(snapshot.config, uiHints) }
          : {}),
      },
      undefined,
    );
    return;
  }
  const validatedSubmission = validateSubmittedConfigOrRespond({
    candidate: restoredMerge.result,
    pluginMetadataSnapshot: writeOptions.basePluginMetadataSnapshot,
    respond,
  });
  if (!validatedSubmission) {
    return;
  }
  const writeConfig = validatedSubmission.validationCandidate;
  const validatedConfig = validatedSubmission.config;
  const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
    config: validatedConfig,
    respond,
  });
  if (!preparedSecretsSnapshot) {
    return;
  }
  await commitConfigRestartWrite({
    requestParams: params,
    mode: "config.patch",
    writeSnapshot: {
      ...writeSnapshot,
      writeOptions: {
        ...writeOptions,
        // The committed policy may revoke this requester before canonical reread.
        // Admit publication synchronously; retain the writer's own guards through completion.
        assertBeforePublish: () => {
          writeOptions.assertBeforePublish?.();
          authority.assertCurrent();
        },
      },
    },
    writeConfig,
    nextConfig: validatedConfig,
    actor,
    context,
    respond,
    uiHints,
    preparedSecretsSnapshot,
    summary: params.response === "summary",
  });
}

export const configHandlers: GatewayRequestHandlers = {
  "config.get": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.get", respond)) {
      return;
    }
    const gateway = context.configRevisionProjector;
    const recoveryAtStart = configWriteRecovery.get(gateway);
    const snapshot = await readConfigGetResponse({
      getHotReloadStatus: context.getConfigReloaderHotReloadStatus,
      revisionProjector: context.configRevisionProjector,
    });
    const recovery = configWriteRecovery.get(gateway);
    if (recovery?.configPath === snapshot.path) {
      // Only a read started after this failure can reconcile its recorded outcome.
      if (recovery === recoveryAtStart && snapshot.exists && snapshot.valid) {
        configWriteRecovery.delete(gateway);
      } else {
        respond(true, { ...snapshot, writeError: recovery.error }, undefined);
        return;
      }
    }
    respond(true, snapshot, undefined);
  },
  "config.schema": ({ params, respond }) => {
    if (!assertValidParams(params, validateConfigSchemaParams, "config.schema", respond)) {
      return;
    }
    respond(true, loadGatewayRuntimeConfigSchema(), undefined);
  },
  "config.schema.lookup": defineValidatedGatewayHandler(
    "config.schema.lookup",
    validateConfigSchemaLookupParams,
    ({ params, respond }) => {
      const { path } = params;
      const schema = loadGatewayRuntimeConfigSchema();
      const result = lookupConfigSchema(schema, path, resolveConfigReloadMetadata);
      if (!result) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "config schema path not found"),
        );
        return;
      }
      respond(true, result, undefined);
    },
  ),
  "config.set": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateConfigSetParams, "config.set", respond)) {
      return;
    }
    const parsed = await prepareConfigReplacementOrRespond(
      params,
      respond,
      context.configRevisionProjector,
    );
    if (!parsed) {
      return;
    }
    const { snapshot, writeOptions } = parsed.writeSnapshot;
    if (
      rejectDroppedAgentRosterEntries({
        currentConfig: snapshot.config,
        submittedConfig: parsed.config,
        respond,
      })
    ) {
      return;
    }
    const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
      config: parsed.config,
      respond,
    });
    if (!preparedSecretsSnapshot) {
      return;
    }
    const writeResult = await commitGatewayConfigWriteOrRespond({
      snapshot,
      writeOptions,
      nextConfig: parsed.writeConfig,
      context,
      respond,
    });
    if (!writeResult) {
      return;
    }
    invalidateGatewayRuntimeConfigSchema();
    respond(
      true,
      {
        ok: true,
        path: writeResult.path,
        // Writers adopt the committed revision without a reload.
        ...(writeResult.hash
          ? { hash: context.configRevisionProjector.projectRawHash(writeResult.hash) }
          : {}),
        config: redactConfigObject(writeResult.config, parsed.uiHints),
        ...preparedSecretDegradationPayload(preparedSecretsSnapshot),
      },
      undefined,
    );
    writeResult.queueFollowUp();
  },
  "config.patch": (options) => patchConfig(options),
  "config.customEndpoint": createCustomEndpointHandler(patchConfig),
  "config.apply": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateConfigApplyParams, "config.apply", respond)) {
      return;
    }
    const parsed = await prepareConfigReplacementOrRespond(
      params,
      respond,
      context.configRevisionProjector,
    );
    if (!parsed) {
      return;
    }
    const preparedSecretsSnapshot = await ensureResolvableSecretRefsOrRespond({
      config: parsed.config,
      respond,
    });
    if (!preparedSecretsSnapshot) {
      return;
    }
    const actor = resolveControlPlaneActor(client);
    await commitConfigRestartWrite({
      requestParams: params,
      mode: "config.apply",
      writeSnapshot: parsed.writeSnapshot,
      writeConfig: parsed.writeConfig,
      nextConfig: parsed.config,
      actor,
      context,
      respond,
      uiHints: parsed.uiHints,
      preparedSecretsSnapshot,
    });
  },
  "config.openFile": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateConfigGetParams, "config.openFile", respond)) {
      return;
    }
    const configPath = createConfigIO().configPath;
    const command = resolveOpenPathCommand(configPath);
    try {
      await execOpenPath(command);
      respond(true, { ok: true, path: configPath }, undefined);
    } catch (error) {
      const errorMessage = formatOpenPathError(error);
      const isHeadlessError = isHeadlessOpenPathError(error, command);
      const detailedError = isHeadlessError
        ? `Cannot open file in headless environment. File path: ${configPath}. This environment appears to lack a graphical or terminal browser handler.`
        : `Failed to open config file: ${errorMessage}`;
      context?.logGateway?.warn(
        `config.openFile failed path=${sanitizePathForLog(configPath)}: ${errorMessage}`,
      );
      respond(true, { ok: false, path: configPath, error: detailedError }, undefined);
    }
  },
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
