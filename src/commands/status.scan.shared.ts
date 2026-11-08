// This file owns the cross-command contracts reused by normal, JSON, and status-all scans.

import { existsSync } from "node:fs";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../gateway/connection-details.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui-shared.js";
import { isLoopbackGatewayUrl } from "../gateway/net.js";
import { resolveGatewayProbeTarget } from "../gateway/probe-target.js";
import type { GatewayProbeAuth, GatewayProbeResult } from "../gateway/probe.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { MemoryProviderStatus } from "../memory-host-sdk/engine-storage.js";
import { readMemorySearchManagerStatus } from "../memory-host-sdk/host/types.js";
import type { ActiveMemoryProviderResult, MemoryHealth } from "../plugins/memory-provider-types.js";
import { defaultSlotIdForKey } from "../plugins/slots.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { resolveTailscalePublishedHost } from "../shared/tailscale-status.js";
import type { MemoryPluginStatus } from "../status/memory-plugin.js";
import type { StatusSummary } from "../status/summary.js";
import { pickGatewaySelfPresence } from "./gateway-presence.js";
import { isProbeReachable } from "./gateway-status/helpers.js";
import {
  resolveStatusGatewayProbeTimeoutMs,
  type StatusGatewayProbeBudget,
} from "./status.gateway-probe-budget.js";

const memoryPresenceModuleLoader = createLazyImportLoader(async () => {
  const { loadBundledPluginPublicArtifactModuleSync } =
    await import("../plugins/public-surface-loader.js");
  return loadBundledPluginPublicArtifactModuleSync<{
    inspectMemoryIndexPresence: (databasePath: string, agentId?: string) => Promise<boolean>;
  }>({ dirName: "memory-core", artifactBasename: "status-api.js" });
});

async function hasBuiltInMemoryState(databasePath: string, agentId: string): Promise<boolean> {
  if (!existsSync(databasePath)) {
    return false;
  }
  const { inspectMemoryIndexPresence } = await memoryPresenceModuleLoader.load();
  return await inspectMemoryIndexPresence(databasePath, agentId);
}

export type MemoryStatusSnapshot =
  | (MemoryProviderStatus & { agentId: string })
  | { agentId: string; provider: string; health: MemoryHealth };

export type GatewayProbeSnapshot = {
  gatewayConnection: ReturnType<typeof buildGatewayConnectionDetailsWithResolvers>;
  remoteUrlMissing: boolean;
  gatewayMode: "local" | "remote";
  gatewayProbeAuth: GatewayProbeAuth;
  gatewayProbeAuthWarning?: string;
  gatewayProbe: GatewayProbeResult | null;
  gatewayReachable: boolean;
  /** Fresh local readiness, separate from a successful connection or a remote target. */
  localGatewayHealthy?: boolean;
  gatewaySelf: ReturnType<typeof pickGatewaySelfPresence>;
  gatewayCallOverrides?: GatewayProbeAuth & { url: string };
};

function hasExplicitMemorySearchConfig(cfg: OpenClawConfig, agentId: string): boolean {
  if (cfg.memory && Object.hasOwn(cfg.memory, "search")) {
    return true;
  }
  return listAgentEntries(cfg).some(
    (agent) =>
      normalizeAgentId(agent.id) === normalizeAgentId(agentId) &&
      agent.memory != null &&
      Object.hasOwn(agent.memory, "search"),
  );
}

