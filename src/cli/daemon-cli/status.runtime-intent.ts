import { readDaemonRuntimePin } from "../../daemon/runtime-pin-state.js";
import type { DaemonRuntimePinSnapshot } from "../../daemon/runtime-pin-types.js";
import type { GatewayService, GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { hasGatewayServiceLauncherOverride } from "../../daemon/service-types.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { projectDaemonServiceForJson } from "./shared.js";

export type CliRuntimeStatus = {
  kind: "node" | "bun" | "unknown";
  execPath: string;
  supported: boolean;
};

/** Diagnostics may run on unsupported Node or recover elsewhere; report the actual interpreter. */
export async function inspectCliRuntime(): Promise<CliRuntimeStatus> {
  const { isCurrentRuntimeSupported } = await import("../../infra/runtime-guard.js");
  return {
    kind: process.versions.bun ? "bun" : process.versions.node ? "node" : "unknown",
    execPath: process.execPath,
    supported: await isCurrentRuntimeSupported(),
  };
}

export type ServiceRuntimeIntentStatus =
  | { runtimeIntent: { status: "unknown" } }
  | {
      runtimeIntent: DaemonRuntimePinSnapshot & { status: "known" };
      revision: string;
      definitionMutation: "writable" | "sealed" | "unknown";
      launcherOverridden: boolean;
    };

/** Deep inspection projects canonical intent; the revision is observation, never a write grant. */
export async function inspectServiceRuntimeIntent(params: {
  service: GatewayService;
  command: GatewayServiceCommandConfig | null;
  env: NodeJS.ProcessEnv;
  serviceEnv: NodeJS.ProcessEnv;
  inspectionKnown: boolean;
}): Promise<ServiceRuntimeIntentStatus> {
  if (!params.inspectionKnown) {
    return { runtimeIntent: { status: "unknown" } };
  }
  try {
    const pin = readDaemonRuntimePin({ kind: "gateway", env: params.serviceEnv }, params.command);
    const capability = await params.service.readDefinitionMutationCapability?.({
      env: params.env,
      environment: params.serviceEnv,
    });
    const currentPin = readDaemonRuntimePin(
      { kind: "gateway", env: params.serviceEnv },
      params.command,
    );
    if (currentPin.revision !== pin.revision) {
      return { runtimeIntent: { status: "unknown" } };
    }
    const { command } = projectDaemonServiceForJson(
      { command: params.command },
      { includeDefinitionPaths: false },
    );
    return {
      runtimeIntent: { status: "known", ...pin },
      // Compare public identity only; the native service writer owns private environment updates.
      // Hashing private values would expose an offline password-guessing oracle in shared reports.
      revision: sha256Hex(JSON.stringify([command, pin])),
      definitionMutation: capability?.kind ?? "unknown",
      launcherOverridden: hasGatewayServiceLauncherOverride(params.command),
    };
  } catch {
    // Missing, unreadable, malformed, and stale metadata cannot authorize adoption.
    return { runtimeIntent: { status: "unknown" } };
  }
}
