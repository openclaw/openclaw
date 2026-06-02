import { resolveSafeBins } from "./exec-approvals-allowlist.js";
import {
  normalizeSafeBinProfileFixtures,
  resolveSafeBinProfiles,
  type SafeBinProfile,
  type SafeBinProfileFixture,
  type SafeBinProfileFixtures,
} from "./exec-safe-bin-policy.js";
import { normalizeSafeBinName } from "./exec-safe-bin-semantics.js";
import {
  getTrustedSafeBinDirs,
  listWritableExplicitTrustedSafeBinDirs,
  normalizeTrustedSafeBinDirs,
  type WritableTrustedSafeBinDir,
} from "./exec-safe-bin-trust.js";

type ExecSafeBinConfigScope = {
  safeBins?: string[] | null;
  safeBinProfiles?: SafeBinProfileFixtures | null;
  safeBinTrustedDirs?: string[] | null;
};

type ExecSafeBinRuntimePolicy = {
  /** Normalized safe-bin names selected by config, falling back to defaults when unset. */
  safeBins: Set<string>;
  /** Compiled argv-validation profiles after built-ins and config overlays are resolved. */
  safeBinProfiles: Readonly<Record<string, SafeBinProfile>>;
  /** Resolved directories whose executables may satisfy safe-bin checks. */
  trustedSafeBinDirs: ReadonlySet<string>;
  /** Configured safe bins without an argv-validation profile. */
  unprofiledSafeBins: string[];
  /** Unprofiled safe bins that look capable of script or arbitrary code execution. */
  unprofiledInterpreterSafeBins: string[];
  /** Explicit trusted directories that are group/world writable. */
  writableTrustedSafeBinDirs: ReadonlyArray<WritableTrustedSafeBinDir>;
};

const INTERPRETER_LIKE_SAFE_BINS = new Set([
  "ash",
  "awk",
  "bash",
  "busybox",
  "bun",
  "cmd",
  "cmd.exe",
  "cscript",
  "dash",
  "deno",
  "fish",
  "gawk",
  "gsed",
  "ksh",
  "lua",
  "mawk",
  "nawk",
  "node",
  "nodejs",
  "perl",
  "php",
  "powershell",
  "powershell.exe",
  "pypy",
  "pwsh",
  "pwsh.exe",
  "python",
  "python2",
  "python3",
  "ruby",
  "sed",
  "sh",
  "toybox",
  "wscript",
  "zsh",
]);

const INTERPRETER_LIKE_PATTERNS = [
  /^python\d+(?:\.\d+)?$/,
  /^ruby\d+(?:\.\d+)?$/,
  /^perl\d+(?:\.\d+)?$/,
  /^php\d+(?:\.\d+)?$/,
  /^node\d+(?:\.\d+)?$/,
];

/**
 * Returns true for safe-bin names that can execute scripts or arbitrary code.
 *
 * Names are normalized through the same executable-family rules used by semantic validation, so
 * path-like and version-suffixed entries classify consistently.
 */
export function isInterpreterLikeSafeBin(raw: string): boolean {
  const normalized = normalizeSafeBinName(raw);
  if (!normalized) {
    return false;
  }
  if (INTERPRETER_LIKE_SAFE_BINS.has(normalized)) {
    return true;
  }
  return INTERPRETER_LIKE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Lists normalized interpreter-like safe bins so missing profiles can be warned about separately. */
export function listInterpreterLikeSafeBins(entries: Iterable<string>): string[] {
  return Array.from(entries)
    .map((entry) => normalizeSafeBinName(entry))
    .filter((entry) => entry.length > 0 && isInterpreterLikeSafeBin(entry))
    .toSorted();
}

/**
 * Merges global and local safe-bin profile fixtures with local config winning.
 *
 * Both scopes are normalized first, which keeps override matching case-insensitive and removes
 * invalid fixture entries before compilation.
 */
export function resolveMergedSafeBinProfileFixtures(params: {
  global?: ExecSafeBinConfigScope | null;
  local?: ExecSafeBinConfigScope | null;
}): Record<string, SafeBinProfileFixture> | undefined {
  const global = normalizeSafeBinProfileFixtures(params.global?.safeBinProfiles);
  const local = normalizeSafeBinProfileFixtures(params.local?.safeBinProfiles);
  if (Object.keys(global).length === 0 && Object.keys(local).length === 0) {
    return undefined;
  }
  return {
    ...global,
    ...local,
  };
}

/**
 * Resolves the runtime safe-bin policy from global/local config and trust checks.
 *
 * Local safeBins replace global safeBins, while profile fixtures and trusted dirs merge. The result
 * is the precomputed approval-time snapshot used by exec allowlist evaluation.
 */
export function resolveExecSafeBinRuntimePolicy(params: {
  global?: ExecSafeBinConfigScope | null;
  local?: ExecSafeBinConfigScope | null;
  onWarning?: (message: string) => void;
}): ExecSafeBinRuntimePolicy {
  const safeBins = resolveSafeBins(params.local?.safeBins ?? params.global?.safeBins);
  const safeBinProfiles = resolveSafeBinProfiles(
    resolveMergedSafeBinProfileFixtures({
      global: params.global,
      local: params.local,
    }),
  );
  const unprofiledSafeBins = Array.from(safeBins)
    .filter((entry) => !safeBinProfiles[entry])
    .toSorted();
  const explicitTrustedSafeBinDirs = [
    ...normalizeTrustedSafeBinDirs(params.global?.safeBinTrustedDirs),
    ...normalizeTrustedSafeBinDirs(params.local?.safeBinTrustedDirs),
  ];
  const trustedSafeBinDirs = getTrustedSafeBinDirs({
    extraDirs: explicitTrustedSafeBinDirs,
    safeBins: Array.from(safeBins),
  });
  const writableTrustedSafeBinDirs = listWritableExplicitTrustedSafeBinDirs(
    explicitTrustedSafeBinDirs,
  );
  if (params.onWarning) {
    for (const hit of writableTrustedSafeBinDirs) {
      // Explicit trust in writable directories lets another process swap the
      // executable after policy resolution, so surface it as an operator warning.
      const scope =
        hit.worldWritable || hit.groupWritable
          ? hit.worldWritable
            ? "world-writable"
            : "group-writable"
          : "writable";
      params.onWarning(
        `exec: safeBinTrustedDirs includes ${scope} directory '${hit.dir}'; remove trust or tighten permissions (for example chmod 755).`,
      );
    }
  }
  return {
    safeBins,
    safeBinProfiles,
    trustedSafeBinDirs,
    unprofiledSafeBins,
    unprofiledInterpreterSafeBins: listInterpreterLikeSafeBins(unprofiledSafeBins),
    writableTrustedSafeBinDirs,
  };
}
