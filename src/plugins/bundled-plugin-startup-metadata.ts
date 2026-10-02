import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tryReadJsonSync } from "../infra/json-files.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

/** Resolves one exact bundled id without scanning or materializing the full plugin catalog. */
export function hasBundledPluginStartupManifest(params: {
  pluginId: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  const bundledPluginsDir = resolveBundledPluginsDir(params.env);
  if (!bundledPluginsDir) {
    return false;
  }
  const rootDir = path.join(bundledPluginsDir, params.pluginId);
  const manifest = tryReadJsonSync(path.join(rootDir, "openclaw.plugin.json"));
  return isRecord(manifest) && manifest.id === params.pluginId;
}