/** Resolves gateway connection details, probe result, auth warnings, and call overrides. */
export async function resolveGatewayProbeSnapshot(params: {
  cfg: OpenClawConfig;
  configPath: string;
  env: NodeJS.ProcessEnv;
  opts: StatusGatewayProbeBudget & {
    all?: boolean;
    skipProbe?: boolean;
    detailLevel?: "none" | "presence" | "full";
    localStatusRpcFallback?: boolean;
    onProgress?: (phase: string) => void;
  };
}): Promise<GatewayProbeSnapshot> {
  const gatewayConnection = buildGatewayConnectionDetailsWithResolvers({
    config: params.cfg,
    configPath: params.configPath,
  });
  const { gatewayMode, mode, remoteUrlMissing } = resolveGatewayProbeTarget(params.cfg);
  const originScopedDeviceAuth =
    mode === "remote" || Boolean(process.env.OPENCLAW_GATEWAY_URL?.trim());
  const shouldProbe = params.opts.skipProbe !== true && !remoteUrlMissing;
  const gatewayProbeAuthResolution = shouldProbe
    ? await import("./status.gateway-probe.js").then(({ resolveGatewayProbeAuthResolution }) =>
        resolveGatewayProbeAuthResolution(params.cfg, params.env),
      )
    : { auth: {}, warning: undefined };
  let gatewayProbeAuthWarning = gatewayProbeAuthResolution.warning;
  const remainingTimeoutMs = () => resolveStatusGatewayProbeTimeoutMs(params.opts);
  const readiness =
    shouldProbe && remainingTimeoutMs() > 0
      ? await import("../cli/daemon-cli/diagnostic-readiness.js").then(
          ({ waitForGatewayDiagnosticReadiness }) =>
            waitForGatewayDiagnosticReadiness({
              config: params.cfg,
              timeoutMs: remainingTimeoutMs(),
              deadlineMs: params.opts.gatewayProbeDeadlineMs,
              onProgress: params.opts.onProgress,
              ...gatewayProbeAuthResolution.auth,
            }),
        )
      : undefined;
  const canDiagnose =
    readiness?.healthy ||
    readiness?.waitOutcome === "plugin-errors" ||
    readiness?.waitOutcome === "channel-errors";
  const unavailableProbe = (): GatewayProbeResult => ({
    ok: false,
    url: gatewayConnection.url,
    connectLatencyMs: null,
    error:
      readiness?.waitOutcome === "still-starting"
        ? null
        : (readiness?.probeError ??
          (remainingTimeoutMs() === 0
            ? "Gateway check budget exhausted."
            : "Gateway is unreachable")),
    ...(readiness?.waitOutcome === "still-starting"
      ? { startupPhase: readiness.startupPhase ?? "startup" }
      : {}),
    auth: { role: null, scopes: [], capability: "unknown" },
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  });
  const initialGatewayProbe: GatewayProbeResult | null =
    (readiness && !canDiagnose) || (shouldProbe && remainingTimeoutMs() === 0)
      ? unavailableProbe()
      : shouldProbe
        ? await import("../gateway/probe.js")
            .then(({ probeGateway }) => {
              const timeoutMs = remainingTimeoutMs();
              return timeoutMs === 0
                ? unavailableProbe()
                : probeGateway({
                    url: gatewayConnection.url,
                    config: params.cfg,
                    originScopedDeviceAuth,
                    configuredRemote: gatewayConnection.urlSource === "config gateway.remote.url",
                    auth: gatewayProbeAuthResolution.auth,
                    env: params.env,
                    timeoutMs,
                    detailLevel: params.opts.detailLevel ?? "presence",
                  });
            })
            .catch(() => null)
        : null;
  const fallbackBudget = {
    timeoutMs: remainingTimeoutMs(),
    gatewayProbeDeadlineMs: params.opts.gatewayProbeDeadlineMs,
  };
  let gatewayProbe = initialGatewayProbe;
  // Only retry ambiguous local loopback probes, never remote or origin-scoped endpoints.
  if (
    !originScopedDeviceAuth &&
    params.opts.localStatusRpcFallback !== false &&
    remainingTimeoutMs() > 0 &&
    (!readiness || canDiagnose) &&
    gatewayMode === "local" &&
    gatewayProbe &&
    !gatewayProbe.ok &&
    isLoopbackGatewayUrl(gatewayConnection.url)
  ) {
    const error = gatewayProbe.error?.toLowerCase() ?? "";
    if (error.includes("timeout") || gatewayProbe.auth?.capability === "unknown") {
      // Status can succeed after an ambiguous detail-probe handshake, within the same budget.
      const status = await import("../gateway/call.js")
        .then(({ callGateway }) => {
          const timeoutMs = Math.min(2000, resolveStatusGatewayProbeTimeoutMs(fallbackBudget));
          if (timeoutMs === 0) {
            return null;
          }
          return callGateway<Partial<StatusSummary>>({
            config: params.cfg,
            configPath: params.configPath,
            method: "status",
            params: { includeChannelSummary: false, includeCliProjection: true },
            token: gatewayProbeAuthResolution.auth.token,
            password: gatewayProbeAuthResolution.auth.password,
            timeoutMs,
            mode: GATEWAY_CLIENT_MODES.BACKEND,
            clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
          });
        })
        .catch(() => null);
      if (status) {
        const auth = gatewayProbe.auth;
        gatewayProbe = {
          ...gatewayProbe,
          ok: true,
          status,
          ...(auth
            ? {
                auth: auth.capability === "unknown" ? { ...auth, capability: "read_only" } : auth,
              }
            : {}),
        };
      }
    }
  }
  if (gatewayProbeAuthWarning && gatewayProbe?.ok === false && !gatewayProbe.startupPhase) {
    gatewayProbe.error = gatewayProbe.error
      ? `${gatewayProbe.error}; ${gatewayProbeAuthWarning}`
      : gatewayProbeAuthWarning;
    gatewayProbeAuthWarning = undefined;
  }
  const gatewayReachable = gatewayProbe ? isProbeReachable(gatewayProbe) : false;
  const gatewaySelf = gatewayProbe?.presence
    ? pickGatewaySelfPresence(gatewayProbe.presence)
    : null;
  return {
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbeAuth: gatewayProbeAuthResolution.auth,
    gatewayProbeAuthWarning,
    gatewayProbe,
    gatewayReachable,
    localGatewayHealthy:
      readiness?.healthy === true &&
      !readiness.activatedPluginErrors?.length &&
      !readiness.channelProbeErrors?.length &&
      gatewayProbe?.ok === true,
    gatewaySelf,
    ...(remoteUrlMissing
      ? {
          // Remote-url-missing reports use local fallback URL for follow-up diagnostic calls.
          gatewayCallOverrides: {
            url: gatewayConnection.url,
            token: gatewayProbeAuthResolution.auth.token,
            password: gatewayProbeAuthResolution.auth.password,
          },
        }
      : {}),
  };
}

