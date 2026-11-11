import { isDeepStrictEqual } from "node:util";
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  createConfigIO,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
  resolveConfigSnapshotHash,
} from "../../config/config.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import { invalidateGatewayRuntimeConfigSchema } from "../../config/runtime-schema.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
  type RuntimeConfigWriteApplicationStatus,
} from "../../config/runtime-write-application.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewayRestart } from "../../infra/restart.js";
import { redactToolDetail } from "../../logging/redact.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { captureGatewayRootWorkAdmissionContinuationScope } from "../../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { isRecord } from "../../utils.js";
import { resolveGatewayAuth } from "../auth.js";
import { diffGatewayReloadPaths } from "../config-diff.js";
import {
  buildGatewayReloadPlan,
  isNoopGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "../config-reload-plan.js";
import { resolveGatewayReloadSettings } from "../config-reload-settings.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { resolveSharedGatewaySessionGeneration } from "../server/ws-shared-generation.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type ConfigWriteSnapshot = Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>["snapshot"];
type ConfigWriteOptions = Awaited<
  ReturnType<typeof readConfigFileSnapshotForWrite>
>["writeOptions"];

export function resolveGatewayConfigPath(snapshot?: Pick<ConfigWriteSnapshot, "path">): string {
  return snapshot?.path ?? createConfigIO().configPath;
}

/** Compares the effective shared Gateway auth surface that active clients use. */
export function didSharedGatewayAuthChange(prev: OpenClawConfig, next: OpenClawConfig): boolean {
  const prevResolvedAuth = resolveGatewayAuth({
    authConfig: prev.gateway?.auth,
    env: process.env,
    tailscaleMode: prev.gateway?.tailscale?.mode,
  });
  const nextResolvedAuth = resolveGatewayAuth({
    authConfig: next.gateway?.auth,
    env: process.env,
    tailscaleMode: next.gateway?.tailscale?.mode,
  });
  return (
    prevResolvedAuth.mode !== nextResolvedAuth.mode ||
    // Proxy policy writes reconcile each principal instead of rotating a shared credential.
    (prevResolvedAuth.mode !== "trusted-proxy" &&
      resolveSharedGatewaySessionGeneration(prevResolvedAuth, prev.gateway?.trustedProxies) !==
        resolveSharedGatewaySessionGeneration(nextResolvedAuth, next.gateway?.trustedProxies))
  );
}

// Active secrets snapshots own authored leaves, while runtime config can add fixed siblings.
// Project only matching authored values so stale snapshots cannot drive disconnect decisions.
function projectAuthoredValuesOntoRuntimeOverlay(params: {
  source: unknown;
  activeSource: unknown;
  active: unknown;
  fallback: unknown;
}): unknown {
  const { source, active } = params;
  if (active === undefined) {
    return structuredClone(params.fallback);
  }
  if (!isRecord(source) || !isRecord(active)) {
    return structuredClone(
      isDeepStrictEqual(source, params.activeSource) ? active : params.fallback,
    );
  }
  const fallback = isRecord(params.fallback) ? params.fallback : {};
  const activeSource = isRecord(params.activeSource) ? params.activeSource : {};
  const sourceKeys = new Set(Object.keys(source));
  return Object.fromEntries([
    ...Object.entries(fallback).filter(([key]) => !sourceKeys.has(key)),
    ...Object.keys(source).map((key) => [
      key,
      projectAuthoredValuesOntoRuntimeOverlay({
        source: source[key],
        activeSource: activeSource[key],
        active: active[key],
        fallback: fallback[key],
      }),
    ]),
  ]);
}

/** Compares against the active secrets-expanded config when one is available. */
export function didActiveSharedGatewayAuthChange(params: {
  fallbackPrev: OpenClawConfig;
  fallbackSource?: OpenClawConfig;
  next: OpenClawConfig;
}): boolean {
  const active = getActiveSecretsRuntimeSnapshotState();
  if (!active) {
    return didSharedGatewayAuthChange(params.fallbackPrev, params.next);
  }
  const currentSourceGateway = (params.fallbackSource ?? active.sourceConfig).gateway;
  const activeSourceGateway = active.sourceConfig.gateway;
  const activeGateway = active.config.gateway;
  const fallbackGateway = params.fallbackPrev.gateway;
  const selectOwnedGatewayValue = <Key extends "auth" | "tailscale" | "trustedProxies">(
    key: Key,
  ): NonNullable<OpenClawConfig["gateway"]>[Key] =>
    currentSourceGateway && Object.hasOwn(currentSourceGateway, key)
      ? (projectAuthoredValuesOntoRuntimeOverlay({
          source: currentSourceGateway[key],
          activeSource: activeSourceGateway?.[key],
          active: activeGateway?.[key],
          fallback: fallbackGateway?.[key],
        }) as NonNullable<OpenClawConfig["gateway"]>[Key])
      : fallbackGateway?.[key];
  const activeSharedAuthConfig: OpenClawConfig = {
    ...params.fallbackPrev,
    gateway: {
      ...fallbackGateway,
      // Secrets snapshots only own authored leaves; retain runtime-only auth siblings.
      auth: selectOwnedGatewayValue("auth"),
      tailscale: selectOwnedGatewayValue("tailscale"),
      trustedProxies: selectOwnedGatewayValue("trustedProxies"),
    },
  };
  return didSharedGatewayAuthChange(activeSharedAuthConfig, params.next);
}

function resolveConfigRestartRequirement(params: {
  changedPaths: string[];
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  /** Offline-write semantics: under reload off, persist and leave the restart to the operator. */
  deferRestartWhenReloadOff?: boolean;
}): { requiresRestart: boolean; scheduleDirectRestart: boolean } {
  const reloadSettings = resolveGatewayReloadSettings(params.nextConfig);
  const plan = buildGatewayReloadPlan(params.changedPaths, {
    previousConfig: params.previousConfig,
    candidateConfig: params.nextConfig,
  });
  const requiresRestart =
    !isNoopGatewayReloadPlan(plan) && (reloadSettings.mode === "off" || plan.restartGateway);
  return {
    requiresRestart,
    scheduleDirectRestart:
      requiresRestart && reloadSettings.mode === "off" && !params.deferRestartWhenReloadOff,
  };
}

/**
 * `openclaw config set/patch/unset` route here while a Gateway owns the state and keep the
 * offline write's outcomes. Stable Gateways close the request schema, so the connection
 * identity carries this rather than a request field.
 */
function isCliRoutedConfigPatch(
  mode: string,
  client: Parameters<typeof resolveControlPlaneActor>[0],
): boolean {
  const cli = client?.connect?.client;
  return (
    mode === "config.patch" &&
    cli?.id === GATEWAY_CLIENT_NAMES.CLI &&
    cli.mode === GATEWAY_CLIENT_MODES.CLI
  );
}

/**
 * Responds when an awaited runtime application did not fully apply, and reports whether it
 * did. A CLI-routed write keeps the offline outcome: persisted and restarting is success.
 */
export function respondConfigWriteApplicationOutcome(params: {
  outcome: RuntimeConfigWriteApplicationStatus;
  mode: "config.set" | "config.patch" | "config.apply";
  client: Parameters<typeof resolveControlPlaneActor>[0];
  respond: RespondFn;
  success: Record<string, unknown>;
  persistedConfig: Record<string, unknown>;
}): boolean {
  const { outcome, mode } = params;
  if (outcome === "applied") {
    return false;
  }
  if (outcome === "restart-pending" && isCliRoutedConfigPatch(mode, params.client)) {
    params.respond(true, { ...params.success, restartPending: true }, undefined);
    return true;
  }
  const deferred =
    typeof outcome === "object"
      ? {
          ...outcome,
          reason: redactToolDetail(outcome.reason),
          appliesWhen: redactToolDetail(outcome.appliesWhen),
        }
      : undefined;
  const status = typeof outcome === "object" ? outcome.status : outcome;
  const message = deferred
    ? `${mode} saved but deferred: ${deferred.reason} ${deferred.appliesWhen}`
    : outcome === "applied-restart-required"
      ? `${mode} persisted and updated the active Gateway, but a recovery restart is required; wait for the Gateway to restart, then run config.get to confirm the active revision`
      : outcome === "restart-pending"
        ? `${mode} persisted and was accepted for restart; wait for the Gateway to restart, then run config.get to confirm the active revision`
        : `${mode} persisted but was not applied to the active Gateway (${status}); run config.get, then use config.apply to reapply the saved config or restart the Gateway`;
  params.respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, message, {
      details: {
        persistedConfig: params.persistedConfig,
        ...(deferred ? { application: deferred } : {}),
      },
    }),
  );
  return true;
}

