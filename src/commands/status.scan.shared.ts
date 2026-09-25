// Shared status scan helpers for gateway probing, Tailscale URL formatting, and memory status.
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
import type { GatewayProbeResult, probeGateway as probeGatewayFn } from "../gateway/probe.js";
import type { MemoryProviderStatus } from "../memory-host-sdk/engine-storage.js";
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

const gatewayProbeModuleLoader = createLazyImportLoader(() => import("./status.gateway-probe.js"));
const probeGatewayModuleLoader = createLazyImportLoader(() => import("../gateway/probe.js"));
const gatewayCallModuleLoader = createLazyImportLoader(() => import("../gateway/call.js"));
const gatewayReadinessModuleLoader = createLazyImportLoader(
  () => import("../cli/daemon-cli/diagnostic-readiness.js"),
);
const memoryPresenceModuleLoader = createLazyImportLoader(async () => {
  const { loadBundledPluginPublicArtifactModuleSync } =
    await import("../plugins/public-surface-loader.js");
  return loadBundledPluginPublicArtifactModuleSync<{
    inspectMemoryIndexPresence: (databasePath: string) => Promise<boolean>;
  }>({ dirName: "memory-core", artifactBasename: "status-api.js" });
});

async function hasBuiltInMemoryState(databasePath: string): Promise<boolean> {
  if (!existsSync(databasePath)) {
    return false;
  }
  const { inspectMemoryIndexPresence } = await memoryPresenceModuleLoader.load();
  return await inspectMemoryIndexPresence(databasePath);
}

export type MemoryStatusSnapshot = MemoryProviderStatus & {
  agentId: string;
};

export type GatewayProbeSnapshot = {
  gatewayConnection: ReturnType<typeof buildGatewayConnectionDetailsWithResolvers>;
  remoteUrlMissing: boolean;
  gatewayMode: "local" | "remote";
  gatewayProbeAuth: {
    token?: string;
    password?: string;
  };
  gatewayProbeAuthWarning?: string;
  gatewayProbe: Awaited<ReturnType<typeof probeGatewayFn>> | null;
  gatewayReachable: boolean;
  gatewaySelf: ReturnType<typeof pickGatewaySelfPresence>;
  gatewayCallOverrides?: {
    url: string;
    token?: string;
    password?: string;
  };
};

type StatusMemorySearchManager = {
  probeVectorStoreAvailability?(): Promise<boolean>;
  probeVectorAvailability(): Promise<boolean>;
  status(): MemoryProviderStatus;
  close?(): Promise<void>;
};

type StatusMemorySearchManagerResolver = (params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose: "status";
  inspectSources: true;
}) => Promise<{
  manager: StatusMemorySearchManager | null;
}>;

function shouldTryLocalStatusRpcFallback(params: {
  gatewayMode: "local" | "remote";
  gatewayUrl: string;
  gatewayProbe: GatewayProbeResult | null;
}): params is {
  gatewayMode: "local";
  gatewayUrl: string;
  gatewayProbe: GatewayProbeResult;
} {
  // Only retry local loopback probes; remote endpoints should not receive an extra status RPC.
  if (
    params.gatewayMode !== "local" ||
    !params.gatewayProbe ||
    params.gatewayProbe.ok ||
    !isLoopbackGatewayUrl(params.gatewayUrl)
  ) {
    return false;
  }
  const error = params.gatewayProbe.error?.toLowerCase() ?? "";
  return error.includes("timeout") || params.gatewayProbe.auth?.capability === "unknown";
}

