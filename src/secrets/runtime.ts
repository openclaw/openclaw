import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForRuntime,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
  type SecretRef,
} from "../config/config.js";
import { runExec } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";

const DEFAULT_SOPS_TIMEOUT_MS = 5_000;
const MAX_SOPS_OUTPUT_BYTES = 10 * 1024 * 1024;

type SecretResolverWarningCode = "SECRETS_REF_OVERRIDES_PLAINTEXT";

export type SecretResolverWarning = {
  code: SecretResolverWarningCode;
  path: string;
  message: string;
};

export type PreparedSecretsRuntimeSnapshot = {
  config: OpenClawConfig;
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
  warnings: SecretResolverWarning[];
};

type ResolverContext = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  fileSecretsPromise: Promise<unknown> | null;
};

type ProviderLike = {
  apiKey?: unknown;
};

type GoogleChatAccountLike = {
  serviceAccount?: unknown;
  serviceAccountRef?: unknown;
  accounts?: Record<string, unknown>;
};

type ApiKeyCredentialLike = AuthProfileCredential & {
  type: "api_key";
  key?: string;
  keyRef?: unknown;
};

type TokenCredentialLike = AuthProfileCredential & {
  type: "token";
  token?: string;
  tokenRef?: unknown;
};

let activeSnapshot: PreparedSecretsRuntimeSnapshot | null = null;

function cloneSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): PreparedSecretsRuntimeSnapshot {
  return {
    config: structuredClone(snapshot.config),
    authStores: snapshot.authStores.map((entry) => ({
      agentDir: entry.agentDir,
      store: structuredClone(entry.store),
    })),
    warnings: snapshot.warnings.map((warning) => ({ ...warning })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.keys(value).length !== 2) {
    return false;
  }
  return (
    (value.source === "env" || value.source === "file") &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function readJsonPointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) {
    throw new Error(
      `File-backed secret ids must be absolute JSON pointers (for example: /providers/openai/apiKey).`,
    );
  }

  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => decodeJsonPointerToken(token));

  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(token, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
        throw new Error(`JSON pointer segment "${token}" is out of bounds.`);
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current)) {
      throw new Error(`JSON pointer segment "${token}" does not exist.`);
    }
    if (!Object.hasOwn(current, token)) {
      throw new Error(`JSON pointer segment "${token}" does not exist.`);
    }
    current = current[token];
  }
  return current;
}

async function decryptSopsFile(config: OpenClawConfig): Promise<unknown> {
  const fileSource = config.secrets?.sources?.file;
  if (!fileSource) {
    throw new Error(
      `Secret reference source "file" is not configured. Configure secrets.sources.file first.`,
    );
  }
  if (fileSource.type !== "sops") {
    throw new Error(`Unsupported secrets.sources.file.type "${String(fileSource.type)}".`);
  }

  const resolvedPath = resolveUserPath(fileSource.path);
  const timeoutMs =
    typeof fileSource.timeoutMs === "number" && Number.isFinite(fileSource.timeoutMs)
      ? Math.max(1, Math.floor(fileSource.timeoutMs))
      : DEFAULT_SOPS_TIMEOUT_MS;

  try {
    const { stdout } = await runExec("sops", ["--decrypt", "--output-type", "json", resolvedPath], {
      timeoutMs,
      maxBuffer: MAX_SOPS_OUTPUT_BYTES,
    });
    return JSON.parse(stdout) as unknown;
  } catch (err) {
    const error = err as NodeJS.ErrnoException & { message?: string };
    if (error.code === "ENOENT") {
      throw new Error(
        `sops binary not found in PATH. Install sops >= 3.9.0 or disable secrets.sources.file.`,
        { cause: err },
      );
    }
    if (typeof error.message === "string" && error.message.toLowerCase().includes("timed out")) {
      throw new Error(`sops decrypt timed out after ${timeoutMs}ms for ${resolvedPath}.`, {
        cause: err,
      });
    }
    throw new Error(`sops decrypt failed for ${resolvedPath}: ${String(error.message ?? err)}`, {
      cause: err,
    });
  }
}

async function resolveSecretRefValue(ref: SecretRef, context: ResolverContext): Promise<unknown> {
  const id = ref.id.trim();
  if (!id) {
    throw new Error(`Secret reference id is empty.`);
  }

  if (ref.source === "env") {
    const envValue = context.env[id];
    if (!isNonEmptyString(envValue)) {
      throw new Error(`Environment variable "${id}" is missing or empty.`);
    }
    return envValue;
  }

  if (ref.source === "file") {
    context.fileSecretsPromise ??= decryptSopsFile(context.config);
    const payload = await context.fileSecretsPromise;
    return readJsonPointer(payload, id);
  }

  throw new Error(`Unsupported secret source "${String((ref as { source?: unknown }).source)}".`);
}

async function resolveGoogleChatServiceAccount(
  target: GoogleChatAccountLike,
  path: string,
  context: ResolverContext,
  warnings: SecretResolverWarning[],
): Promise<void> {
  const explicitRef = isSecretRef(target.serviceAccountRef) ? target.serviceAccountRef : null;
  const inlineRef = isSecretRef(target.serviceAccount) ? target.serviceAccount : null;
  const ref = explicitRef ?? inlineRef;
  if (!ref) {
    return;
  }
  if (explicitRef && target.serviceAccount !== undefined && !isSecretRef(target.serviceAccount)) {
    warnings.push({
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      path,
      message: `${path}: serviceAccountRef is set; runtime will ignore plaintext serviceAccount.`,
    });
  }
  target.serviceAccount = await resolveSecretRefValue(ref, context);
}

