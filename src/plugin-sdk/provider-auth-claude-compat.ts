import { execSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { resolveOsHomeRelativePath } from "../infra/home-dir.js";
import { loadJsonFileThroughSymlink } from "../infra/json-file.js";

const CLAUDE_CLI_CREDENTIALS_FILE = ".credentials.json";
const CLAUDE_CLI_USER_SETTINGS_FILE = "settings.json";
const CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS = 2_000;
const CLAUDE_CLI_KEYCHAIN_ACCOUNT_FALLBACK = "claude-code-user";
const MACOS_SECURITY_PATH = "/usr/bin/security";
// Any of these in the child environment means the Claude CLI authenticates some other
// way than its stored login, so the stored account is not who runs.
const CLAUDE_NON_NATIVE_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_UNIX_SOCKET",
] as const;
// Pinned Claude SDK YK() accepts this exact ASCII set and otherwise uses the fallback.
const SAFE_KEYCHAIN_ACCOUNT_PATTERN = /^[a-zA-Z0-9._-]+$/u;

/** Retired Claude CLI credential shape kept only for source compatibility. */
type ClaudeCliCredential =
  | {
      type: "oauth";
      provider: "anthropic";
      access: string;
      refresh: string;
      expires: number;
      subscriptionType?: string;
      rateLimitTier?: string;
      email?: string;
    }
  | {
      type: "token";
      provider: "anthropic";
      token: string;
      expires: number;
      subscriptionType?: string;
      rateLimitTier?: string;
      email?: string;
    }
  | {
      type: "api_key_helper";
      provider: "anthropic";
      helperHash: string;
    };

type ClaudeCliCredentialReadOptions = {
  allowKeychainPrompt?: boolean;
  tryKeychainWithoutPrompt?: boolean;
  onStoredCredentialUnreadable?: () => void;
  ttlMs?: number;
  platform?: NodeJS.Platform;
  homeDir?: string;
  execSync?: typeof execSync;
};

type ClaudeCliCache = {
  value: ClaudeCliCredential | null;
  readAt: number;
  cacheKey: string;
  sourceFingerprint: string;
};

let claudeCliCache: ClaudeCliCache | null = null;

// Every resolver below reads the environment it is given. Default is the Gateway process;
// the native owner lookup passes the environment the child Claude actually receives.
function resolveClaudeCliConfigDir(homeDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (homeDir !== undefined) {
    return path.join(resolveOsHomeRelativePath(homeDir, { env }), ".claude");
  }
  const configuredDir = env.CLAUDE_CONFIG_DIR;
  return configuredDir
    ? path.resolve(configuredDir)
    : path.join(resolveOsHomeRelativePath("~", { env }), ".claude");
}

function resolveClaudeCliPath(
  homeDir: string | undefined,
  fileName: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveClaudeCliConfigDir(homeDir, env), fileName);
}

function resolveClaudeCliCredentialsPath(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (homeDir !== undefined) {
    return path.join(resolveClaudeCliConfigDir(homeDir, env), CLAUDE_CLI_CREDENTIALS_FILE);
  }
  const secureStorageDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secureStorageDir === undefined) {
    return resolveClaudeCliPath(undefined, CLAUDE_CLI_CREDENTIALS_FILE, env);
  }
  // Claude treats an explicit empty override as the default credential store,
  // even when CLAUDE_CONFIG_DIR points at a separate settings directory.
  const credentialDir = secureStorageDir
    ? path.resolve(secureStorageDir)
    : path.join(resolveOsHomeRelativePath("~", { env }), ".claude");
  return path.join(credentialDir, CLAUDE_CLI_CREDENTIALS_FILE);
}

function resolveClaudeCliAccountPath(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (homeDir !== undefined) {
    return path.join(resolveOsHomeRelativePath(homeDir, { env }), ".claude.json");
  }
  const configuredDir = env.CLAUDE_CONFIG_DIR;
  return configuredDir
    ? path.join(path.resolve(configuredDir), ".claude.json")
    : path.join(resolveOsHomeRelativePath("~", { env }), ".claude.json");
}

