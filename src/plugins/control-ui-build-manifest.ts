import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err } from "@openclaw/normalization-core/result";
import { normalizeManifestControlUi } from "./manifest-setup-normalizers.js";
import { controlUiSource } from "./package-manifest.js";
import {
  parsePluginCacheJson,
  pluginCacheLstatSync,
  readPluginCacheFile,
} from "./plugin-cache-files.js";

/** Browser builds replace only their declaration; authored capabilities remain authoritative. */
export function loadPluginControlUiDeclaration(params: {
  rootDir: string;
  controlUi: unknown;
  channels?: unknown;
  rejectHardlinks: boolean;
  rootRealPath?: string;
}): ReturnType<typeof normalizeManifestControlUi> {
  const relativePath = "dist/openclaw.plugin.json";
  if (
    !pluginCacheLstatSync(path.join(params.rootDir, relativePath)) ||
    !pluginCacheLstatSync(path.join(params.rootDir, "package.json"))
  ) {
    // Prebuilt packages publish the declaration in their required root manifest.
    return normalizeManifestControlUi(params.controlUi, params.channels);
  }
  const packageFile = readPluginCacheFile({ ...params, relativePath: "package.json" });
  if (!packageFile.ok) {
    return err("generated Control UI package metadata could not be safely read");
  }
  const packageManifest = parsePluginCacheJson(packageFile);
  if (!packageManifest.ok || !isRecord(packageManifest.value)) {
    return err("generated Control UI package metadata must be an object");
  }
  try {
    if (!controlUiSource(packageManifest.value)) {
      return normalizeManifestControlUi(params.controlUi, params.channels);
    }
  } catch (error) {
    return err(String(error));
  }
  const file = readPluginCacheFile({
    rootDir: params.rootDir,
    relativePath,
    rejectHardlinks: params.rejectHardlinks,
    rootRealPath: params.rootRealPath,
    maxBytes: 256 * 1024,
  });
  if (!file.ok) {
    return err("generated Control UI manifest could not be safely read");
  }
  const parsed = parsePluginCacheJson(file);
  if (!parsed.ok || !isRecord(parsed.value) || parsed.value.controlUi === undefined) {
    return err("generated Control UI manifest must contain controlUi");
  }
  return normalizeManifestControlUi(parsed.value.controlUi, params.channels);
}
