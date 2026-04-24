import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  loadAuthProfileStoreForSecretsRuntime,
  resolveApiKeyForProfile,
} from "../agents/auth-profiles.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { callGatewayScoped } from "./call.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";

export type SecretOpsOptions = {
  agentId?: string;
  agentDir?: string;
  url?: string;
  timeoutMs?: number;
  token?: string;
  password?: string;
  configPath?: string;
};

type SecretOpsDeps = {
  callGatewayScoped: typeof callGatewayScoped;
  loadConfig: typeof loadConfig;
  loadAuthProfileStoreForSecretsRuntime: typeof loadAuthProfileStoreForSecretsRuntime;
  normalizeSecretInput: typeof normalizeSecretInput;
  resolveAgentDir: typeof resolveAgentDir;
  resolveApiKeyForProfile: typeof resolveApiKeyForProfile;
  updateAuthProfileStoreWithLock: typeof updateAuthProfileStoreWithLock;
};

const defaultDeps: SecretOpsDeps = {
  callGatewayScoped,
  loadConfig,
  loadAuthProfileStoreForSecretsRuntime,
  normalizeSecretInput,
  resolveAgentDir,
  resolveApiKeyForProfile,
  updateAuthProfileStoreWithLock,
};

class SecretOpsError extends Error {
  code: string;

  details: Record<string, unknown> | null;