function resolveClaudeCliKeychainService(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (homeDir !== undefined) {
    return CLAUDE_CLI_KEYCHAIN_SERVICE;
  }
  const secureStorageDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const configDir = env.CLAUDE_CONFIG_DIR;
  const selectedDir = secureStorageDir !== undefined ? secureStorageDir : configDir;
  if (!selectedDir) {
    return CLAUDE_CLI_KEYCHAIN_SERVICE;
  }
  // Claude Code normalizes this selector before hashing its Keychain service suffix.
  // Keep byte-for-byte parity or decomposed Unicode config paths query a different item.
  const suffix = createHash("sha256")
    .update(selectedDir.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `${CLAUDE_CLI_KEYCHAIN_SERVICE}-${suffix}`;
}

function readFileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function parseClaudeCliOauthCredential(value: unknown): ClaudeCliCredential | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = asNonArrayRecord(value);
  const accessToken = data.accessToken;
  const refreshToken = data.refreshToken;
  const expiresAt = data.expiresAt;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    // The shipped token variant is access-only (no refresh token), not expiry-free.
    // Both public credential variants require a finite expiry for safe reuse.
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= 0
  ) {
    return null;
  }
  const subscriptionType = normalizeOptionalString(data.subscriptionType);
  const rateLimitTier = normalizeOptionalString(data.rateLimitTier);
  const plan = {
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(rateLimitTier ? { rateLimitTier } : {}),
  };
  return typeof refreshToken === "string" && refreshToken
    ? {
        type: "oauth",
        provider: "anthropic",
        access: accessToken,
        refresh: refreshToken,
        expires: expiresAt,
        ...plan,
      }
    : {
        type: "token",
        provider: "anthropic",
        token: accessToken,
        expires: expiresAt,
        ...plan,
      };
}

function readClaudeAccountEmail(homeDir?: string): string | undefined {
  const raw = loadJsonFileThroughSymlink(resolveClaudeCliAccountPath(homeDir));
  const account = asNonArrayRecord(raw).oauthAccount;
  const email = asNonArrayRecord(account).emailAddress;
  return normalizeOptionalString(email);
}

type ClaudeNativeLoginOptions = {
  homeDir?: string;
  platform?: NodeJS.Platform;
  execSync?: typeof execSync;
  /** Environment the `claude` process receives. Defaults to the Gateway process. */
  env?: NodeJS.ProcessEnv;
};

/** Anthropic's account lookup for a Claude OAuth access token, the one Claude CLI itself uses. */
const CLAUDE_OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_OAUTH_PROFILE_TIMEOUT_MS = 3_000;
// Claude CLI refreshes a token within 5 minutes of expiry when it starts, before it accepts
// a prompt. Add slack so a token that is refresh-due by send time is already treated so here.
const CLAUDE_NATIVE_LOGIN_REFRESH_MARGIN_MS = 10 * 60_000;
const CLAUDE_NATIVE_LOGIN_ATTESTATION_LIMIT = 64;
// Fingerprints are keyed per process, so they name a token only inside this process and
// are never persisted. A token belongs to one account for its whole life, so an entry can
// only stop matching (rotation, logout), never start naming someone else.
const claudeNativeLoginAttestationKey = randomBytes(32);
const claudeNativeLoginAttestations = new Map<string, string>();

function fingerprintClaudeNativeLoginToken(token: string): string {
  return createHmac("sha256", claudeNativeLoginAttestationKey).update(token).digest("hex");
}

/**
 * Owner of the login a local `claude` process would use, as Anthropic attested it for the
 * exact access token it reads (Keychain, then the credentials file), or undefined when no
 * attestation in this process covers that token. Synchronous and local: never makes a
 * network call, so a rotated or replaced token has no owner until
 * {@link attestClaudeNativeLoginOwner} runs again. Never returns token material and never
 * uses the interactive Keychain path.
 */
export function readClaudeNativeLoginOwner(
  options: ClaudeNativeLoginOptions = {},
): string | undefined {
  const token = readClaudeNativeLoginCredential(options);
  return token
    ? claudeNativeLoginAttestations.get(fingerprintClaudeNativeLoginToken(token.value))
    : undefined;
}

/**
 * Attest the owner of the login a local `claude` process would use: the account uuid
 * Anthropic's OAuth profile endpoint returns for the access token itself. The token goes
 * only to that endpoint, with a short timeout, and is never logged, stored or refreshed
 * here. Any failure, an expired token, or a response without an account uuid yields no
 * owner. `refreshDueAt` is when Claude CLI starts rotating the token, which it does before
 * it accepts a prompt, so a check at send time can see a token attested only after the run.
 */
