import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveUserFilesystemPath } from "../infra/home-dir.js";
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
  if (rest.startsWith("///") || rest.startsWith("//localhost/")) {
    try {
      // Bun can preserve malformed escapes instead of rejecting them during conversion.
      decodeURIComponent(new URL(trimmed).pathname);
      return { ok: true, path: fileURLToPath(trimmed) };
    } catch {
      return { ok: false, error: "unsupported file: URL: invalid local path" };
    }
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

const GIT_SPEC_PREFIX = "git:";
const FULL_GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

/** Normalized Git plugin install spec accepted by the Git installer. */
type ParsedGitPluginSpec = {
  input: string;
  url: string;
  ref?: string;
  label: string;
  normalizedSpec: string;
};

/** Returns true for full commit SHAs that do not require branch/tag drift checks. */
export function isImmutableGitCommitRef(ref: string | undefined): boolean {
  return FULL_GIT_COMMIT_PATTERN.test(ref ?? "");
}

function splitGitSpecRef(input: string): { base: string; ref?: string } {
  const hashIndex = input.lastIndexOf("#");
  if (hashIndex > 0) {
    return {
      base: input.slice(0, hashIndex),
      ref: normalizeOptionalString(input.slice(hashIndex + 1)),
    };
  }

  for (
    let atIndex = input.lastIndexOf("@");
    atIndex > 0;
    atIndex = input.lastIndexOf("@", atIndex - 1)
  ) {
    const base = input.slice(0, atIndex);
    const ref = normalizeOptionalString(input.slice(atIndex + 1));
    // An @ at the start of a local path component belongs to that ancestor.
    if (
      process.platform === "win32" &&
      (isLocalGitPath(base) || /^file:\/\//i.test(base)) &&
      /[\\/]$/.test(base)
    ) {
      continue;
    }
    // Preserve the legacy full-path interpretation of absolute .git repositories.
    // An explicit ref on a .git repository still splits after that suffix.
    if (
      process.platform === "win32" &&
      path.isAbsolute(input) &&
      input.endsWith(".git") &&
      !base.endsWith(".git")
    ) {
      continue;
    }
    // A native path ancestor is not a ref: Git refs cannot contain backslashes.
    if (ref && isGitSpecBase(base) && !(process.platform === "win32" && ref.includes("\\"))) {
      return { base, ref };
    }
  }

  return { base: input };
}

function isLocalGitPath(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/") ||
    (process.platform === "win32" &&
      (value.startsWith(".\\") ||
        value.startsWith("..\\") ||
        value.startsWith("~\\") ||
        path.isAbsolute(value)))
  );
}

function isGitSpecBase(value: string): boolean {
  return (
    looksLikeGitHubRepoShorthand(value) ||
    looksLikeGitHubHostPath(value) ||
    looksLikeUrlGitSpecBase(value) ||
    looksLikeScpGitUrl(value) ||
    value.endsWith(".git") ||
    isLocalGitPath(value)
  );
}

function looksLikeGitHubRepoShorthand(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value);
}

function looksLikeGitHubHostPath(value: string): boolean {
  return /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(value);
}

function isGitUrl(value: string): boolean {
  if (value.startsWith("-")) {
    return false;
  }
  return (
    /^(?:ssh|git|file):\/\//i.test(value) || looksLikeScpGitUrl(value) || value.endsWith(".git")
  );
}

function looksLikeScpGitUrl(value: string): boolean {
  return /^[^@\s]+@[^:\s]+:.+/.test(value);
}

function looksLikeUrlGitSpecBase(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ssh:", "git:", "file:"].includes(url.protocol)) {
      return false;
    }
    if (url.protocol === "file:") {
      return url.pathname.length > 1;
    }
    return Boolean(url.hostname) && url.pathname.length > 1;
  } catch {
    return false;
  }
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function normalizeGitLabel(value: string): string {
  if (hasHttpUrlPrefix(value) || /^(?:ssh|git|file):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return stripGitSuffix(`${url.hostname}${url.pathname}`).replace(/^\/+/, "");
    } catch {
      return stripGitSuffix(value);
    }
  }
  return stripGitSuffix(value);
}

export function parseGitPluginSpec(raw: string): ParsedGitPluginSpec | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(GIT_SPEC_PREFIX)) {
    return null;
  }

  const body = trimmed.slice(GIT_SPEC_PREFIX.length).trim();
  if (!body) {
    return null;
  }

  const split = splitGitSpecRef(body);
  const base = split.base.trim();
  if (!base) {
    return null;
  }

  const localPath = isLocalGitPath(base);
  let normalized: { url: string; label: string };
  if (looksLikeGitHubRepoShorthand(base) || looksLikeGitHubHostPath(base)) {
    const repo = stripGitSuffix(base.replace(/^github\.com\//i, ""));
    normalized = { url: `https://github.com/${repo}.git`, label: repo };
  } else if (hasHttpUrlPrefix(base) || isGitUrl(base) || localPath) {
    const url = localPath ? resolveUserFilesystemPath(base) : base;
    normalized = { url, label: normalizeGitLabel(url) };
  } else {
    return null;
  }
  // A normalized absolute Windows path can otherwise make a .git-ending ref look like a repository.
  const refSeparator = localPath && process.platform === "win32" ? "#" : "@";
  return {
    input: trimmed,
    ...normalized,
    ref: split.ref,
    normalizedSpec: `${GIT_SPEC_PREFIX}${normalized.url}${split.ref ? `${refSeparator}${split.ref}` : ""}`,
  };
}
