import { resolveConfigPath, resolveGatewayPort, resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { isImplicitLocalGatewayTarget } from "../../gateway/call.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../../gateway/probe-auth.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import { LOOPBACK_PORT_PROBE_HOSTS } from "../../infra/ports-probe.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import { resolveGatewayRestartProbeContext } from "./restart-health-probe.js";
import { DEFAULT_RESTART_HEALTH_TIMEOUT_MS } from "./restart-health.constants.js";
import { waitForGatewayHealthyRestart, type GatewayRestartSnapshot } from "./restart-health.js";

/** Returns undefined when the original diagnostic path owns target or authentication handling. */
export async function waitForGatewayDiagnosticReadiness(opts: {
  config?: OpenClawConfig;
  timeoutMs?: number;
  deadlineMs?: number;
  url?: string;
  token?: string;
  password?: string;
  ignoreEnvUrlOverride?: boolean;
  localPortOverride?: number;
  onProgress?: (phase: string) => void;
}): Promise<GatewayRestartSnapshot | undefined> {
  if (!(await isImplicitLocalGatewayTarget(opts))) {
    return undefined;
  }
  const probeContext = opts.config
    ? {
        config: opts.config,
        auth: (
          await resolveGatewayProbeAuthSafeWithSecretInputs({
            cfg: opts.config,
            mode: "local",
            explicitAuth: { token: opts.token, password: opts.password },
          })
        ).auth,
      }
    : await resolveGatewayRestartProbeContext(process.env, {
        token: opts.token,
        password: opts.password,
      });
  if (
    !probeContext.auth?.token &&
    !probeContext.auth?.password &&
    probeContext.config.gateway?.auth?.mode !== "none"
  ) {
    return undefined;
  }
  const port = opts.localPortOverride ?? resolveGatewayPort(probeContext.config);
  const nativeService = resolveGatewayService();
  let nativeCommand: Promise<GatewayServiceCommandConfig | null> | undefined;
  return waitForGatewayHealthyRestart({
    port,
    timeoutMs: opts.timeoutMs ?? DEFAULT_RESTART_HEALTH_TIMEOUT_MS,
    deadlineMs: opts.deadlineMs,
    probeContext,
    probeHosts: LOOPBACK_PORT_PROBE_HOSTS,
    requirePluginHealth: false,
    onProgress: opts.onProgress,
    service: {
      readCommand: async () => null,
      readRuntime: async (env, options) => {
        const owner = readGatewayOwnerLease({ env, port });
        if (
          owner?.state === "live" &&
          (owner.mode === "foreground" || owner.supervisor?.kind === "external")
        ) {
          return { status: "running", pid: owner.pid };
        }
        const startedAt = performance.now();
        const command = await (nativeCommand ??= nativeService
          .readCommand(env, options)
          .catch(() => null));
        const serviceEnv = mergeGatewayServiceEnv(env, command);
        const servicePort =
          parseTcpPortFromArgs(command?.programArguments) ??
          resolveGatewayPort(probeContext.config, serviceEnv);
        if (
          !command ||
          servicePort !== port ||
          resolveStateDir(serviceEnv) !== resolveStateDir(env) ||
          resolveConfigPath(serviceEnv) !== resolveConfigPath(env)
        ) {
          return { status: "unknown" };
        }
        return nativeService.readRuntime(env, {
          ...options,
          ...(options?.timeoutMs === undefined
            ? {}
            : { timeoutMs: Math.max(1, options.timeoutMs - (performance.now() - startedAt)) }),
        });
      },
    },
  });
}
