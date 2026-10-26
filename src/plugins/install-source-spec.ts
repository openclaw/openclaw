import { shortenHomePath } from "../utils.js";
import type { BundledPluginSource } from "./bundled-sources.js";

export function resolveFileNpmSpecToLocalPath(
  raw: string,
): { ok: true; path: string } | { ok: false; error: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("file:")) {
    return null;
  }
  const rest = trimmed.slice("file:".length);
  if (!rest) {
    return { ok: false, error: "unsupported file: spec: missing path" };
  }
  if (rest.startsWith("///")) {
    return { ok: true, path: rest.slice(2) };
  }
  if (rest.startsWith("//localhost/")) {
    return { ok: true, path: rest.slice("//localhost".length) };
  }
  if (rest.startsWith("//")) {
    return {
      ok: false,
      error: 'unsupported file: URL host (expected "file:<path>" or "file:///abs/path")',
    };
  }
  return { ok: true, path: rest };
}

export function parseNpmPrefixSpec(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("npm:")) {
    return null;
  }
  return trimmed.slice("npm:".length).trim();
}

export function parseNpmPackPrefixPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith("npm-pack:")) {
    return null;
  }
  return trimmed.slice("npm-pack:".length).trim();
}

export type BundledLookup = (params: {
  kind: "pluginId" | "npmSpec";
  value: string;
}) => BundledPluginSource | undefined;

export function isBareNpmPackageName(spec: string): boolean {
  return /^[a-z0-9][a-z0-9-._~]*$/.test(spec.trim());
}

export function resolveBundledInstallPlanBeforeNpm(params: {
  rawSpec: string;
  findBundledSource: BundledLookup;
}): { bundledSource: BundledPluginSource; warning: string } | null {
  // Only bare plugin IDs select bundled copies; package specs default to ClawHub.
  const rawSpec = params.rawSpec.trim();
  if (!isBareNpmPackageName(rawSpec)) {
    return null;
  }
  const bundledSource = params.findBundledSource({ kind: "pluginId", value: rawSpec });
  return bundledSource
    ? {
        bundledSource,
        warning: `Using bundled plugin "${bundledSource.pluginId}" from ${shortenHomePath(bundledSource.localPath)} for bare install spec "${rawSpec}". To select a registry explicitly, use clawhub:${rawSpec} or npm:${rawSpec}.`,
      }
    : null;
}
