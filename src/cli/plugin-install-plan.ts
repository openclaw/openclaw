import type { BundledPluginSource } from "../plugins/bundled-sources.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install.js";
import { shortenHomePath } from "../utils.js";

type BundledLookup = (params: {
  kind: "pluginId" | "npmSpec";
  value: string;
}) => BundledPluginSource | undefined;

function isBareNpmPackageName(spec: string): boolean {
  const trimmed = spec.trim();
  return /^[a-z0-9][a-z0-9-._~]*$/.test(trimmed);
}

const BUILTIN_TOOL_LIKE_PLUGIN_NAMES = new Set([
  "exec",
  "shell",
  "bash",
  "terminal",
  "browser",
  "web",
  "playwright",
  "file",
  "files",
  "fs",
]);

export function resolveBundledInstallPlanBeforeNpm(params: {
  rawSpec: string;
  findBundledSource: BundledLookup;
}): { bundledSource: BundledPluginSource; warning: string } | null {
  if (!isBareNpmPackageName(params.rawSpec)) {
    return null;
  }
  const bundledSource = params.findBundledSource({
    kind: "pluginId",
    value: params.rawSpec,
  });
  if (!bundledSource) {
    return null;
  }
  return {
    bundledSource,
    warning: `Using bundled plugin "${bundledSource.pluginId}" from ${shortenHomePath(bundledSource.localPath)} for bare install spec "${params.rawSpec}". To install an npm package with the same name, use a scoped package name (for example @scope/${params.rawSpec}).`,
  };
}

export function resolveBundledInstallPlanForNpmFailure(params: {
  rawSpec: string;
  code?: string;
  findBundledSource: BundledLookup;
}): { bundledSource: BundledPluginSource; warning: string } | null {
  if (params.code !== PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND) {
    return null;
  }
  const bundledSource = params.findBundledSource({
    kind: "npmSpec",
    value: params.rawSpec,
  });
  if (!bundledSource) {
    return null;
  }
  return {
    bundledSource,
    warning: `npm package unavailable for ${params.rawSpec}; using bundled plugin at ${shortenHomePath(bundledSource.localPath)}.`,
  };
}

export function resolveBuiltinToolInstallHintForNpmFailure(params: {
  rawSpec: string;
  code?: string;
}): string | null {
  if (params.code !== PLUGIN_INSTALL_ERROR_CODE.MISSING_OPENCLAW_EXTENSIONS) {
    return null;
  }
  if (!isBareNpmPackageName(params.rawSpec)) {
    return null;
  }
  const normalized = params.rawSpec.trim().toLowerCase();
  if (!BUILTIN_TOOL_LIKE_PLUGIN_NAMES.has(normalized)) {
    return null;
  }
  return `Hint: "${params.rawSpec}" looks like a built-in tool category, not an OpenClaw plugin. For command/file/browser tools, enable a coding tool profile instead (for example: openclaw config set tools.profile coding), then restart the gateway.`;
}