/** Returns whether a managed config write can settle without restarting the Gateway. */
export function shouldAwaitGatewayConfigApplication(params: {
  changedPaths?: string[];
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
}): boolean {
  // With reload off the reloader persists non-plugin changes unapplied, so an awaited
  // application could only report failure; the write applies at the next restart.
  return (
    resolveGatewayReloadSettings(params.nextConfig).mode !== "off" &&
    !resolveConfigRestartRequirement({
      ...params,
      changedPaths:
        params.changedPaths ??
        diffGatewayReloadPaths(
          params.previousConfig,
          params.nextConfig,
          listConfigReloadRefinementPrefixes(),
        ),
    }).requiresRestart
  );
}

type ModelRouteFields = Partial<Record<"model" | "models" | "subagents" | "heartbeat", unknown>>;
const pickModelRouteKeys = (value: ModelRouteFields | undefined) => [
  value?.model,
  value?.models,
  value?.subagents,
  value?.heartbeat,
];

/** The config inputs a billing route depends on; workspace, tools, and identity edits are not. */
function billingRouteInputs(cfg: OpenClawConfig) {
  return {
    models: cfg.models,
    auth: cfg.auth,
    // A required cloud worker profile forces the embedded runtime for every model.
    requiredProfile: cfg.cloudWorkers?.requiredProfile,
    defaults: pickModelRouteKeys(cfg.agents?.defaults),
    entries: Object.entries(cfg.agents?.entries ?? {}).map(([id, entry]) => [
      id,
      pickModelRouteKeys(entry),
    ]),
    refs: collectConfiguredModelRefs(cfg),
  };
}

