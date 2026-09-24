// Read-only service, listener, and Gateway identity inspection.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayServiceProbeHosts } from "../../daemon/gateway-service-probe-hosts.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayService } from "../../daemon/service.js";
import type { PluginHealthErrorSummary } from "../../gateway/health/types.js";
import type { ConfiguredGatewayLocalProbe } from "../../gateway/local-http-probe.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import { classifyPortListener } from "../../infra/ports-format.js";
import { inspectPortUsage } from "../../infra/ports-inspect.js";
import type { PortUsage } from "../../infra/ports-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import type { OpenClawStateSchemaReadAdmission } from "../../state/openclaw-state-db-contract.js";
import type { GatewayRestartDeadline } from "./restart-health-deadline.js";
import {
  confirmGatewayReachable,
  readGatewayStartupPhase,
  type GatewayReachability,
  type GatewayRestartProbeContext,
} from "./restart-health-probe.js";
import { finalizeGatewayRestartSnapshot } from "./restart-health-snapshot.js";
import type { GatewayRestartSnapshot } from "./restart-health.types.js";
import { hasListenerAttributionGap, listenerOwnedByRuntimePid } from "./restart-port-ownership.js";

export async function inspectGatewayRestart(params: {
  service: Pick<GatewayService, "readCommand" | "readRuntime">;
  port: number;
  env?: NodeJS.ProcessEnv;
  expectedVersion?: string | null;
  expectedBuildId?: string | null;
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission;
  requirePluginHealth?: boolean;
  probeContext?: GatewayRestartProbeContext;
  configuredProbe?: ConfiguredGatewayLocalProbe;
  probeHosts?: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  deadline?: GatewayRestartDeadline;
  phase?: string;
}): Promise<GatewayRestartSnapshot> {
  const signal = params.deadline?.signal ?? params.signal;
  signal?.throwIfAborted();
  const read = <T>(phase: string, operation: () => Promise<T>) =>
    params.deadline
      ? params.deadline.read(`${params.phase ?? "inspection"}:${phase}`, operation)
      : operation();
  const startedAtMs = performance.now();
  const remainingTimeoutMs = () =>
    params.deadline
      ? Math.max(1, params.deadline.remainingMs())
      : params.timeoutMs === undefined
        ? undefined
        : Math.max(1, params.timeoutMs - (performance.now() - startedAtMs));
  const env = params.env ?? process.env;
  const probeHosts =
    params.probeHosts ??
    (await read("probe-hosts", async () => {
      const command = await read(
        "service-command",
        async () =>
          (await params.service.readCommand?.(env).catch((error: unknown) => {
            if (hasCommandProcessCleanupError(error)) {
              throw error;
            }
            return null;
          })) ?? null,
      );
      return resolveGatewayServiceProbeHosts({ env, command });
    }));
  const expectedVersion = normalizeOptionalString(params.expectedVersion);
  const expectedBuildId = normalizeOptionalString(params.expectedBuildId);
  const requiresGatewayProbe = Boolean(
    expectedVersion || expectedBuildId || params.requirePluginHealth === false,
  );
  let reachability: GatewayReachability | null = null;
  let probeError: string | undefined;
  let gatewayBootId: string | undefined;
  let gatewayVersion: string | null | undefined;
  let gatewayBuildId: string | null | undefined;
  let activatedPluginErrors: PluginHealthErrorSummary[] = [];
  let unavailablePlugins: GatewayReachability["unavailablePlugins"] = [];
  let channelProbeErrors: Array<{ id: string; error: string }> = [];
  const loadReachability = async () => {
    if (!reachability) {
      reachability = await read("gateway-health", () =>
        confirmGatewayReachable({
          port: params.port,
          ...params.probeContext,
          ...(params.configuredProbe ? { configuredProbe: params.configuredProbe } : {}),
          env,
          timeoutMs: remainingTimeoutMs(),
          ...(signal ? { signal } : {}),
        }),
      );
      probeError = reachability.probeError;
      gatewayBootId = reachability.gatewayBootId;
      gatewayVersion = reachability.gatewayVersion;
      gatewayBuildId = reachability.gatewayBuildId;
      activatedPluginErrors = reachability.activatedPluginErrors;
      unavailablePlugins = reachability.unavailablePlugins;
      channelProbeErrors = reachability.channelProbeErrors;
    }
    return reachability;
  };
  let runtime: GatewayServiceRuntime;
  try {
    runtime = await read("service-runtime", () =>
      params.timeoutMs === undefined && !params.deadline
        ? params.service.readRuntime(env)
        : params.service.readRuntime(env, { timeoutMs: remainingTimeoutMs() }),
    );
  } catch (err) {
    if (hasCommandProcessCleanupError(err)) {
      throw err;
    }
    signal?.throwIfAborted();
    runtime = { status: "unknown", detail: String(err) };
  }

  signal?.throwIfAborted();
  let portUsage: PortUsage;
  try {
    portUsage = await read("port-inspection", () =>
      inspectPortUsage(params.port, {
        probeHosts,
        ...(signal ? { signal } : {}),
      }),
    );
  } catch (err) {
    if (hasCommandProcessCleanupError(err)) {
      throw err;
    }
    signal?.throwIfAborted();
    portUsage = {
      port: params.port,
      status: "unknown",
      listeners: [],
      hints: [],
      errors: [String(err)],
    };
  }

  signal?.throwIfAborted();
  const configuredProbe = params.configuredProbe;
  const startupPhase =
    portUsage.status === "busy" && configuredProbe
      ? await read("startup-health", () =>
          readGatewayStartupPhase({
            configuredProbe,
            port: params.port,
            timeoutMs: remainingTimeoutMs(),
            ...(signal ? { signal } : {}),
          }),
        )
      : undefined;
  if (startupPhase && (expectedVersion || expectedBuildId)) {
    // Startup cannot conceal a previous install or a definitive plugin/channel failure.
    await loadReachability();
  }
  if (!startupPhase && portUsage.status === "busy" && runtime.status !== "running") {
    const reachable = await loadReachability();
    if (reachable.reachable) {
      return finalizeGatewayRestartSnapshot(
        {
          runtime,
          portUsage,
          healthy: true,
          staleGatewayPids: [],
          gatewayVersion: reachable.gatewayVersion,
          ...(reachable.gatewayBootId ? { gatewayBootId: reachable.gatewayBootId } : {}),
          gatewayBuildId: reachable.gatewayBuildId,
          ...(reachable.activatedPluginErrors.length > 0
            ? { activatedPluginErrors: reachable.activatedPluginErrors }
            : {}),
          ...(reachable.unavailablePlugins.length > 0
            ? { unavailablePlugins: reachable.unavailablePlugins }
            : {}),
          ...(reachable.channelProbeErrors.length > 0
            ? { channelProbeErrors: reachable.channelProbeErrors }
            : {}),
        },
        expectedVersion,
        expectedBuildId,
        params.requirePluginHealth !== false,
      );
    }
  }

  const gatewayListeners =
    portUsage.status === "busy"
      ? portUsage.listeners.filter(
          (listener) => classifyPortListener(listener, params.port) === "gateway",
        )
      : [];
  const running = runtime.status === "running";
  const runtimePid = runtime.pid;
  const listenerAttributionGap = hasListenerAttributionGap(portUsage);
  const ownsPort =
    runtimePid != null
      ? portUsage.listeners.some((listener) =>
          listenerOwnedByRuntimePid({ listener, runtimePid }),
        ) || listenerAttributionGap
      : gatewayListeners.length > 0 || listenerAttributionGap;
  let healthy = running && ownsPort && !startupPhase;
  if (requiresGatewayProbe && healthy && portUsage.status === "busy") {
    const reachable = await loadReachability();
    healthy = reachable.reachable;
  }
  if (
    !healthy &&
    !startupPhase &&
    running &&
    portUsage.status === "busy" &&
    !requiresGatewayProbe
  ) {
    const reachable = await loadReachability();
    healthy = reachable.reachable;
  }
  // Read after probes: an owner can acquire the coordinator while health is unavailable.
  const owner =
    portUsage.status === "busy"
      ? readGatewayOwnerLease({
          env,
          port: params.port,
          ...(params.openStateSchemaReadAdmission
            ? { openStateSchemaReadAdmission: params.openStateSchemaReadAdmission }
            : {}),
        })
      : undefined;
  // A recorded owner is never stale by PID inference; other listeners are foreign.
  // 2026.9.3 Gateways have no row and retain the installed-runtime ownership path.
  const staleGatewayPids = owner
    ? []
    : Array.from(
        new Set(
          gatewayListeners.flatMap((listener) =>
            typeof listener.pid === "number" &&
            Number.isFinite(listener.pid) &&
            (!running ||
              (runtimePid != null && !listenerOwnedByRuntimePid({ listener, runtimePid })))
              ? [listener.pid]
              : [],
          ),
        ),
      );

  return finalizeGatewayRestartSnapshot(
    {
      runtime,
      portUsage,
      healthy,
      staleGatewayPids,
      ...(gatewayBootId ? { gatewayBootId } : {}),
      ...(gatewayVersion !== undefined ? { gatewayVersion } : {}),
      ...(gatewayBuildId !== undefined ? { gatewayBuildId } : {}),
      ...(startupPhase ? { startupPhase } : {}),
      ...(probeError ? { probeError } : {}),
      ...(activatedPluginErrors.length ? { activatedPluginErrors } : {}),
      ...(unavailablePlugins.length ? { unavailablePlugins } : {}),
      ...(channelProbeErrors.length ? { channelProbeErrors } : {}),
    },
    expectedVersion,
    expectedBuildId,
    params.requirePluginHealth !== false,
  );
}
