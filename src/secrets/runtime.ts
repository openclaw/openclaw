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
import { secretRefKey } from "./ref-contract.js";
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

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

let activeSnapshot: PreparedSecretsRuntimeSnapshot | null = null;

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

function pushAssignment(context: ResolverContext, assignment: SecretAssignment): void {
  context.assignments.push(assignment);
}

function collectModelProviderAssignments(params: {
  providers: Record<string, ProviderLike>;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  for (const [providerId, provider] of Object.entries(params.providers)) {
    const ref = coerceSecretRef(provider.apiKey, params.defaults);
    if (!ref) {
      continue;
    }
    pushAssignment(params.context, {
      ref,
      path: `models.providers.${providerId}.apiKey`,
      expected: "string",
      apply: (value) => {
        provider.apiKey = value;
      },
    });
  }
}

function collectSkillAssignments(params: {
  entries: Record<string, SkillEntryLike>;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  for (const [skillKey, entry] of Object.entries(params.entries)) {
    const ref = coerceSecretRef(entry.apiKey, params.defaults);
    if (!ref) {
      continue;
    }
    pushAssignment(params.context, {
      ref,
      path: `skills.entries.${skillKey}.apiKey`,
      expected: "string",
      apply: (value) => {
        entry.apiKey = value;
      },
    });
  }
}

function collectGoogleChatAccountAssignment(params: {
  target: GoogleChatAccountLike;
  path: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const explicitRef = coerceSecretRef(params.target.serviceAccountRef, params.defaults);
  const inlineRef = coerceSecretRef(params.target.serviceAccount, params.defaults);
  const ref = explicitRef ?? inlineRef;
  if (!ref) {
    return;
  }
  if (
    explicitRef &&
    params.target.serviceAccount !== undefined &&
    !coerceSecretRef(params.target.serviceAccount, params.defaults)
  ) {
    params.context.warnings.push({
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      path: params.path,
      message: `${params.path}: serviceAccountRef is set; runtime will ignore plaintext serviceAccount.`,
    });
  }
  pushAssignment(params.context, {
    ref,
    path: `${params.path}.serviceAccount`,
    expected: "string-or-object",
    apply: (value) => {
      params.target.serviceAccount = value;
    },
  });
}

function collectGoogleChatAssignments(params: {
  googleChat: GoogleChatAccountLike;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  collectGoogleChatAccountAssignment({
    target: params.googleChat,
    path: "channels.googlechat",
    defaults: params.defaults,
    context: params.context,
  });
  if (!isRecord(params.googleChat.accounts)) {
    return;
  }
  for (const [accountId, account] of Object.entries(params.googleChat.accounts)) {
    if (!isRecord(account)) {
      continue;
    }
    collectGoogleChatAccountAssignment({
      target: account as GoogleChatAccountLike,
      path: `channels.googlechat.accounts.${accountId}`,
      defaults: params.defaults,
      context: params.context,
    });
  }
}

function collectConfigAssignments(params: {
  config: OpenClawConfig;
  context: ResolverContext;
}): void {
  const defaults = params.context.sourceConfig.secrets?.defaults;
  const providers = params.config.models?.providers as Record<string, ProviderLike> | undefined;
  if (providers) {
    collectModelProviderAssignments({
      providers,
      defaults,
      context: params.context,
    });
  }

  const skillEntries = params.config.skills?.entries as Record<string, SkillEntryLike> | undefined;
  if (skillEntries) {
    collectSkillAssignments({
      entries: skillEntries,
      defaults,
      context: params.context,
    });
  }

  const googleChat = params.config.channels?.googlechat as GoogleChatAccountLike | undefined;
  if (googleChat) {
    collectGoogleChatAssignments({
      googleChat,
      defaults,
      context: params.context,
    });
  }
}

function collectApiKeyProfileAssignment(params: {
  profile: ApiKeyCredentialLike;
  profileId: string;
  agentDir: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const keyRef = coerceSecretRef(params.profile.keyRef, params.defaults);
  const inlineKeyRef = keyRef ? null : coerceSecretRef(params.profile.key, params.defaults);
  const resolvedKeyRef = keyRef ?? inlineKeyRef;
  if (!resolvedKeyRef) {
    return;
  }
  if (keyRef && isNonEmptyString(params.profile.key)) {
    params.context.warnings.push({
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      path: `${params.agentDir}.auth-profiles.${params.profileId}.key`,
      message: `auth-profiles ${params.profileId}: keyRef is set; runtime will ignore plaintext key.`,
    });
  }
  pushAssignment(params.context, {
    ref: resolvedKeyRef,
    path: `${params.agentDir}.auth-profiles.${params.profileId}.key`,
    expected: "string",
    apply: (value) => {
      params.profile.key = String(value);
    },
  });
}

function collectTokenProfileAssignment(params: {
  profile: TokenCredentialLike;
  profileId: string;
  agentDir: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const tokenRef = coerceSecretRef(params.profile.tokenRef, params.defaults);
  const inlineTokenRef = tokenRef ? null : coerceSecretRef(params.profile.token, params.defaults);
  const resolvedTokenRef = tokenRef ?? inlineTokenRef;
  if (!resolvedTokenRef) {
    return;
  }
  if (tokenRef && isNonEmptyString(params.profile.token)) {
    params.context.warnings.push({
      code: "SECRETS_REF_OVERRIDES_PLAINTEXT",
      path: `${params.agentDir}.auth-profiles.${params.profileId}.token`,
      message: `auth-profiles ${params.profileId}: tokenRef is set; runtime will ignore plaintext token.`,
    });
  }
  pushAssignment(params.context, {
    ref: resolvedTokenRef,
    path: `${params.agentDir}.auth-profiles.${params.profileId}.token`,
    expected: "string",
    apply: (value) => {
      params.profile.token = String(value);
    },
  });
}

function collectAuthStoreAssignments(params: {
  store: AuthProfileStore;
  context: ResolverContext;
  agentDir: string;
}): void {
  const defaults = params.context.sourceConfig.secrets?.defaults;
  for (const [profileId, profile] of Object.entries(params.store.profiles)) {
    if (profile.type === "api_key") {
      collectApiKeyProfileAssignment({
        profile: profile as ApiKeyCredentialLike,
        profileId,
        agentDir: params.agentDir,
        defaults,
        context: params.context,
      });
      continue;
    }
    if (profile.type === "token") {
      collectTokenProfileAssignment({
        profile: profile as TokenCredentialLike,
        profileId,
        agentDir: params.agentDir,
        defaults,
        context: params.context,
      });
    }
  }
}

function applyAssignments(params: {
  assignments: SecretAssignment[];
  resolved: Map<string, unknown>;
}): void {
  for (const assignment of params.assignments) {
    const key = secretRefKey(assignment.ref);
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
