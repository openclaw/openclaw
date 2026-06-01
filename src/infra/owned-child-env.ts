const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const ALLOWED_EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "NODE_ENV",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "OPENCLAW_SERVICE_MARKER",
  "ROCKIELAB_API_BASE",
  "ROCKIELAB_TENANT_ID",
  "ROCKIELAB_TENANT_TOKEN",
  "BROKER_PORT",
]);

const ALLOWED_PREFIXES = ["LC_"];
const BLOCKED_NAME_RE =
  /(?:TOKEN|PASSWORD|PASSWD|SECRET|PRIVATE[_-]?KEY|CREDENTIAL|API[_-]?KEY|BROKER[_-]?TENANT[_-]?TOKEN)/i;
const PORTABLE_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export type OwnedChildEnvOptions = {
  baseEnv?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  overrides?: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

function isAllowedName(name: string): boolean {
  if (ALLOWED_EXACT.has(name)) {
    return true;
  }
  return ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function assignAllowed(
  out: Record<string, string>,
  source: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
): void {
  if (!source) {
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === "") {
      continue;
    }
    if (!isAllowedName(key)) {
      continue;
    }
    if (key !== "ROCKIELAB_TENANT_TOKEN" && BLOCKED_NAME_RE.test(key)) {
      continue;
    }
    out[key] = value;
  }
}

function assignExplicitOverrides(
  out: Record<string, string>,
  source: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
): void {
  if (!source) {
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === "" || !PORTABLE_ENV_NAME_RE.test(key)) {
      continue;
    }
    if (key !== "ROCKIELAB_TENANT_TOKEN" && BLOCKED_NAME_RE.test(key)) {
      continue;
    }
    out[key] = value;
  }
}

export function buildOwnedChildEnv(options: OwnedChildEnvOptions = {}): NodeJS.ProcessEnv {
  const baseEnv = options.baseEnv ?? process.env;
  const out: Record<string, string> = {};
  assignAllowed(out, baseEnv);
  assignExplicitOverrides(out, options.overrides);
  out.PATH ||= DEFAULT_PATH;
  const tenantId = options.overrides?.ROCKIELAB_TENANT_ID ?? baseEnv.ROCKIELAB_TENANT_ID;
  if (tenantId?.trim()) {
    out.ROCKIELAB_TENANT_ID = tenantId.trim();
  }
  return out;
}

export function assertOwnedChildEnv(
  env: NodeJS.ProcessEnv | undefined,
  label: string,
  options: { allowedSecretLikeKeys?: readonly string[] } = {},
): void {
  if (!env) {
    throw new Error(`${label} requires an explicit owned child env`);
  }
  const allowedSecretLikeKeys = new Set(options.allowedSecretLikeKeys ?? []);
  for (const key of Object.keys(env)) {
    if (key === "ROCKIELAB_TENANT_TOKEN") {
      continue;
    }
    if (allowedSecretLikeKeys.has(key)) {
      continue;
    }
    if (BLOCKED_NAME_RE.test(key)) {
      throw new Error(`${label} env contains blocked secret-like key ${key}`);
    }
  }
}

export function containsSecretValueInArgv(
  argv: readonly string[],
  values: Iterable<string>,
): boolean {
  for (const arg of argv) {
    for (const value of values) {
      if (value && arg.includes(value)) {
        return true;
      }
    }
  }
  return false;
}