/**
 * Names model consumers whose billing route (API key, subscription, or a CLI runtime's own
 * login) the committed write moved. Advisory: the write already succeeded, so a comparison
 * failure is logged and never fails the response.
 */
async function collectConfigWriteBillingRouteWarnings(params: {
  before: OpenClawConfig | undefined;
  after: OpenClawConfig;
  context?: GatewayRequestContext;
}): Promise<string[]> {
  // A first write has no source config yet.
  const before = params.before ?? {};
  const { after } = params;
  try {
    // Most writes touch no model or credential input; skip the auth-store reads for them.
    if (isDeepStrictEqual(billingRouteInputs(before), billingRouteInputs(after))) {
      return [];
    }
    const { collectModelBillingRouteMigrationWarnings } =
      await import("../../commands/doctor/shared/model-billing-route-migration.js");
    const warnings = collectModelBillingRouteMigrationWarnings({
      before,
      after,
      // The published snapshot can predate this write's plugin changes; a write that also
      // installs or removes a provider plugin may compare that provider's refs without it.
      metadataSnapshot: getCurrentPluginMetadataSnapshot({ config: after }),
    });
    // The success reply logs these; an error reply means the write moved nothing.
    return warnings;
  } catch (error) {
    params.context?.logGateway?.warn(`billing route comparison skipped: ${String(error)}`);
    return [];
  }
}

/**
 * Success replies carry and log the write's billing-route warnings. Error replies, including a
 * write that persisted but was not applied, moved no route and stay unchanged.
 */
export function replyWithBillingRouteWarnings(
  respond: RespondFn | undefined,
  warnings: readonly string[],
  context: GatewayRequestContext | undefined,
): RespondFn {
  return (...args) => {
    const [ok, payload] = args;
    if (ok && warnings.length > 0 && isRecord(payload)) {
      for (const warning of warnings) {
        context?.logGateway?.warn(warning);
      }
      args[1] = { ...payload, billingRouteWarnings: warnings };
    }
    // Forward the caller's exact arguments; responders and tests observe their arity.
    respond?.(...args);
  };
}

/** Persists a gateway config write and returns follow-up work that must run after response. */
export async function commitGatewayConfigWrite(params: {
  snapshot: ConfigWriteSnapshot;
  writeOptions: ConfigWriteOptions;
  nextConfig: OpenClawConfig;
  context?: GatewayRequestContext;
  disconnectSharedAuthClients?: boolean;
  awaitRuntimeApplication?: boolean;
  respond?: RespondFn;
}) {
  const previousRuntimeConfig =
    params.context?.getCommittedRuntimeConfig?.() ?? params.snapshot.config;
  const application = params.awaitRuntimeApplication
    ? createRuntimeConfigWriteApplication(captureGatewayRootWorkAdmissionContinuationScope()?.run)
    : undefined;
  holdGatewayPolicyResponse(params.respond);
  const result = await replaceConfigFile({
    sourceConfig: params.nextConfig,
    // The early RPC hash check is only advisory until this lock-time CAS. Without
    // it, concurrent writers can both succeed and overwrite each other's config.
    baseHash: resolveConfigSnapshotHash(params.snapshot) ?? undefined,
    writeOptions: attachRuntimeConfigWriteApplication<ConfigWriteOptions>(
      {
        ...params.writeOptions,
        auditOrigin: "config-rpc",
        runtimeRefresh: {
          ...params.writeOptions.runtimeRefresh,
          includeAuthStoreRefs: false,
        },
      },
      application,
    ),
    afterWrite: { mode: "auto" },
  });
  const billingRouteWarnings = await collectConfigWriteBillingRouteWarnings({
    before: params.snapshot.sourceConfig,
    after: params.nextConfig,
    context: params.context,
  });
  return {
    path: resolveGatewayConfigPath(params.snapshot),
    config: result.nextConfig,
    ...(billingRouteWarnings.length > 0 ? { billingRouteWarnings } : {}),
    reply: replyWithBillingRouteWarnings(params.respond, billingRouteWarnings, params.context),
    // Acknowledge this commit; a later config.get can observe an external edit.
    hash: result.persistedHash,
    ...(application
      ? {
          application: application.claimed
            ? application.result
            : Promise.resolve<RuntimeConfigWriteApplicationStatus>("unclaimed"),
        }
      : {}),
    queueFollowUp: () => {
      // A claimed receipt owns publication and rollback. Unmanaged writes still
      // reconcile after responding, including receipts no runtime owner claimed.
      if (!application?.claimed) {
        queueMicrotask(() => {
          params.context?.enforceSharedGatewayAuthGenerationForConfigWrite?.(
            result.nextConfig,
            previousRuntimeConfig,
          );
          if (params.disconnectSharedAuthClients) {
            params.context?.disconnectClientsUsingSharedGatewayAuth?.();
          }
        });
      }
    },
  };
}

