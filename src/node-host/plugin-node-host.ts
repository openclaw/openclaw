import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginNodeHostCommandRegistration } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeHostCommand } from "../plugins/types.js";

let pluginRegistryLoaderModulePromise:
  | Promise<typeof import("../plugins/runtime/runtime-registry-loader.js")>
  | undefined;

async function loadPluginRegistryLoaderModule() {
  pluginRegistryLoaderModulePromise ??= import("../plugins/runtime/runtime-registry-loader.js");
  return await pluginRegistryLoaderModulePromise;
}

type PreparedNodeHostCommand = {
  command: string;
  cap?: string;
  handle: OpenClawPluginNodeHostCommand["handle"];
};

function readNodeHostCommandRegistration(
  entry: PluginNodeHostCommandRegistration,
): PreparedNodeHostCommand | null {
  let commandRegistration: OpenClawPluginNodeHostCommand;
  try {
    commandRegistration = entry.command;
  } catch {
    return null;
  }

  let command: string;
  try {
    const value = commandRegistration.command;
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    command = value;
  } catch {
    return null;
  }

  let handle: OpenClawPluginNodeHostCommand["handle"];
  try {
    handle = commandRegistration.handle;
  } catch {
    return null;
  }
  if (typeof handle !== "function") {
    return null;
  }

  let cap: string | undefined;
  try {
    const value = commandRegistration.cap;
    if (typeof value === "string" && value.trim().length > 0) {
      cap = value;
    }
  } catch {
    cap = undefined;
  }

  return {
    command,
    cap,
    handle: (paramsJSON) => handle.call(commandRegistration, paramsJSON),
  };
}

function readRegisteredNodeHostCommands(): PreparedNodeHostCommand[] {
  const registry = getActivePluginRegistry();
  const commands: PreparedNodeHostCommand[] = [];
  for (const entry of registry?.nodeHostCommands ?? []) {
    const command = readNodeHostCommandRegistration(entry);
    if (command) {
      commands.push(command);
    }
  }
  return commands;
}

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

export function listRegisteredNodeHostCapsAndCommands(): {
  caps: string[];
  commands: string[];
} {
  const caps = new Set<string>();
  const commands = new Set<string>();
  for (const entry of readRegisteredNodeHostCommands()) {
    if (entry.cap) {
      caps.add(entry.cap);
    }
    commands.add(entry.command);
  }
  return {
    caps: [...caps].toSorted((left, right) => left.localeCompare(right)),
    commands: [...commands].toSorted((left, right) => left.localeCompare(right)),
  };
}

export async function invokeRegisteredNodeHostCommand(
  command: string,
  paramsJSON?: string | null,
): Promise<string | null> {
  const match = readRegisteredNodeHostCommands().find((entry) => entry.command === command);
  if (!match) {
    return null;
  }
  return await match.handle(paramsJSON);
}
