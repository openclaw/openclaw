import { pathToFileURL } from "node:url";
import {
  resolvePluginRuntimeModulePath,
  resolvePluginRuntimeRecord,
} from "../../../plugins/runtime/runtime-plugin-boundary.js";

export function resolveBundledChannelContractArtifactUrl(
  pluginId: string,
  entryBaseName: string,
): string {
  const record = resolvePluginRuntimeRecord(pluginId, () => {
    throw new Error(`missing bundled channel plugin '${pluginId}'`);
  });
  if (!record) {
    throw new Error(`missing bundled channel plugin '${pluginId}'`);
  }
  const modulePath = resolvePluginRuntimeModulePath(record, entryBaseName, () => {
    throw new Error(`missing ${entryBaseName} for bundled channel plugin '${pluginId}'`);
  });
  if (!modulePath) {
    throw new Error(`missing ${entryBaseName} for bundled channel plugin '${pluginId}'`);
  }
  return pathToFileURL(modulePath).href;
}

export async function importBundledChannelContractArtifact<T extends object>(
  pluginId: string,
  entryBaseName: string,
): Promise<T> {
  return (await import(resolveBundledChannelContractArtifactUrl(pluginId, entryBaseName))) as T;
}