/** Builds the published Tailscale HTTPS Control UI URL when exposure is enabled. */
export function buildTailscaleHttpsUrl(params: {
  tailscaleMode: string;
  tailscaleDns: string | null;
  controlUiBasePath?: string;
}): string | null {
  const host = resolveTailscalePublishedHost({
    tailscaleMode: params.tailscaleMode,
    tailnetHost: params.tailscaleDns,
  });
  return params.tailscaleMode !== "off" && host
    ? `https://${host}${normalizeControlUiBasePath(params.controlUiBasePath)}`
    : null;
}

/** Resolves memory provider status without creating default stores just for status output. */
export async function resolveSharedMemoryStatusSnapshot(params: {
  cfg: OpenClawConfig;
  agentStatus: { defaultId?: string | null };
  memoryPlugin: MemoryPluginStatus;
  resolveMemoryConfig: (
    cfg: OpenClawConfig,
    agentId: string,
  ) => { store: { databasePath: string } } | null;
  /** Whether the selected slot owner registers the provider-neutral runtime. */
  isMemoryProviderNative?: (params: { cfg: OpenClawConfig; agentId: string }) => boolean;
  getMemoryProvider?: (params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose: "status";
    context: {
      authority: { kind: "host"; operation: "status" };
      assertCurrent(): void;
    };
  }) => Promise<ActiveMemoryProviderResult>;
  requireDefaultDatabasePath?: (agentId: string) => string | null;
}): Promise<MemoryStatusSnapshot | null> {
  const { cfg, agentStatus, memoryPlugin } = params;
  if (!memoryPlugin.enabled || !memoryPlugin.slot) {
    return null;
  }
  const agentId = agentStatus.defaultId;
  if (!agentId) {
    // Memory is agent-scoped. An explicit fleet has no default owner, so status must not
    // inspect an arbitrary first agent's database merely to populate a read-only summary.
    return null;
  }

  if (memoryPlugin.slot !== defaultSlotIdForKey("memory")) {
    // Non-default memory slots are plugin-owned; a native provider reports its health,
    // and a legacy runtime's manager reports status instead of checking built-in files.
    if (params.isMemoryProviderNative?.({ cfg, agentId })) {
      return await resolveProviderStatusSnapshot(params, agentId, memoryPlugin.slot);
    }
    return await resolveMemoryManagerStatusSnapshot(cfg, agentId);
  }

  const hasExplicitConfig = hasExplicitMemorySearchConfig(cfg, agentId);
  const defaultDatabasePath = params.requireDefaultDatabasePath?.(agentId);
  if (
    defaultDatabasePath &&
    !hasExplicitConfig &&
    !(await hasBuiltInMemoryState(defaultDatabasePath, agentId))
  ) {
    // Avoid instantiating built-in memory for users who never created the default store.
    return null;
  }
  const resolvedMemory = params.resolveMemoryConfig(cfg, agentId);
  if (!resolvedMemory) {
    return null;
  }
  const shouldInspectStore =
    hasExplicitConfig || (await hasBuiltInMemoryState(resolvedMemory.store.databasePath, agentId));
  if (!shouldInspectStore) {
    return null;
  }
  return await resolveMemoryManagerStatusSnapshot(cfg, agentId);
}