async function applyLocalStatusRpcFallback(params: {
  cfg: OpenClawConfig;
  configPath: string;
  gatewayMode: "local" | "remote";
  gatewayUrl: string;
  gatewayProbe: GatewayProbeResult | null;
  gatewayProbeAuth: {
    token?: string;
    password?: string;
  };
  timeoutMs: number;
  gatewayProbeDeadlineMs: number;
  enabled?: boolean;
}): Promise<GatewayProbeResult | null> {
  if (params.enabled === false) {
    return params.gatewayProbe;
  }
  if (!shouldTryLocalStatusRpcFallback(params)) {
    return params.gatewayProbe;
  }
  // The fallback uses the gateway status RPC because it can succeed after probe handshake ambiguity.
  const status = await gatewayCallModuleLoader
    .load()
    .then(({ callGateway }) => {
      const timeoutMs = Math.min(2000, resolveStatusGatewayProbeTimeoutMs(params));
      if (timeoutMs === 0) {
        return null;
      }
      return callGateway<Partial<StatusSummary>>({
        config: params.cfg,
        configPath: params.configPath,
        method: "status",
        token: params.gatewayProbeAuth.token,
        password: params.gatewayProbeAuth.password,
        timeoutMs,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      });
    })
    .catch(() => null);
  if (!status) {
    return params.gatewayProbe;
  }
  const auth = params.gatewayProbe.auth;
  return {
    ...params.gatewayProbe,
    ok: true,
    status,
    ...(auth
      ? {
          auth:
            auth.capability === "unknown"
              ? {
                  ...auth,
                  capability: "read_only",
                }
              : auth,
        }
      : {}),
  };
}

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
    probeWhenRemoteUrlMissing?: boolean;
    resolveAuthWhenRemoteUrlMissing?: boolean;
    mergeAuthWarningIntoProbeError?: boolean;
    localStatusRpcFallback?: boolean;
    onProgress?: (phase: string) => void;
  };
}): Promise<GatewayProbeSnapshot> {
  const gatewayConnection = buildGatewayConnectionDetailsWithResolvers({
    config: params.cfg,
    configPath: params.configPath,
  });
  const { gatewayMode, remoteUrlMissing } = resolveGatewayProbeTarget(params.cfg);
  const shouldResolveAuth =
    params.opts.skipProbe !== true &&
    (!remoteUrlMissing || params.opts.resolveAuthWhenRemoteUrlMissing === true);
  const shouldProbe =
    params.opts.skipProbe !== true &&
    (!remoteUrlMissing || params.opts.probeWhenRemoteUrlMissing === true);
  const gatewayProbeAuthResolution = shouldResolveAuth
    ? await gatewayProbeModuleLoader
        .load()
        .then(({ resolveGatewayProbeAuthResolution }) =>
          resolveGatewayProbeAuthResolution(params.cfg, params.env),
        )
    : { auth: {}, warning: undefined };
  let gatewayProbeAuthWarning = gatewayProbeAuthResolution.warning;
  const remainingTimeoutMs = () => resolveStatusGatewayProbeTimeoutMs(params.opts);
  const readiness =
    shouldProbe && remainingTimeoutMs() > 0
      ? await gatewayReadinessModuleLoader.load().then(({ waitForGatewayDiagnosticReadiness }) =>
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
            ? "Gateway probe budget exhausted."
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
        ? await probeGatewayModuleLoader
            .load()
            .then(({ probeGateway }) => {
              const timeoutMs = remainingTimeoutMs();
              return timeoutMs === 0
                ? unavailableProbe()
                : probeGateway({
                    url: gatewayConnection.url,
                    config: params.cfg,
                    auth: gatewayProbeAuthResolution.auth,
                    env: params.env,
                    timeoutMs,
                    detailLevel: params.opts.detailLevel ?? "presence",
                  });
            })
            .catch(() => null)
        : null;
  const gatewayProbe = await applyLocalStatusRpcFallback({
    cfg: params.cfg,
    configPath: params.configPath,
    gatewayMode,
    gatewayUrl: gatewayConnection.url,
    gatewayProbe: initialGatewayProbe,
    gatewayProbeAuth: gatewayProbeAuthResolution.auth,
    timeoutMs: remainingTimeoutMs(),
    gatewayProbeDeadlineMs: params.opts.gatewayProbeDeadlineMs,
    enabled:
      params.opts.localStatusRpcFallback !== false &&
      remainingTimeoutMs() > 0 &&
      (!readiness || canDiagnose),
  });
  if (
    (params.opts.mergeAuthWarningIntoProbeError ?? true) &&
    gatewayProbeAuthWarning &&
    gatewayProbe?.ok === false &&
    !gatewayProbe.startupPhase
  ) {
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
  getMemorySearchManager: StatusMemorySearchManagerResolver;
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
    // Non-default memory slots are plugin-owned; ask the manager directly instead of checking built-in files.
    return await resolveMemoryManagerStatusSnapshot(params, agentId);
  }

  const hasExplicitConfig = hasExplicitMemorySearchConfig(cfg, agentId);
  const defaultDatabasePath = params.requireDefaultDatabasePath?.(agentId);
  if (
    defaultDatabasePath &&
    !hasExplicitConfig &&
    !(await hasBuiltInMemoryState(defaultDatabasePath))
  ) {
    // Avoid instantiating built-in memory for users who never created the default store.
    return null;
  }
  const resolvedMemory = params.resolveMemoryConfig(cfg, agentId);
  if (!resolvedMemory) {
    return null;
  }
  const shouldInspectStore =
    hasExplicitConfig || (await hasBuiltInMemoryState(resolvedMemory.store.databasePath));
  if (!shouldInspectStore) {
    return null;
  }
  return await resolveMemoryManagerStatusSnapshot(params, agentId);
}

async function resolveMemoryManagerStatusSnapshot(
  params: {
    cfg: OpenClawConfig;
    getMemorySearchManager: StatusMemorySearchManagerResolver;
  },
  agentId: string,
): Promise<MemoryStatusSnapshot | null> {
  const { manager } = await params.getMemorySearchManager({
    cfg: params.cfg,
    agentId,
    purpose: "status",
    inspectSources: true,
  });
  if (!manager) {
    return null;
  }
  try {
    try {
      const currentStatus = manager.status();
      if (currentStatus.backend === "builtin" && manager.probeVectorStoreAvailability) {
        // Built-in vector store has a store-level probe that avoids conflating index absence with plugin failure.
        await manager.probeVectorStoreAvailability();
      } else {
        await manager.probeVectorAvailability();
      }
    } catch {}
    const status = manager.status();
    return { agentId, ...status };
  } finally {
    // Status probes must not leak plugin resources such as SQLite handles.
    await manager.close?.().catch(() => {});
  }
}