export async function attestClaudeNativeLoginOwner(
  options: ClaudeNativeLoginOptions & {
    /** Test seam; production always calls the global fetch on the Anthropic endpoint. */
    fetchFn?: typeof fetch;
    now?: number;
  } = {},
): Promise<{ owner?: string; refreshDueAt?: number }> {
  const token = readClaudeNativeLoginCredential(options);
  if (!token) {
    return {};
  }
  const refreshDueAt = token.expires - CLAUDE_NATIVE_LOGIN_REFRESH_MARGIN_MS;
  const fingerprint = fingerprintClaudeNativeLoginToken(token.value);
  const attested = claudeNativeLoginAttestations.get(fingerprint);
  if (attested || token.expires <= (options.now ?? Date.now())) {
    return { ...(attested ? { owner: attested } : {}), refreshDueAt };
  }
  let owner: string | undefined;
  try {
    // The timeout signal also bounds reading the body.
    const response = await (options.fetchFn ?? globalThis.fetch)(CLAUDE_OAUTH_PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${token.value}`,
        Accept: "application/json",
        "User-Agent": "openclaw",
      },
      redirect: "error",
      signal: AbortSignal.timeout(CLAUDE_OAUTH_PROFILE_TIMEOUT_MS),
    });
    if (response.ok) {
      const account = asNonArrayRecord(asNonArrayRecord(await response.json()).account);
      const uuid = normalizeOptionalString(account.uuid);
      owner = uuid ? `uuid:${uuid}` : undefined;
    }
  } catch {
    // Network, timeout and parse failures all mean no owner. The error is dropped, not
    // surfaced, so nothing derived from the request can reach a log.
    owner = undefined;
  }
  if (owner) {
    claudeNativeLoginAttestations.delete(fingerprint);
    claudeNativeLoginAttestations.set(fingerprint, owner);
    if (claudeNativeLoginAttestations.size > CLAUDE_NATIVE_LOGIN_ATTESTATION_LIMIT) {
      const oldest = claudeNativeLoginAttestations.keys().next().value;
      if (oldest !== undefined) {
        claudeNativeLoginAttestations.delete(oldest);
      }
    }
  }
  return { ...(owner ? { owner } : {}), refreshDueAt };
}

/** The access token a local `claude` process would authenticate with, or undefined. */
function readClaudeNativeLoginCredential(
  options: ClaudeNativeLoginOptions,
): { value: string; expires: number } | undefined {
  const { homeDir } = options;
  const env = options.env ?? process.env;
  if (
    // A selected API key, token, or cloud provider replaces the native login entirely.
    CLAUDE_NON_NATIVE_AUTH_ENV_KEYS.some((key) => Boolean(env[key]?.trim())) ||
    // A relative root resolves against the child's cwd, which this process cannot know.
    [env.CLAUDE_CONFIG_DIR, env.CLAUDE_SECURESTORAGE_CONFIG_DIR].some(
      (dir) => dir && !path.isAbsolute(dir),
    ) ||
    // Left out of scope: a credential root split from the config root. An API key helper
    // replaces the login entirely.
    path.dirname(resolveClaudeCliCredentialsPath(homeDir, env)) !==
      resolveClaudeCliConfigDir(homeDir, env) ||
    readClaudeApiKeyHelper(homeDir, env) ||
    userSettingsSelectNonNativeAuth(homeDir, env)
  ) {
    return undefined;
  }
  const execSyncImpl = options.execSync ?? execSync;
  const service = resolveClaudeCliKeychainService(homeDir, env);
  let stored: ClaudeCliCredential | null = null;
  if ((options.platform ?? process.platform) === "darwin") {
    const password = probeClaudeKeychainPassword(execSyncImpl, service, env);
    if (password.state === "ok") {
      stored = parseClaudeCliOauthCredential(password.value.claudeAiOauth);
      if (!stored) {
        return undefined;
      }
    } else if (
      (password.state === "absent"
        ? "absent"
        : probeClaudeKeychainItem(execSyncImpl, service, env)) !== "absent"
    ) {
      // The live login sits in a Keychain item this process cannot read, or the lookups failed
      // for a reason other than the item not existing. A credentials file beside it may be
      // stale, so only a confirmed absence lets the file stand.
      return undefined;
    }
  }
  stored ??= parseClaudeCliOauthCredential(
    asNonArrayRecord(loadJsonFileThroughSymlink(resolveClaudeCliCredentialsPath(homeDir, env)))
      .claudeAiOauth,
  );
  if (!stored || stored.type === "api_key_helper") {
    return undefined;
  }
  return { value: stored.type === "oauth" ? stored.access : stored.token, expires: stored.expires };
}

function withClaudeAccountEmail(
  credential: ClaudeCliCredential | null,
  homeDir?: string,
): ClaudeCliCredential | null {
  if (!credential || credential.type === "api_key_helper") {
    return credential;
  }
  if (
    path.dirname(resolveClaudeCliCredentialsPath(homeDir)) !== resolveClaudeCliConfigDir(homeDir)
  ) {
    // oauthAccount is config-scoped, so it cannot identify a credential selected
    // from an independent secure-storage root.
    return credential;
  }
  const email = readClaudeAccountEmail(homeDir);
  return email ? { ...credential, email } : credential;
}

/**
 * Claude's user settings `env` block outranks the spawned environment, so it can select an
 * API key, token or cloud provider too. The bundled backend loads user settings only.
 */
function userSettingsSelectNonNativeAuth(homeDir?: string, env: NodeJS.ProcessEnv = process.env) {
  const settings = asNonArrayRecord(
    loadJsonFileThroughSymlink(resolveClaudeCliPath(homeDir, CLAUDE_CLI_USER_SETTINGS_FILE, env)),
  );
  const settingsEnv = asNonArrayRecord(settings.env);
  return CLAUDE_NON_NATIVE_AUTH_ENV_KEYS.some((key) => {
    const value = settingsEnv[key];
    return typeof value === "string" && value.trim() !== "";
  });
}

function readClaudeApiKeyHelper(
  homeDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCliCredential | null {
  const raw = loadJsonFileThroughSymlink(
    resolveClaudeCliPath(homeDir, CLAUDE_CLI_USER_SETTINGS_FILE, env),
  );
  const helper = asNonArrayRecord(raw).apiKeyHelper;
  return typeof helper === "string" && helper.trim()
    ? {
        type: "api_key_helper",
        provider: "anthropic",
        helperHash: createHash("sha256").update(helper.trim()).digest("hex"),
      }
    : null;
}

function readClaudeKeychain(
  execSyncImpl: typeof execSync,
  timeout: number | undefined,
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> | null {
  try {
    const account = resolveClaudeCliKeychainAccount(env);
    const result = execSyncImpl(
      `${MACOS_SECURITY_PATH} find-generic-password -a "${account}" -w -s "${service}"`,
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        ...(timeout === undefined ? {} : { timeout }),
      },
    );
    const parsed: unknown = JSON.parse(result.trim());
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// `security find-generic-password` exits 44 (errSecItemNotFound) only when the item does not
// exist. A timeout, spawn error, locked keychain or any other status says nothing about it.
const SECURITY_ITEM_NOT_FOUND_STATUS = 44;

function isKeychainItemNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === SECURITY_ITEM_NOT_FOUND_STATUS
  );
}

type KeychainPasswordProbe =
  | { state: "ok"; value: Record<string, unknown> }
  | { state: "absent" }
  | { state: "unknown" };

/** Tri-state read of the Keychain login: readable, confirmed absent, or unknown. */
function probeClaudeKeychainPassword(
  execSyncImpl: typeof execSync,
  service: string,
  env: NodeJS.ProcessEnv,
): KeychainPasswordProbe {
  let result: string;
  try {
    result = execSyncImpl(
      `${MACOS_SECURITY_PATH} find-generic-password -a "${resolveClaudeCliKeychainAccount(env)}" -w -s "${service}"`,
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS,
      },
    );
  } catch (error) {
    return isKeychainItemNotFound(error) ? { state: "absent" } : { state: "unknown" };
  }
  try {
    const parsed: unknown = JSON.parse(result.trim());
    return isRecord(parsed) ? { state: "ok", value: parsed } : { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

/** Tri-state metadata lookup: the item exists, is confirmed absent, or the lookup failed. */
function probeClaudeKeychainItem(
  execSyncImpl: typeof execSync,
  service: string,
  env: NodeJS.ProcessEnv,
): "present" | "absent" | "unknown" {
  try {
    execSyncImpl(
      `${MACOS_SECURITY_PATH} find-generic-password -a "${resolveClaudeCliKeychainAccount(env)}" -s "${service}"`,
      {
        encoding: "utf8",
        timeout: CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return "present";
  } catch (error) {
    return isKeychainItemNotFound(error) ? "absent" : "unknown";
  }
}

function hasClaudeKeychainItem(
  execSyncImpl: typeof execSync,
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    const account = resolveClaudeCliKeychainAccount(env);
    execSyncImpl(`${MACOS_SECURITY_PATH} find-generic-password -a "${account}" -s "${service}"`, {
      encoding: "utf8",
      timeout: CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function resolveClaudeCliKeychainAccount(env: NodeJS.ProcessEnv = process.env): string {
  let account: string | undefined;
  try {
    account = env.USER || userInfo().username;
  } catch {
    account = undefined;
  }
  return account && SAFE_KEYCHAIN_ACCOUNT_PATTERN.test(account)
    ? account
    : CLAUDE_CLI_KEYCHAIN_ACCOUNT_FALLBACK;
}

function readClaudeCliCredentials(
  options: ClaudeCliCredentialReadOptions,
): ClaudeCliCredential | null {
  const helper = readClaudeApiKeyHelper(options.homeDir);
  if (helper) {
    return helper;
  }

  const platform = options.platform ?? process.platform;
  const execSyncImpl = options.execSync ?? execSync;
  const keychainService = resolveClaudeCliKeychainService(options.homeDir);
  const tryKeychain = platform === "darwin" && options.allowKeychainPrompt !== false;
  if (tryKeychain) {
    const payload = readClaudeKeychain(
      execSyncImpl,
      options.tryKeychainWithoutPrompt ? CLAUDE_CLI_KEYCHAIN_TIMEOUT_MS : undefined,
      keychainService,
    );
    const credential = parseClaudeCliOauthCredential(payload?.claudeAiOauth);
    if (credential) {
      return withClaudeAccountEmail(credential, options.homeDir);
    }
  }

  const credentialsPath = resolveClaudeCliCredentialsPath(options.homeDir);
  const raw = loadJsonFileThroughSymlink(credentialsPath);
  const credential = withClaudeAccountEmail(
    parseClaudeCliOauthCredential(asNonArrayRecord(raw).claudeAiOauth),
    options.homeDir,
  );
  if (credential) {
    return credential;
  }
  if (
    options.onStoredCredentialUnreadable &&
    options.tryKeychainWithoutPrompt &&
    (fs.existsSync(credentialsPath) ||
      (platform === "darwin" && hasClaudeKeychainItem(execSyncImpl, keychainService)))
  ) {
    options.onStoredCredentialUnreadable();
  }
  return null;
}

/**
 * @deprecated Claude CLI owns native login. Kept functional for shipped Plugin SDK callers only.
 * Scheduled for removal after v2026.10.
 */
export function readClaudeCliCredentialsCached(
  options: ClaudeCliCredentialReadOptions = {},
): ClaudeCliCredential | null {
  const platform = options.platform ?? process.platform;
  const ttlMs = options.ttlMs ?? 0;
  const credentialsPath = resolveClaudeCliCredentialsPath(options.homeDir);
  const settingsPath = resolveClaudeCliPath(options.homeDir, CLAUDE_CLI_USER_SETTINGS_FILE);
  const accountPath = resolveClaudeCliAccountPath(options.homeDir);
  const keychainService = resolveClaudeCliKeychainService(options.homeDir);
  const keychainIntent =
    platform !== "darwin"
      ? "file"
      : options.allowKeychainPrompt === false
        ? options.tryKeychainWithoutPrompt
          ? "keychain-presence"
          : "file"
        : options.tryKeychainWithoutPrompt
          ? "keychain-bounded"
          : "keychain";
  const unreadableIntent =
    options.onStoredCredentialUnreadable && options.tryKeychainWithoutPrompt ? "notify" : "silent";
  const cacheKey = `${credentialsPath}:${settingsPath}:${accountPath}:${keychainIntent}:${keychainService}:${unreadableIntent}`;
  const sourceFingerprint = `${readFileMtimeMs(credentialsPath) ?? "missing"}:${readFileMtimeMs(settingsPath) ?? "missing"}:${readFileMtimeMs(accountPath) ?? "missing"}`;
  const now = Date.now();
  if (
    ttlMs > 0 &&
    claudeCliCache?.cacheKey === cacheKey &&
    claudeCliCache.sourceFingerprint === sourceFingerprint &&
    now - claudeCliCache.readAt < ttlMs
  ) {
    return claudeCliCache.value;
  }

  const value = readClaudeCliCredentials({ ...options, platform });
  const nextFingerprint = `${readFileMtimeMs(credentialsPath) ?? "missing"}:${readFileMtimeMs(settingsPath) ?? "missing"}:${readFileMtimeMs(accountPath) ?? "missing"}`;
  claudeCliCache =
    ttlMs > 0 && nextFingerprint === sourceFingerprint
      ? { value, readAt: now, cacheKey, sourceFingerprint: nextFingerprint }
      : null;
  return value;
}
