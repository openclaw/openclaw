import path from "node:path";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import type { GatewayService, readGatewayServiceState } from "../../daemon/service.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";

export function createUpdateServiceStateReader(mocks: {
  readCommand: GatewayService["readCommand"];
  isLoaded: GatewayService["isLoaded"];
  readRuntime: GatewayService["readRuntime"];
  readCapability: () => Promise<GatewayServiceState["definitionMutationCapability"]>;
  absentPort: () => number;
}): typeof readGatewayServiceState {
  return async (_service, args?: Parameters<typeof readGatewayServiceState>[1]) => {
    const command = await mocks.readCommand(
      args?.env ?? process.env,
      args?.requireEffective
        ? {
            requireEffective: true,
            ...(args.requireLoadedCommand ? { requireLoaded: true } : {}),
          }
        : undefined,
    );
    const env: NodeJS.ProcessEnv = {
      ...(args?.env ?? process.env),
      ...(process.platform === "win32" ? { PATH: path.dirname(process.execPath) } : {}),
      ...command?.environment,
    };
    // An absent fixture service must probe its own port, not the operator's listener.
    if (command === null) {
      env.OPENCLAW_GATEWAY_PORT ??= String(mocks.absentPort());
    }
    args?.validateEnvBeforeStatusRead?.(env);
    const [loadState, runtime] = await Promise.all([
      mocks
        .isLoaded({ env })
        .then((loaded) =>
          loaded ? ({ status: "loaded" } as const) : ({ status: "not-loaded" } as const),
        )
        .catch((error: unknown) => ({ status: "unknown" as const, detail: String(error) })),
      mocks.readRuntime(env).catch(() => undefined),
    ]);
    return {
      installed: command !== null,
      loadState,
      running: runtime?.status === "running",
      env,
      command,
      runtime:
        runtime &&
        process.platform === "linux" &&
        ["running", "stopped"].includes(runtime.status ?? "")
          ? { ...runtime, systemd: { managerUid: 2001, ...runtime.systemd } }
          : runtime,
      definitionMutationCapability: await mocks.readCapability(),
    };
  };
}

/** Pins the serialized launcher retained by shipped update handoffs. */
export function createShippedUnresolvedServiceStop(
  env: NodeJS.ProcessEnv,
  root: string,
): PreManagedServiceStop {
  return {
    stopped: true,
    inspected: true,
    runtimeInspected: true,
    running: true,
    serviceEnv: {
      ...env,
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    },
    serviceUpdateVerdict: {
      kind: "unresolved",
      root,
      fingerprint: "48344cce3972c84750d2aa44f7f99f2c87ca0901ad12e64cea1c42ace769c00c",
    },
  };
}