/** Complete a saved configuration write only after its runtime owner reports the outcome. */
export async function finishGatewayConfigWrite(params: {
  write: Awaited<ReturnType<typeof commitGatewayConfigWrite>>;
  context: GatewayRequestContext;
  client: Parameters<typeof resolveControlPlaneActor>[0];
  uiHints: Parameters<typeof redactConfigObject>[1];
  successDetails: Record<string, unknown>;
}): Promise<void> {
  const { write } = params;
  invalidateGatewayRuntimeConfigSchema();
  const persistedConfig = {
    ...(write.hash
      ? { hash: params.context.configRevisionProjector.projectRawHash(write.hash) }
      : {}),
    config: redactConfigObject(write.config, params.uiHints),
  };
  if (
    !write.application ||
    !respondConfigWriteApplicationOutcome({
      outcome: await write.application,
      mode: "config.set",
      client: params.client,
      respond: write.reply,
      success: {},
      persistedConfig,
    })
  ) {
    write.reply(
      true,
      { ok: true, path: write.path, ...persistedConfig, ...params.successDetails },
      undefined,
    );
  }
  write.queueFollowUp();
}

export async function resolveGatewayConfigRestartWriteResult(params: {
  requestParams: unknown;
  kind: RestartSentinelPayload["kind"];
  mode: "config.patch" | "config.apply";
  configPath: string;
  changedPaths: string[];
  previousConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  client: Parameters<typeof resolveControlPlaneActor>[0];
  context?: GatewayRequestContext;
}): Promise<{
  payload: RestartSentinelPayload;
  sentinelPersisted: boolean;
  restart: ReturnType<typeof scheduleGatewayRestart> | undefined;
}> {
  const { sessionKey, note, restartDelayMs, deliveryContext, threadId } = parseRestartRequestParams(
    params.requestParams,
  );
  // Restart delivery uses generic :thread: parsing plus plugin-owned session grammars.
  const sessionDelivery = await extractDeliveryInfo(sessionKey);
  const actor = resolveControlPlaneActor(params.client);
  const restartRequirement = resolveConfigRestartRequirement({
    ...params,
    // The offline write's reload-off contract: persist, and the CLI prints a restart hint.
    // Control UI and RPC patches still restart.
    deferRestartWhenReloadOff: isCliRoutedConfigPatch(params.mode, params.client),
  });
  const payload: RestartSentinelPayload = {
    kind: params.kind,
    status: "ok",
    ts: Date.now(),
    sessionKey,
    deliveryContext: deliveryContext ?? sessionDelivery.deliveryContext,
    threadId: threadId ?? sessionDelivery.threadId,
    message: note ?? null,
    doctorHint: formatDoctorNonInteractiveHint(),
    stats: {
      mode: params.mode,
      root: params.configPath,
      requiresRestart: restartRequirement.requiresRestart,
    },
  };
  const sentinelPersisted = await writeRestartSentinel(payload).then(
    () => true,
    () => false,
  );
  const restart = restartRequirement.scheduleDirectRestart
    ? scheduleGatewayRestart({
        delayMs: restartDelayMs,
        reason: params.mode,
        audit: {
          actor: actor.actor,
          deviceId: actor.deviceId,
          clientIp: actor.clientIp,
          changedPaths: params.changedPaths,
        },
      })
    : undefined;
  if (restart?.coalesced) {
    params.context?.logGateway?.warn(
      `${params.mode} restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`,
    );
  }
  return { payload, sentinelPersisted, restart };
}
