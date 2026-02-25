import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { coerceSecretRef, type SecretRef } from "../config/types.secrets.js";
import { resolveUserPath } from "../utils.js";
import { resolveSecretRefValues, type SecretRefResolveCache } from "./resolve.js";
import { isNonEmptyString, isRecord } from "./shared.js";

type SecretResolverWarningCode = "SECRETS_REF_OVERRIDES_PLAINTEXT";

export type SecretResolverWarning = {
  code: SecretResolverWarningCode;
  path: string;
  message: string;
};

export type PreparedSecretsRuntimeSnapshot = {
  sourceConfig: OpenClawConfig;
  config: OpenClawConfig;
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
  warnings: SecretResolverWarning[];
};

type ProviderLike = {
  apiKey?: unknown;
};

type SkillEntryLike = {
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

type SecretAssignment = {
  ref: SecretRef;
  path: string;
  expected: "string" | "string-or-object";
  apply: (value: unknown) => void;
};

type ResolverContext = {
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  cache: SecretRefResolveCache;
  warnings: SecretResolverWarning[];
  assignments: SecretAssignment[];
};

let activeSnapshot: PreparedSecretsRuntimeSnapshot | null = null;

function toRefKey(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

function cloneSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: structuredClone(snapshot.sourceConfig),
    config: structuredClone(snapshot.config),
    authStores: snapshot.authStores.map((entry) => ({
      agentDir: entry.agentDir,
      store: structuredClone(entry.store),
    })),
    warnings: snapshot.warnings.map((warning) => ({ ...warning })),
  };
}

function collectConfigAssignments(params: {
  config: OpenClawConfig;
  context: ResolverContext;
}): void {
  const defaults = params.context.sourceConfig.secrets?.defaults;
  const providers = params.config.models?.providers as Record<string, ProviderLike> | undefined;
  if (providers) {
    for (const [providerId, provider] of Object.entries(providers)) {
      const ref = coerceSecretRef(provider.apiKey, defaults);
      if (!ref) {
        continue;
      }
      params.context.assignments.push({
        ref,
        path: `models.providers.${providerId}.apiKey`,
        expected: "string",
        apply: (value) => {
          provider.apiKey = value;
        },
      });
    }
  }

  const skillEntries = params.config.skills?.entries as Record<string, SkillEntryLike> | undefined;
  if (skillEntries) {
    for (const [skillKey, entry] of Object.entries(skillEntries)) {
      const ref = coerceSecretRef(entry.apiKey, defaults);
      if (!ref) {
        continue;
      }
      params.context.assignments.push({
        ref,
        path: `skills.entries.${skillKey}.apiKey`,
        expected: "string",
        apply: (value) => {
          entry.apiKey = value;
        },
      });
    }
  }

  const collectGoogleChatAssignments = (target: GoogleChatAccountLike, path: string) => {
    const explicitRef = coerceSecretRef(target.serviceAccountRef, defaults);
    const inlineRef = coerceSecretRef(target.serviceAccount, defaults);
    const ref = explicitRef ?? inlineRef;
    if (!ref) {
      return;
    }
    if (
      explicitRef &&
      target.serviceAccount !== undefined &&
      !coerceSecretRef(target.serviceAccount, defaults)
    ) {
      params.context.warnings.push({
        code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
        path,
        message: `${path}: serviceAccountRef is set; runtime will ignore plaintext serviceAccount.`,
      });
    }
    params.context.assignments.push({
      ref,
      path: `${path}.serviceAccount`,
      expected: "string-or-object",
      apply: (value) => {
        target.serviceAccount = value;
      },
    });
  };

  const googleChat = params.config.channels?.googlechat as GoogleChatAccountLike | undefined;
  if (googleChat) {
    collectGoogleChatAssignments(googleChat, "channels.googlechat");
    if (isRecord(googleChat.accounts)) {
      for (const [accountId, account] of Object.entries(googleChat.accounts)) {
        if (!isRecord(account)) {
          continue;
        }
        collectGoogleChatAssignments(
          account as GoogleChatAccountLike,
          `channels.googlechat.accounts.${accountId}`,
        );
      }
    }
  }
}

