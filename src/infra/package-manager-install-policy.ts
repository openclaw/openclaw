import hostedGitInfo from "hosted-git-info";
import { parseSemver } from "./runtime-guard.js";

export type PnpmVersion = {
  major: number;
  minor: number;
  patch: number;
};

type VersionCommandRunner = (
  argv: string[],
  options: { timeoutMs: number },
) => Promise<{ stdout: string; code: number | null }>;

/** Identifies package-manager targets that are not registry tags or versions. */
export function isExplicitPackageInstallSpec(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return (
    /\.(?:tgz|tar\.gz)$/iu.test(trimmed) ||
    /^(?:\.{1,2}[\\/]|[\\/]|[a-z]:[\\/])/iu.test(trimmed) ||
    trimmed.includes("://") ||
    trimmed.includes("#") ||
    /^(?:bitbucket|file|gist|github|gitlab|git\+ssh|git\+https|git\+http|git\+file|npm):/i.test(
      trimmed,
    )
  );
}

function stripPackageAlias(packageName: string, spec: string): string {
  const normalized = spec.trim();
  const prefix = `${packageName.trim()}@`;
  return normalized.toLowerCase().startsWith(prefix.toLowerCase())
    ? normalized.slice(prefix.length).trim()
    : normalized;
}

function isPnpmSourceInstallSpec(packageName: string, spec: string): boolean {
  const target = stripPackageAlias(packageName, spec);
  return (
    hostedGitInfo.fromUrl(target) != null ||
    /^git\+(?:ssh|https|http|file):/i.test(target) ||
    /^git:/i.test(target)
  );
}

function isHttpGitInstallSpec(value: string): boolean {
  if (hostedGitInfo.fromUrl(value) != null) {
    return true;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return false;
    }
    return url.pathname.replace(/\/+$/u, "").endsWith(".git");
  } catch {
    return false;
  }
}

function isGitInstallSpec(value: string): boolean {
  const [repo] = value.split("#", 1);
  const isGitHubShorthand = repo
    ? !repo.startsWith(".") &&
      !repo.startsWith("/") &&
      !repo.startsWith("@") &&
      repo.split("/").length === 2 &&
      repo.split("/").every((part) => /^[^\s/:@]+$/u.test(part))
    : false;
  return (
    hostedGitInfo.fromUrl(value) != null ||
    /^git\+(?:ssh|https|http|file):/i.test(value) ||
    /^git:/i.test(value) ||
    /^ssh:\/\//i.test(value) ||
    /^[^@\s]+@[^:\s]+:[^#\s]+(?:#.*)?$/u.test(value) ||
    isHttpGitInstallSpec(value) ||
    isGitHubShorthand
  );
}

/** Identifies git package specs after removing an optional package-name alias. */
export function isGitPackageInstallSpec(packageName: string, spec: string): boolean {
  return isGitInstallSpec(stripPackageAlias(packageName, spec));
}

/** Grants npm 12 one-shot access only for the explicit root source being installed. */
export function npmSourceAccessArgs(packageName: string, spec: string): string[] {
  const target = stripPackageAlias(packageName, spec);
  if (isGitInstallSpec(target)) {
    return ["--allow-git=root"];
  }
  try {
    const url = new URL(target);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return ["--allow-remote=root"];
    }
  } catch {
    // Registry tags, versions, and local paths need no remote-source approval.
  }
  return [];
}

/** Grants npm 12 the access needed while packing an explicit git source. */
export function npmGitPackSourceAccessArgs(packageName: string, spec: string): string[] {
  if (!isGitPackageInstallSpec(packageName, spec)) {
    return [];
  }
  // npm resolves the selected root ref to a pinned commit, then fetches that
  // commit as a nested source. `root` blocks the second fetch, so packing the
  // already-selected repository needs `all` within this isolated command.
  return ["--allow-git=all"];
}

/** Uses pnpm's one-shot approval when supported and fails closed after an unknown version probe. */
export function shouldPassPnpmAllowBuild(
  packageName: string,
  spec: string,
  pnpmVersion: PnpmVersion | null | undefined,
): boolean {
  if (pnpmVersion === null) {
    return true;
  }
  if (pnpmVersion !== undefined) {
    return pnpmVersion.major > 10 || (pnpmVersion.major === 10 && pnpmVersion.minor >= 4);
  }
  return isPnpmSourceInstallSpec(packageName, spec);
}

/** Explains pnpm versions that cannot safely approve this package's install scripts. */
export function pnpmInstallScriptPreflightError(
  pnpmVersion: PnpmVersion | null | undefined,
): string | null {
  if (pnpmVersion === undefined) {
    return null;
  }
  if (pnpmVersion === null) {
    return "could not determine the pnpm version needed to approve OpenClaw install scripts; upgrade pnpm to 10.4.0 or newer, then retry";
  }
  if (pnpmVersion.major < 10 || (pnpmVersion.major === 10 && pnpmVersion.minor < 4)) {
    return `pnpm ${pnpmVersion.major}.${pnpmVersion.minor}.${pnpmVersion.patch} cannot approve OpenClaw install scripts for a safe update; upgrade pnpm to 10.4.0 or newer, then retry`;
  }
  return null;
}

/** Probes pnpm's version; null makes install arguments fail closed. */
export async function detectPnpmVersion(
  command: string,
  runCommand: VersionCommandRunner,
  timeoutMs: number,
): Promise<PnpmVersion | null> {
  const result = await runCommand([command, "--version"], { timeoutMs }).catch(() => null);
  if (!result || result.code !== 0) {
    return null;
  }
  return parseSemver(result.stdout.trim());
}