async function resolveProviderStatusSnapshot(
  params: {
    cfg: OpenClawConfig;
    getMemoryProvider?: Parameters<
      typeof resolveSharedMemoryStatusSnapshot
    >[0]["getMemoryProvider"];
  },
  agentId: string,
  slot: string,
): Promise<MemoryStatusSnapshot> {
  let provider: ActiveMemoryProviderResult["provider"] = null;
  try {
    const acquired = await params.getMemoryProvider?.({
      cfg: params.cfg,
      agentId,
      purpose: "status",
      context: {
        authority: { kind: "host", operation: "status" },
        assertCurrent() {},
      },
    });
    provider = acquired?.provider ?? null;
    const providerId = acquired?.providerId ?? slot;
    const health = provider
      ? await provider.health()
      : { status: "unavailable" as const, message: acquired?.error ?? "provider unavailable" };
    return { agentId, provider: providerId, health };
  } catch (error) {
    return {
      agentId,
      provider: slot,
      health: { status: "unavailable", message: String(error) },
    };
  } finally {
    await provider?.close().catch(() => {});
  }
}

async function resolveMemoryManagerStatusSnapshot(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<MemoryStatusSnapshot | null> {
  const { getMemorySearchManager } = await import("./status.scan.deps.runtime.js");
  const { manager } = await getMemorySearchManager({
    cfg,
    agentId,
    purpose: "status",
    inspectSources: true,
  });
  if (!manager) {
    return null;
  }
  try {
    let probeFailure: { storeProbe: boolean; error: unknown } | undefined;
    try {
      const currentStatus = await readMemorySearchManagerStatus(manager);
      if (currentStatus.backend === "builtin" && manager.probeVectorStoreAvailability) {
        // Built-in vector store has a store-level probe that avoids conflating index absence with plugin failure.
        await manager.probeVectorStoreAvailability().catch((error: unknown) => {
          probeFailure = { storeProbe: true, error };
        });
      } else {
        await manager.probeVectorAvailability().catch((error: unknown) => {
          probeFailure = { storeProbe: false, error };
        });
      }
    } catch {}
    const status = await readMemorySearchManagerStatus(manager);
    if (probeFailure && status.vector) {
      // A rejected probe leaves pre-probe facts in place. Semantic vectors are served from the
      // store, but a semantic probe failure says nothing about the store itself.
      return {
        agentId,
        ...status,
        vector: {
          ...status.vector,
          ...(probeFailure.storeProbe ? { storeAvailable: false } : {}),
          semanticAvailable: false,
          available: false,
          loadError: formatErrorMessage(probeFailure.error),
        },
      };
    }
    return { agentId, ...status };
  } finally {
    // Status probes must not leak plugin resources such as SQLite handles.
    await manager.close?.().catch(() => {});
  }
}