function collectAuthStoreAssignments(params: {
  store: AuthProfileStore;
  context: ResolverContext;
  agentDir: string;
}): void {
  const defaults = params.context.sourceConfig.secrets?.defaults;
  for (const [profileId, profile] of Object.entries(params.store.profiles)) {
    if (profile.type === "api_key") {
      const apiProfile = profile as ApiKeyCredentialLike;
      const keyRef = coerceSecretRef(apiProfile.keyRef, defaults);
      const inlineKeyRef = keyRef ? null : coerceSecretRef(apiProfile.key, defaults);
      const resolvedKeyRef = keyRef ?? inlineKeyRef;
      if (!resolvedKeyRef) {
        continue;
      }
      if (keyRef && isNonEmptyString(apiProfile.key)) {
        params.context.warnings.push({
          code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
          path: `${params.agentDir}.auth-profiles.${profileId}.key`,
          message: `auth-profiles ${profileId}: keyRef is set; runtime will ignore plaintext key.`,
        });
      }
      params.context.assignments.push({
        ref: resolvedKeyRef,
        path: `${params.agentDir}.auth-profiles.${profileId}.key`,
        expected: "string",
        apply: (value) => {
          apiProfile.key = String(value);
        },
      });
      continue;
    }

    if (profile.type === "token") {
      const tokenProfile = profile as TokenCredentialLike;
      const tokenRef = coerceSecretRef(tokenProfile.tokenRef, defaults);
      const inlineTokenRef = tokenRef ? null : coerceSecretRef(tokenProfile.token, defaults);
      const resolvedTokenRef = tokenRef ?? inlineTokenRef;
      if (!resolvedTokenRef) {
        continue;
      }
      if (tokenRef && isNonEmptyString(tokenProfile.token)) {
        params.context.warnings.push({
          code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
          path: `${params.agentDir}.auth-profiles.${profileId}.token`,
          message: `auth-profiles ${profileId}: tokenRef is set; runtime will ignore plaintext token.`,
        });
      }
      params.context.assignments.push({
        ref: resolvedTokenRef,
        path: `${params.agentDir}.auth-profiles.${profileId}.token`,
        expected: "string",
        apply: (value) => {
          tokenProfile.token = String(value);
        },
      });
    }
  }
}

function applyAssignments(params: {
  assignments: SecretAssignment[];
  resolved: Map<string, unknown>;
}): void {
  for (const assignment of params.assignments) {
    const key = toRefKey(assignment.ref);
    if (!params.resolved.has(key)) {
      throw new Error(`Secret reference "${key}" resolved to no value.`);
    }
    const value = params.resolved.get(key);
    if (assignment.expected === "string") {
      if (!isNonEmptyString(value)) {
        throw new Error(`${assignment.path} resolved to a non-string or empty value.`);
      }
      assignment.apply(value);
      continue;
    }
    if (!(isNonEmptyString(value) || isRecord(value))) {
      throw new Error(`${assignment.path} resolved to an unsupported value type.`);
    }
    assignment.apply(value);
  }
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
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(params.config);
  const context: ResolverContext = {
    sourceConfig,
    env: params.env ?? process.env,
    cache: {},
    warnings: [],
    assignments: [],
  };

  collectConfigAssignments({
    config: resolvedConfig,
    context,
  });

  const loadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime;
  const candidateDirs = params.agentDirs?.length
    ? [...new Set(params.agentDirs.map((entry) => resolveUserPath(entry)))]
    : collectCandidateAgentDirs(resolvedConfig);

  const authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  for (const agentDir of candidateDirs) {
    const store = structuredClone(loadAuthStore(agentDir));
    collectAuthStoreAssignments({
      store,
      context,
      agentDir,
    });
    authStores.push({ agentDir, store });
  }

  if (context.assignments.length > 0) {
    const refs = context.assignments.map((assignment) => assignment.ref);
    const resolved = await resolveSecretRefValues(refs, {
      config: sourceConfig,
      env: context.env,
      cache: context.cache,
    });
    applyAssignments({
      assignments: context.assignments,
      resolved,
    });
  }

  return {
    sourceConfig,
    config: resolvedConfig,
    authStores,
    warnings: context.warnings,
  };
}

export function activateSecretsRuntimeSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void {
  const next = cloneSnapshot(snapshot);
  setRuntimeConfigSnapshot(next.config, next.sourceConfig);
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
