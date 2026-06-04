import path from "node:path";

// Support the remaining legacy pre-rebrand state dir.
const LEGACY_STATE_DIRNAMES = [".clawdbot"] as const;
const NEW_STATE_DIRNAME = ".openclaw";

/**
 * Closed set of basenames that count as an OpenClaw state directory. Used by
 * `resolveStateDir` and `resolveConfigDir` to detect when an explicit
 * `OPENCLAW_HOME` already points at the state dir itself, so we do not
 * silently nest a second `.openclaw` underneath (#45765).
 */
export const ALL_STATE_DIRNAMES: ReadonlySet<string> = new Set<string>([
  NEW_STATE_DIRNAME,
  ...LEGACY_STATE_DIRNAMES,
]);

/**
 * True when the caller explicitly set `OPENCLAW_HOME` AND the resolved path's
 * basename is itself a known state directory name (`.openclaw`, `.clawdbot`).
 * In that case the home dir IS the state dir; appending another `.openclaw`
 * would produce `~/.openclaw/.openclaw` (#45765). The implicit `$HOME` /
 * `USERPROFILE` path keeps the existing `~/.openclaw` convention even when
 * the OS home happens to end with a state-dir name.
 *
 * Matches `home-dir.ts` sentinel normalization: the literal strings
 * `"undefined"` and `"null"` are treated as unset (callers commonly leak
 * stringified `undefined`/`null` via shell envs), so this guard does not
 * activate against an effectively-unset value.
 */
export function isExplicitOpenClawHomeStateDir(
  env: NodeJS.ProcessEnv,
  resolvedHome: string,
): boolean {
  const trimmed = env.OPENCLAW_HOME?.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return false;
  }
  return ALL_STATE_DIRNAMES.has(path.basename(resolvedHome));
}

export { LEGACY_STATE_DIRNAMES, NEW_STATE_DIRNAME };
