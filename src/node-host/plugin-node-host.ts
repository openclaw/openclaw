/** Plugin node-host bridge for loading plugin registry commands and dispatching node capabilities. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { emitNodeGatewayEvent } from "./node-event-emitter.js";

/**
 * Plugin node-host command registry bridge.
 *
 * Node hosts load the active plugin registry, expose registered capabilities
 * and commands, and dispatch incoming node-host commands by exact command id.
 */
let pluginRegistryLoaderModulePromise:
  | Promise<typeof import("../plugins/runtime/runtime-registry-loader.js")>
  | undefined;

async function loadPluginRegistryLoaderModule() {
  pluginRegistryLoaderModulePromise ??= import("../plugins/runtime/runtime-registry-loader.js");
  return await pluginRegistryLoaderModulePromise;
}

/** Ensure plugin registry data is loaded before node-host command dispatch. */
export async function ensureNodeHostPluginRegistry(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  (await loadPluginRegistryLoaderModule()).ensurePluginRegistryLoaded({
    scope: "all",
    config: params.config,
    activationSourceConfig: params.config,
    env: params.env,
  });
}

/** List registered node-host capabilities and command ids in deterministic order. */
export function listRegisteredNodeHostCapsAndCommands(): {
  caps: string[];
  commands: string[];
} {
  const registry = getActivePluginRegistry();
  const caps = new Set<string>();
  const commands = new Set<string>();
  for (const entry of registry?.nodeHostCommands ?? []) {
    if (entry.command.cap) {
      caps.add(entry.command.cap);
    }
    commands.add(entry.command.command);
  }
  return {
    caps: [...caps].toSorted((left, right) => left.localeCompare(right)),
    commands: [...commands].toSorted((left, right) => left.localeCompare(right)),
  };
}

/** Invoke a registered node-host plugin command, or return null for unknown commands. */
/** Run every registered node-host startup hook once. Failures are reported, not fatal. */
export async function runRegisteredNodeHostStartupHooks(params: {
  onWarn: (message: string) => void;
  nodeId?: string;
}): Promise<void> {
  const registry = getActivePluginRegistry();
  for (const entry of registry?.nodeHostCommands ?? []) {
    const start = entry.command.onNodeHostStart;
    if (!start) {
      continue;
    }
    try {
      // The node->gateway emitter is privileged (it originates node-attributed
      // turns), so only the bundled node-anchored browser bridge receives it on
      // its startup ctx, gated on BOTH the registry plugin's trusted BUNDLED
      // ORIGIN and its manifest id "browser" -- a self-declared cap, or a
      // config-loaded plugin that shadows the id, is origin !== "bundled" and so
      // cannot receive it; every other plugin hook gets just nodeId. Built as a
      // non-literal so the emitter stays off the public {nodeId?} type.
      const startCtx =
        entry.origin === "bundled" && entry.pluginId === "browser"
          ? { emitNodeGatewayEvent, nodeId: params.nodeId }
          : { nodeId: params.nodeId };
      await start(startCtx);
    } catch (err) {
      params.onWarn(
        "node-host startup hook failed (" + entry.pluginId + ":" + entry.command.command + "): " + String(err),
      );
    }
  }
}

export async function invokeRegisteredNodeHostCommand(
  command: string,
  paramsJSON?: string | null,
): Promise<string | null> {
  const registry = getActivePluginRegistry();
  const match = (registry?.nodeHostCommands ?? []).find(
    (entry) => entry.command.command === command,
  );
  if (!match) {
    return null;
  }
  return await match.command.handle(paramsJSON);
}
