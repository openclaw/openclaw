/**
 * Utilities for building filtered subprocess environments.
 *
 * Spawning child processes with `{ ...process.env }` leaks all environment
 * variables — including API keys, tokens, and secrets from other plugins —
 * into the subprocess. These helpers let callers construct a minimal or
 * sanitised environment instead.
 */

/**
 * System-level env vars that are generally safe (and often required) to
 * forward to subprocesses. These cover shell, locale, display, and temp-dir
 * basics without including any credential-shaped variables.
 */
const SAFE_SYSTEM_ENV_PREFIXES: readonly string[] = ["LC_", "XDG_"];

const SAFE_SYSTEM_ENV_KEYS: ReadonlySet<string> = new Set([
  // Shell / user identity
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "HOSTNAME",

  // Locale
  "LANG",
  "LANGUAGE",

  // Terminal / colour
  "TERM",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",

  // Temp directories
  "TMPDIR",
  "TMP",
  "TEMP",
  "TEMPDIR",

  // Platform basics
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "EDITOR",
  "VISUAL",

  // Windows
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "USERPROFILE",
  "SYSTEMDRIVE",
  "WINDIR",
  "OS",
]);

function isSafeSystemKey(key: string): boolean {
  if (SAFE_SYSTEM_ENV_KEYS.has(key)) {
    return true;
  }
  const upper = key.toUpperCase();
  return SAFE_SYSTEM_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Build a minimal subprocess environment from the current `process.env`,
 * forwarding only safe system variables plus any explicitly requested keys
 * or prefix patterns.
 *
 * Use this when spawning external binaries (e.g. `zca`, `lobster`) that
 * should not have access to credentials stored in the parent env.
 *
 * @param options.extraKeys  Exact env var names to include (e.g. `["ZCA_PROFILE"]`).
 * @param options.extraPrefixes  Prefix patterns to include (e.g. `["ZCA_"]`).
 * @param options.overrides  Additional key-value pairs to set on the child env.
 * @param options.source  Source env to read from (defaults to `process.env`).
 */
export function buildSafeSubprocessEnv(options?: {
  extraKeys?: readonly string[];
  extraPrefixes?: readonly string[];
  overrides?: Readonly<Record<string, string | undefined>>;
  source?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = options?.source ?? process.env;
  const extraKeys = options?.extraKeys ? new Set(options.extraKeys) : null;
  const extraPrefixes = options?.extraPrefixes ?? [];

  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    const include =
      isSafeSystemKey(key) ||
      (extraKeys !== null && extraKeys.has(key)) ||
      extraPrefixes.some((prefix) => key.startsWith(prefix));
    if (include) {
      env[key] = value;
    }
  }

  if (options?.overrides) {
    for (const [key, value] of Object.entries(options.overrides)) {
      if (value !== undefined) {
        env[key] = value;
      } else {
        delete env[key];
      }
    }
  }

  return env;
}

/**
 * Env-var name patterns that typically hold credentials. Used by the
 * blocklist-based filter for cases where a broader env is needed but
 * known secrets should be stripped.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /_(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)s?$/i,
  /^(API_?KEY|TOKEN|SECRET|PASSWORD)$/i,
  /_(PRIVATE_?KEY|PRIV_?KEY)$/i,
  /^(AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)$/i,
  /^DATABASE_URL$/i,
  /^REDIS_URL$/i,
  /^MONGODB_URI$/i,
  /^(GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|NPM_TOKEN)$/i,
  /^OPENAI_API_KEY$/i,
  /^ANTHROPIC_API_KEY$/i,
  /^TWILIO_AUTH_TOKEN$/i,
];

function looksLikeCredential(key: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Build a subprocess environment by copying `process.env` but stripping
 * variables whose names match known credential patterns.
 *
 * This is a softer filter than `buildSafeSubprocessEnv` — useful when
 * the subprocess needs a near-complete environment but should not receive
 * obvious secrets.
 *
 * @param options.overrides  Additional key-value pairs to set/unset.
 * @param options.source  Source env to read from (defaults to `process.env`).
 */
export function buildSanitisedSubprocessEnv(options?: {
  overrides?: Readonly<Record<string, string | undefined>>;
  source?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const source = options?.source ?? process.env;
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (!looksLikeCredential(key)) {
      env[key] = value;
    }
  }

  if (options?.overrides) {
    for (const [key, value] of Object.entries(options.overrides)) {
      if (value !== undefined) {
        env[key] = value;
      } else {
        delete env[key];
      }
    }
  }

  return env;
}

export const __testing = {
  isSafeSystemKey,
  looksLikeCredential,
  SAFE_SYSTEM_ENV_KEYS,
  CREDENTIAL_PATTERNS,
};
