import { resolveConfigPath, resolveGatewayPort, resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { mergeGatewayServiceEnv } from "../../daemon/service-env-merge.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { isImplicitLocalGatewayTarget } from "../../gateway/call.js";
import { resolveGatewayProbeAuthSafeWithSecretInputs } from "../../gateway/probe-auth.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../../infra/gateway-owner-lease.js";
import { LOOPBACK_PORT_PROBE_HOSTS } from "../../infra/ports-probe.js";
import { parseTcpPortFromArgs } from "../../infra/tcp-port.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { createGatewayRestartDeadline } from "./restart-health-deadline.js";
import { resolveGatewayRestartProbeContext } from "./restart-health-probe.js";
import { DEFAULT_RESTART_HEALTH_TIMEOUT_MS } from "./restart-health.constants.js";
import { waitForGatewayHealthyRestart, type GatewayRestartSnapshot } from "./restart-health.js";

/** Returns undefined when the original diagnostic path should probe without a startup wait. */
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
  let nativeServiceAbsent = false;
  const deadline = createGatewayRestartDeadline({
    timeoutMs: Math.max(
      0,
      Math.min(
        opts.timeoutMs ?? DEFAULT_RESTART_HEALTH_TIMEOUT_MS,
        opts.deadlineMs === undefined ? Infinity : opts.deadlineMs - performance.now(),
      ),
    ),
  });
  try {
    const snapshot = await withCommandProcessScope(
      () =>
        waitForGatewayHealthyRestart({
          port,
          timeoutMs: opts.timeoutMs ?? DEFAULT_RESTART_HEALTH_TIMEOUT_MS,
          deadline,
          deadlineOutcome: "snapshot",
          probeContext,
          probeHosts: LOOPBACK_PORT_PROBE_HOSTS,
          requirePluginHealth: false,
          waitForMissingService: false,
          onProgress: opts.onProgress,
          service: {
            readCommand: async () => null,
            readRuntime: async (env, options) => {
              const owner = await deadline.read("diagnostic:owner", async () =>
                readGatewayOwnerLease({ env, port }),
              );
              if (
                owner?.state === "live" &&
                (owner.mode === "foreground" || owner.supervisor?.kind === "external")
              ) {
                return { status: "running", pid: owner.pid };
              }
              const remainingReadOptions = () => ({
                ...options,
                timeoutMs: Math.max(
                  1,
                  Math.min(options?.timeoutMs ?? Infinity, deadline.remainingMs()),
                ),
              });
              const command = await (nativeCommand ??= (async () => {
                nativeServiceAbsent =
                  (await deadline.read("diagnostic:service-absence", async () =>
                    nativeService.isAbsent?.({
                      env,
                      timeoutMs: remainingReadOptions().timeoutMs,
                    }),
                  )) === true;
                deadline.signal.throwIfAborted();
                return nativeServiceAbsent
                  ? null
                  : deadline.read("diagnostic:service-command", () =>
                      nativeService.readCommand(env, {
                        ...remainingReadOptions(),
                        requireEffective: true,
                      }),
                    );
              })());
              deadline.signal.throwIfAborted();
              const readNativeRuntime = () =>
                deadline.read("diagnostic:native-runtime", () =>
                  nativeService.readRuntime(env, remainingReadOptions()),
                );
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
                // Published Gateways before owner leases still record their verified process lock.
                const legacyOwner = await deadline.read("diagnostic:legacy-owner", () =>
                  readActiveGatewayLockIdentity({
                    env,
                    requireInspection: true,
                    timeoutMs: deadline.remainingMs(),
                    signal: deadline.signal,
                  }),
                );
                if (legacyOwner?.port === port) {
                  return { status: "running", pid: legacyOwner.pid };
                }
                // A strict command read can still omit a system-domain owner on macOS.
                // The native runtime owns its missing-unit verdict.
                return nativeServiceAbsent || command !== null
                  ? { status: "unknown", missingUnit: true }
                  : readNativeRuntime();
              }
              return readNativeRuntime();
            },
          },
        }),
      deadline.signal,
    );
    return snapshot.waitOutcome === "stopped-free" && snapshot.runtime.missingUnit
      ? undefined
      : snapshot;
  } finally {
    deadline.dispose();
  }
}
