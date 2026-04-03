import { createCachedPluginBoundaryModuleLoader } from "../../plugins/runtime/runtime-plugin-boundary.js";

type RuntimeSendModule = Record<string, unknown>;

export type RuntimeSend = {
  sendMessage: (...args: unknown[]) => Promise<unknown>;
};

function resolveRuntimeExport(
  module: RuntimeSendModule | null,
  pluginId: string,
  exportName: string,
): (...args: unknown[]) => Promise<unknown> {
  const candidate = module?.[exportName];
  if (typeof candidate !== "function") {
    throw new Error(`${pluginId} plugin runtime is unavailable: missing export '${exportName}'`);
  }
  return candidate as (...args: unknown[]) => Promise<unknown>;
}

export function createPluginBoundaryRuntimeSend(params: {
  pluginId: string;
  exportName: string;
  missingLabel: string;
}): RuntimeSend {
  const loadRuntimeModuleSync = createCachedPluginBoundaryModuleLoader<RuntimeSendModule>({
    pluginId: params.pluginId,
    entryBaseName: "runtime-api",
    required: true,
    missingLabel: params.missingLabel,
  });

  return {
    sendMessage: (...args) =>
      resolveRuntimeExport(loadRuntimeModuleSync(), params.pluginId, params.exportName)(...args),
  };
}