async function resolveConfigSecretRefs(params: {
  config: OpenClawConfig;
  context: ResolverContext;
  warnings: SecretResolverWarning[];
}): Promise<OpenClawConfig> {
  const resolved = structuredClone(params.config);
  const providers = resolved.models?.providers as Record<string, ProviderLike> | undefined;
  if (providers) {
    for (const [providerId, provider] of Object.entries(providers)) {
      if (!isSecretRef(provider.apiKey)) {
        continue;
      }
      const resolvedValue = await resolveSecretRefValue(provider.apiKey, params.context);
      if (!isNonEmptyString(resolvedValue)) {
        throw new Error(
          `models.providers.${providerId}.apiKey resolved to a non-string or empty value.`,
        );
      }
      provider.apiKey = resolvedValue;
    }
  }

  const googleChat = resolved.channels?.googlechat as GoogleChatAccountLike | undefined;
  if (googleChat) {
    await resolveGoogleChatServiceAccount(
      googleChat,
      "channels.googlechat",
      params.context,
      params.warnings,
    );
    if (isRecord(googleChat.accounts)) {
      for (const [accountId, account] of Object.entries(googleChat.accounts)) {
        if (!isRecord(account)) {
          continue;
        }
        await resolveGoogleChatServiceAccount(
          account as GoogleChatAccountLike,
          `channels.googlechat.accounts.${accountId}`,
          params.context,
          params.warnings,
        );
      }
    }
  }

  return resolved;
}

async function resolveAuthStoreSecretRefs(params: {
  store: AuthProfileStore;
  context: ResolverContext;
  warnings: SecretResolverWarning[];
  agentDir: string;
}): Promise<AuthProfileStore> {
  const resolvedStore = structuredClone(params.store);
  for (const [profileId, profile] of Object.entries(resolvedStore.profiles)) {
    if (profile.type === "api_key") {
      const apiProfile = profile as ApiKeyCredentialLike;
      const keyRef = isSecretRef(apiProfile.keyRef) ? apiProfile.keyRef : null;
      if (keyRef && isNonEmptyString(apiProfile.key)) {
        params.warnings.push({
          code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
          path: `${params.agentDir}.auth-profiles.${profileId}.key`,
          message: `auth-profiles ${profileId}: keyRef is set; runtime will ignore plaintext key.`,
        });
      }
      if (keyRef) {
        const resolvedValue = await resolveSecretRefValue(keyRef, params.context);
        if (!isNonEmptyString(resolvedValue)) {
          throw new Error(`auth profile "${profileId}" keyRef resolved to an empty value.`);
        }
        apiProfile.key = resolvedValue;
      }
      continue;
    }

    if (profile.type === "token") {
      const tokenProfile = profile as TokenCredentialLike;
      const tokenRef = isSecretRef(tokenProfile.tokenRef) ? tokenProfile.tokenRef : null;
      if (tokenRef && isNonEmptyString(tokenProfile.token)) {
        params.warnings.push({
          code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
          path: `${params.agentDir}.auth-profiles.${profileId}.token`,
          message: `auth-profiles ${profileId}: tokenRef is set; runtime will ignore plaintext token.`,
        });
      }
      if (tokenRef) {
        const resolvedValue = await resolveSecretRefValue(tokenRef, params.context);
        if (!isNonEmptyString(resolvedValue)) {
          throw new Error(`auth profile "${profileId}" tokenRef resolved to an empty value.`);
        }
        tokenProfile.token = resolvedValue;
      }
    }
  }
  return resolvedStore;
}

function collectCandidateAgentDirs(config: OpenClawConfig): string[] {
  const dirs = new Set<string>();
  dirs.add(resolveUserPath(resolveOpenClawAgentDir()));
  for (const agentId of listAgentIds(config)) {
    dirs.add(resolveUserPath(resolveAgentDir(config, agentId)));
  }
  return [...dirs];
}

export async function prepareSecretsRuntimeSnapshot(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: string[];
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
}): Promise<PreparedSecretsRuntimeSnapshot> {
  const warnings: SecretResolverWarning[] = [];
  const context: ResolverContext = {
    config: params.config,
    env: params.env ?? process.env,
    fileSecretsPromise: null,
  };
  const resolvedConfig = await resolveConfigSecretRefs({
    config: params.config,
    context,
    warnings,
  });

  const loadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreForRuntime;
  const candidateDirs = params.agentDirs?.length
    ? [...new Set(params.agentDirs.map((entry) => resolveUserPath(entry)))]
    : collectCandidateAgentDirs(resolvedConfig);
  const authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  for (const agentDir of candidateDirs) {
    const rawStore = loadAuthStore(agentDir);
    const resolvedStore = await resolveAuthStoreSecretRefs({
      store: rawStore,
      context,
      warnings,
      agentDir,
    });
    authStores.push({ agentDir, store: resolvedStore });
  }

  return {
    config: resolvedConfig,
    authStores,
    warnings,
  };
}

export function activateSecretsRuntimeSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void {
  const next = cloneSnapshot(snapshot);
  setRuntimeConfigSnapshot(next.config);
  replaceRuntimeAuthProfileStoreSnapshots(next.authStores);
  activeSnapshot = next;
}

export function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null {
  return activeSnapshot ? cloneSnapshot(activeSnapshot) : null;
}

export function clearSecretsRuntimeSnapshot(): void {
  activeSnapshot = null;
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
}
