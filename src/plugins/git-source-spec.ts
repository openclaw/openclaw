import path from "node:path";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveUserFilesystemPath } from "../infra/home-dir.js";

const GIT_SPEC_PREFIX = "git:";
const FULL_GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

type ParsedGitPluginSpec = {
  input: string;
  url: string;
  ref?: string;
  label: string;
  normalizedSpec: string;
};

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
    if (
      process.platform === "win32" &&
      (isLocalGitPath(base) || /^file:\/\//i.test(base)) &&
      /[\\/]$/.test(base)
    ) {
      continue;
    }
    if (
      process.platform === "win32" &&
      path.isAbsolute(input) &&
      input.endsWith(".git") &&
      !base.endsWith(".git")
    ) {
      continue;
    }
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

export function formatGitPluginSpec(url: string, ref?: string): string {
  // A normalized Windows path can make an @ref mistaken for part of a local repository path.
  const separator = process.platform === "win32" && path.isAbsolute(url) ? "#" : "@";
  return `git:${url}${ref ? `${separator}${ref}` : ""}`;
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
  return {
    input: trimmed,
    ...normalized,
    ref: split.ref,
    normalizedSpec: formatGitPluginSpec(normalized.url, split.ref),
  };
}