  constructor(
    message: string,
    options: {
      code?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SecretOpsError";
    this.code = options.code ?? "secret_ops_failed";
    this.details = options.details ?? null;
  }
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function resolveGatewayTarget(config: OpenClawConfig, url: string | undefined) {
  const normalizedUrl = trimToUndefined(url);

  if (!normalizedUrl) {
    return {
      config,
      url: undefined,
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    return {
      config,
      url: normalizedUrl,
    };
  }

  if (
    (parsedUrl.protocol === "ws:" || parsedUrl.protocol === "wss:") &&
    isLoopbackHostname(parsedUrl.hostname)
  ) {
    const resolvedPort = Number.parseInt(parsedUrl.port, 10);
    const port = Number.isFinite(resolvedPort)
      ? resolvedPort
      : parsedUrl.protocol === "wss:"
        ? 443
        : 80;

    const localConfig: OpenClawConfig = {
        ...config,
        gateway: {
          ...config.gateway,
          mode: "local",
          port,
          tls: {
            ...config.gateway?.tls,
            enabled: parsedUrl.protocol === "wss:",
          },
        },
      };

    return {
      config: localConfig,
      url: undefined,
    };
  }

  return {
    config,
    url: normalizedUrl,
  };
}

function resolveContext(options: SecretOpsOptions, deps: SecretOpsDeps) {
  const config = deps.loadConfig();
  const agentId = trimToUndefined(options.agentId) ?? "jarvis-desktop";
  const agentDir = trimToUndefined(options.agentDir) ?? deps.resolveAgentDir(config, agentId);
  const provider = DEFAULT_PROVIDER;
  const profileId = `${provider}:${agentId}`;
  const gatewayTarget = resolveGatewayTarget(config, options.url);

  return {
    agentId,
    agentDir,
    config,
    gatewayTarget,
    profileId,
    provider,
  };
}

async function reloadSecretsInternal(options: SecretOpsOptions, deps: SecretOpsDeps) {
  const context = resolveContext(options, deps);
  const result: { ok?: boolean; warningCount?: number } = await deps.callGatewayScoped({
    method: "secrets.reload",
    scopes: [ADMIN_SCOPE],
    config: context.gatewayTarget.config,
    url: context.gatewayTarget.url,
    timeoutMs: options.timeoutMs,
    token: trimToUndefined(options.token),
    password: trimToUndefined(options.password),
    configPath: trimToUndefined(options.configPath),
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "Jarvis Desktop",
    clientVersion: "dev",
    platform: process.platform,
    mode: GATEWAY_CLIENT_MODES.CLI,
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
  });

  return {
    action: "reload-secrets",
    agentId: context.agentId,
    gatewayUrl: trimToUndefined(options.url) ?? null,
    ok: result?.ok !== false,
    warningCount:
      typeof result?.warningCount === "number" && Number.isFinite(result.warningCount)
        ? result.warningCount
        : 0,
  };
}

export async function reloadSecrets(
  options: SecretOpsOptions = {},
  deps: SecretOpsDeps = defaultDeps,
) {
  return await reloadSecretsInternal(options, deps);
}

export async function probeLiveApiKey(
  options: SecretOpsOptions = {},
  deps: SecretOpsDeps = defaultDeps,
) {
  const context = resolveContext(options, deps);
  const store = deps.loadAuthProfileStoreForSecretsRuntime(context.agentDir);
  const profile = store.profiles[context.profileId];

  if (!profile) {
    return {
      action: "probe-live-api-key",
      agentId: context.agentId,
      agentDir: context.agentDir,
      profileId: context.profileId,
      provider: context.provider,
      ready: false,
      reason: "missing_profile",
      gatewayUrl: trimToUndefined(options.url) ?? null,
      source: "openclaw-auth-store",
    };
  }

  const resolved = await deps.resolveApiKeyForProfile({
    cfg: context.config,
    store,
    profileId: context.profileId,
    agentDir: context.agentDir,
  });

  if (!resolved?.apiKey) {
    return {
      action: "probe-live-api-key",
      agentId: context.agentId,
      agentDir: context.agentDir,
      profileId: context.profileId,
      provider: context.provider,
      ready: false,
      reason: "auth_unresolved",
      gatewayUrl: trimToUndefined(options.url) ?? null,
      source: "openclaw-auth-store",
    };
  }

  return {
    action: "probe-live-api-key",
    agentId: context.agentId,
    agentDir: context.agentDir,
    profileId: context.profileId,
    provider: resolved.provider ?? context.provider,
    ready: true,
    reason: null,
    gatewayUrl: trimToUndefined(options.url) ?? null,
    source: "openclaw-auth-store",
  };
}

export async function applyLiveApiKey(
  options: SecretOpsOptions & { value: string },
  deps: SecretOpsDeps = defaultDeps,
) {
  const context = resolveContext(options, deps);
  const normalizedValue = deps.normalizeSecretInput(options.value);

  if (!normalizedValue) {
    throw new SecretOpsError("Live API key value cannot be empty.", {
      code: "invalid_request",
    });
  }

  const nextStore = await deps.updateAuthProfileStoreWithLock({
    agentDir: context.agentDir,
    updater: (store) => {
      store.profiles[context.profileId] = {
        type: "api_key",
        provider: context.provider,
        key: normalizedValue,
      };
      store.order = store.order ?? {};
      const providerOrder = Array.isArray(store.order[context.provider])
        ? store.order[context.provider]
        : [];
      const orderedProfileIds = [
        context.profileId,
        ...providerOrder.filter((profileId) => profileId !== context.profileId),
      ];
      store.order[context.provider] = orderedProfileIds;
      return true;
    },
  });

  if (!nextStore) {
    throw new SecretOpsError("Unable to update the OpenClaw auth profile store.", {
      code: "store_update_failed",
      details: {
        agentId: context.agentId,
        agentDir: context.agentDir,
        profileId: context.profileId,
      },
    });
  }

  const reload = await reloadSecretsInternal(options, deps);
  const probe = await probeLiveApiKey(options, deps);

  if (!probe.ready) {
    throw new SecretOpsError(
      "Live API key was stored, but OpenClaw could not resolve a runtime-ready credential for jarvis-desktop.",
      {
        code: "auth_unresolved",
        details: {
          ...probe,
          warningCount: reload.warningCount,
        },
      },
    );
  }

  return {
    action: "apply-live-api-key",
    agentId: context.agentId,
    agentDir: context.agentDir,
    profileId: context.profileId,
    provider: context.provider,
    ready: true,
    warningCount: reload.warningCount,
    gatewayUrl: trimToUndefined(options.url) ?? null,
    source: "openclaw-auth-store",
  };
}

export async function clearLiveApiKey(
  options: SecretOpsOptions = {},
  deps: SecretOpsDeps = defaultDeps,
) {
  const context = resolveContext(options, deps);
  const nextStore = await deps.updateAuthProfileStoreWithLock({
    agentDir: context.agentDir,
    updater: (store) => {
      let changed = false;

      if (store.profiles[context.profileId]) {
        delete store.profiles[context.profileId];
        changed = true;
      }

      if (store.order?.[context.provider]) {
        const nextOrder = store.order[context.provider].filter(
          (profileId) => profileId !== context.profileId,
        );
        if (nextOrder.length !== store.order[context.provider].length) {
          changed = true;
          if (nextOrder.length > 0) {
            store.order[context.provider] = nextOrder;
          } else {
            delete store.order[context.provider];
            if (Object.keys(store.order).length === 0) {
              store.order = undefined;
            }
          }
        }
      }

      if (store.lastGood?.[context.provider] === context.profileId) {
        delete store.lastGood[context.provider];
        changed = true;
        if (Object.keys(store.lastGood).length === 0) {
          store.lastGood = undefined;
        }
      }

      if (store.usageStats?.[context.profileId]) {
        delete store.usageStats[context.profileId];
        changed = true;
        if (Object.keys(store.usageStats).length === 0) {
          store.usageStats = undefined;
        }
      }

      return changed;
    },
  });

  if (!nextStore) {
    throw new SecretOpsError("Unable to update the OpenClaw auth profile store.", {
      code: "store_update_failed",
      details: {
        agentId: context.agentId,
        agentDir: context.agentDir,
        profileId: context.profileId,
      },
    });
  }

  const reload = await reloadSecretsInternal(options, deps);

  return {
    action: "clear-live-api-key",
    agentId: context.agentId,
    agentDir: context.agentDir,
    profileId: context.profileId,
    provider: context.provider,
    cleared: true,
    warningCount: reload.warningCount,
    gatewayUrl: trimToUndefined(options.url) ?? null,
    source: "openclaw-auth-store",
  };
}
