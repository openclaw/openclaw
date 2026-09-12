import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { shortenHomePath } from "../utils.js";
import type { BundledPluginSource } from "./bundled-sources.js";

export function resolveFileNpmSpecToLocalPath(
  raw: string,
): { ok: true; path: string } | { ok: false; error: string } | null {
  const trimmed = raw.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("file:")) {
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
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("npm:")) {
    return null;
  }
  return trimmed.slice("npm:".length).trim();
}

export function parseNpmPackPrefixPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("npm-pack:")) {
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

export function isSourceCheckoutBundledPath(localPath: string): boolean {
  const extensionsDir = path.dirname(path.resolve(localPath));
  if (path.basename(extensionsDir) !== "extensions") {
    return false;
  }
  const extensionsParent = path.dirname(extensionsDir);
  const packageRoot = ["dist", "dist-runtime"].includes(path.basename(extensionsParent))
    ? path.dirname(extensionsParent)
    : extensionsParent;
  try {
    const packageJson: unknown = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    );
    return (
      isRecord(packageJson) &&
      packageJson.name === "openclaw" &&
      fs.existsSync(path.join(packageRoot, ".git")) &&
      fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml")) &&
      fs.existsSync(path.join(packageRoot, "src")) &&
      fs.existsSync(path.join(packageRoot, "extensions"))
    );
  } catch {
    return false;
  }
}

export function resolveBundledInstallPlanBeforeNpm(params: {
  rawSpec: string;
  findBundledSource: BundledLookup;
}): { bundledSource: BundledPluginSource; warning: string } | null {
  // Bundled plugin ids win before npm lookup so local official plugins do not hit the registry.
  const rawSpec = params.rawSpec.trim();
  if (!rawSpec || parseNpmPrefixSpec(rawSpec) !== null) {
    return null;
  }
  if (isBareNpmPackageName(rawSpec)) {
    const bundledSource = params.findBundledSource({
      kind: "pluginId",
      value: rawSpec,
    });
    if (!bundledSource) {
      return null;
    }
    return {
      bundledSource,
      warning: `Using bundled plugin "${bundledSource.pluginId}" from ${shortenHomePath(bundledSource.localPath)} for bare install spec "${rawSpec}". To install an npm package with the same name, use a scoped package name (for example @scope/${rawSpec}).`,
    };
  }

  const parsedNpmSpec = parseRegistryNpmSpec(rawSpec);
  if (!parsedNpmSpec) {
    return null;
  }
  const bundledSource =
    params.findBundledSource({
      kind: "npmSpec",
      value: rawSpec,
    }) ??
    params.findBundledSource({
      kind: "npmSpec",
      value: parsedNpmSpec.name,
    });
  if (!bundledSource) {
    return null;
  }
  // Bare IDs already selected local source above. Npm package requests must not
  // persist disposable source-checkout build output; packaged bundles remain image-owned.
  if (isSourceCheckoutBundledPath(bundledSource.localPath)) {
    return null;
  }
  return {
    bundledSource,
    warning: `Using bundled plugin "${bundledSource.pluginId}" from ${shortenHomePath(bundledSource.localPath)} for npm install spec "${rawSpec}" because this plugin ships with the current OpenClaw build. To force an external npm override, use npm:${rawSpec}.`,
  };
}
