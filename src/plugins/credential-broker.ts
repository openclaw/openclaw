/** Executes manifest-declared credentialed requests without exposing resolved secrets to plugins. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readResponseWithLimit } from "@openclaw/media-core/read-response-with-limit";
import type { ResolvedConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { isToolAllowedByPolicies, isToolAllowedByPolicyName } from "../agents/tool-policy-match.js";
import {
  DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
  expandPolicyWithPluginGroups,
  mergeAlsoAllowPolicy,
  normalizeToolName,
  type PluginToolGroups,
} from "../agents/tool-policy.js";
import { withTrustedWebToolsEndpoint } from "../agents/tools/web-guarded-fetch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef } from "../config/types.secrets.js";
import { isValidSecretRef } from "../secrets/ref-contract.js";
import { isRecord } from "../utils.js";
import type {
  BrokeredCredentialJsonResponse,
  BrokeredCredentialRequestHandle,
  BrokeredCredentialRequestHandleSnapshot,
  OpenClawCredentialBroker,
} from "./credential-broker-types.js";
import type { PluginManifestCredentialBrokerOperation } from "./manifest.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

const REQUEST_HANDLE_TTL_MS = 30_000;
const REDACTED_VALUE = "[REDACTED]";

type CredentialBrokerDeps = {
  now: () => number;
  randomUUID: () => string;
  withTrustedWebToolsEndpoint: typeof withTrustedWebToolsEndpoint;
  env: NodeJS.ProcessEnv;
};

const defaultDeps: CredentialBrokerDeps = {
  now: Date.now,
  randomUUID,
  withTrustedWebToolsEndpoint,
  env: process.env,
};

class CredentialBrokerOperationError extends Error {}

export type CredentialBrokerContext = {
  profile: ResolvedConversationCapabilityProfile;
  sourceConfig: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
};

function readPath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split(".")) {
    const key = segment.trim();
    if (!key || (!Array.isArray(current) && !isRecord(current)) || !Object.hasOwn(current, key)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function readPluginConfig(config: OpenClawConfig, pluginId: string): unknown {
  return config.plugins?.entries?.[pluginId]?.config;
}

function omitPath(root: unknown, path: readonly string[]): unknown {
  const [key, ...rest] = path;
  if (!key || (!Array.isArray(root) && !isRecord(root)) || !Object.hasOwn(root, key)) {
    return root;
  }
  const copy = Array.isArray(root) ? [...root] : { ...root };
  if (rest.length === 0) {
    delete (copy as Record<string, unknown>)[key];
  } else {
    (copy as Record<string, unknown>)[key] = omitPath((copy as Record<string, unknown>)[key], rest);
  }
  return copy;
}

function replacePath(root: unknown, path: readonly string[], value: unknown): unknown {
  const [key, ...rest] = path;
  if (!key || (!Array.isArray(root) && !isRecord(root)) || !Object.hasOwn(root, key)) {
    return root;
  }
  const copy = Array.isArray(root) ? [...root] : { ...root };
  const record = copy as Record<string, unknown>;
  record[key] = rest.length === 0 ? value : replacePath(record[key], rest, value);
  return copy;
}

function cloneCredentialInput(value: unknown): unknown {
  return isSecretRef(value) ? { ...value } : value;
}

function omitBrokeredSecrets(
  config: OpenClawConfig | undefined,
  pluginId: string,
  paths: readonly string[],
): OpenClawConfig | undefined {
  let safeConfig: unknown = config;
  for (const path of paths) {
    safeConfig = omitPath(safeConfig, [
      "plugins",
      "entries",
      pluginId,
      "config",
      ...path.split("."),
    ]);
  }
  return safeConfig as OpenClawConfig | undefined;
}

type CredentialBrokerManifestPlugin = {
  id: string;
  credentialBroker?: {
    operations: readonly PluginManifestCredentialBrokerOperation[];
  };
};

export function hasConfiguredBrokeredSecretInputs(params: {
  sourceConfig: OpenClawConfig;
  plugins: readonly CredentialBrokerManifestPlugin[];
}): boolean {
  return params.plugins.some((plugin) =>
    plugin.credentialBroker?.operations.some((operation) =>
      hasOperationSecretRef({
        config: params.sourceConfig,
        pluginId: plugin.id,
        operation,
      }),
    ),
  );
}

/** Lists manifest tools whose credential input is an active structured SecretRef. */
export function listConfiguredBrokeredToolNames(params: {
  sourceConfig: OpenClawConfig;
  plugin: CredentialBrokerManifestPlugin;
}): string[] {
  return (params.plugin.credentialBroker?.operations ?? [])
    .filter((operation) =>
      hasOperationSecretRef({
        config: params.sourceConfig,
        pluginId: params.plugin.id,
        operation,
      }),
    )
    .map((operation) => operation.tool);
}

/** Removes every configured broker-owned secret before a plugin API can capture config. */
export function omitConfiguredBrokeredSecretInputs(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  plugins: readonly CredentialBrokerManifestPlugin[];
}): OpenClawConfig {
  let safeConfig: OpenClawConfig | undefined = params.config;
  for (const plugin of params.plugins) {
    const paths = (plugin.credentialBroker?.operations ?? [])
      .filter((operation) =>
        hasOperationSecretRef({
          config: params.sourceConfig,
          pluginId: plugin.id,
          operation,
        }),
      )
      .map((operation) => operation.secretInputPath);
    safeConfig = omitBrokeredSecrets(safeConfig, plugin.id, paths);
  }
  return safeConfig ?? params.config;
}

/** Restores opaque SecretRefs before tool-discovery plugin APIs capture resolved config. */
export function projectConfiguredBrokeredSecretInputs(params: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  plugins: readonly CredentialBrokerManifestPlugin[];
}): OpenClawConfig {
  let safeConfig: unknown = params.config;
  for (const plugin of params.plugins) {
    for (const operation of plugin.credentialBroker?.operations ?? []) {
      if (
        !hasOperationSecretRef({
          config: params.sourceConfig,
          pluginId: plugin.id,
          operation,
        })
      ) {
        continue;
      }
      const sourceValue = readPath(
        readPluginConfig(params.sourceConfig, plugin.id),
        operation.secretInputPath,
      );
      safeConfig = replacePath(
        safeConfig,
        ["plugins", "entries", plugin.id, "config", ...operation.secretInputPath.split(".")],
        cloneCredentialInput(sourceValue),
      );
    }
  }
  return safeConfig as OpenClawConfig;
}

/** Keeps broker-owned credential inputs on their prepared view while other config stays live. */
export function createCredentialBrokerSafeConfigGetter(params: {
  getRuntimeConfig?: () => OpenClawConfig | undefined;
  preparedConfig: OpenClawConfig;
  plugins: readonly CredentialBrokerManifestPlugin[];
}): () => OpenClawConfig {
  return () => {
    let safeConfig: unknown = params.getRuntimeConfig?.() ?? params.preparedConfig;
    for (const plugin of params.plugins) {
      for (const operation of plugin.credentialBroker?.operations ?? []) {
        const path = [
          "plugins",
          "entries",
          plugin.id,
          "config",
          ...operation.secretInputPath.split("."),
        ];
        const preparedValue = readPath(
          readPluginConfig(params.preparedConfig, plugin.id),
          operation.secretInputPath,
        );
        safeConfig =
          preparedValue === undefined
            ? omitPath(safeConfig, path)
            : replacePath(safeConfig, path, cloneCredentialInput(preparedValue));
      }
    }
    return safeConfig as OpenClawConfig;
  };
}

function hasOperationSecretRef(params: {
  config: OpenClawConfig;
  pluginId: string;
  operation: PluginManifestCredentialBrokerOperation;
}): boolean {
  const value = readPath(
    readPluginConfig(params.config, params.pluginId),
    params.operation.secretInputPath,
  );
  return isSecretRef(value) && isValidSecretRef(value);
}

function readOperationCredential(params: {
  config: OpenClawConfig;
  pluginId: string;
  operation: PluginManifestCredentialBrokerOperation;
}): string | undefined {
  const value = readPath(
    readPluginConfig(params.config, params.pluginId),
    params.operation.secretInputPath,
  );
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasExplicitScopedGrant(params: {
  pluginId: string;
  tool: string;
  defaultToolNames: readonly string[];
  profile: ResolvedConversationCapabilityProfile;
}): boolean {
  const explicitAllowlist = params.profile.policy.explicitToolAllowlist;
  const isDefaultTool = params.defaultToolNames.some(
    (toolName) => normalizeToolName(toolName) === normalizeToolName(params.tool),
  );
  const selectsDefaultPluginTools =
    explicitAllowlist.length === 0 ||
    explicitAllowlist.some(
      (entry) => normalizeToolName(entry) === DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
    );
  // The normal tool pipeline includes non-optional plugin tools when no
  // restrictive allowlist applies. Preserve that prepared, scoped selection.
  if (isDefaultTool && selectsDefaultPluginTools) {
    return true;
  }
  const raw = explicitAllowlist.filter(
    (entry) => normalizeToolName(entry) !== DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY,
  );
  raw.push(
    ...(params.profile.policy.profileAlsoAllow ?? []),
    ...(params.profile.policy.providerProfileAlsoAllow ?? []),
  );
  if (raw.length === 0) {
    return false;
  }
  const tool = normalizeToolName(params.tool);
  return isToolAllowedByPolicyName(
    tool,
    expandPolicyWithPluginGroups({ allow: raw }, buildOperationToolGroups(params.pluginId, tool)),
  );
}

function buildOperationToolGroups(pluginId: string, tool: string): PluginToolGroups {
  return {
    all: [tool],
    byPlugin: new Map([[normalizeToolName(pluginId), [tool]]]),
  };
}

function isAllowedByScopedPolicies(params: {
  pluginId: string;
  tool: string;
  profile: ResolvedConversationCapabilityProfile;
}): boolean {
  const tool = normalizeToolName(params.tool);
  const groups = buildOperationToolGroups(params.pluginId, tool);
  const [profilePolicy, providerProfilePolicy, ...remainingPolicies] =
    params.profile.policy.inheritancePolicies;
  const policies = [
    mergeAlsoAllowPolicy(profilePolicy, params.profile.policy.profileAlsoAllow),
    mergeAlsoAllowPolicy(providerProfilePolicy, params.profile.policy.providerProfileAlsoAllow),
    ...remainingPolicies,
  ].map((policy) => expandPolicyWithPluginGroups(policy, groups));
  return isToolAllowedByPolicies(tool, policies);
}

export function hasPreparedCredentialBrokerScope(
  profile: ResolvedConversationCapabilityProfile,
): boolean {
  return Boolean(
    profile.serviceIdentity?.agentId &&
    profile.conversation?.sessionKey &&
    (profile.conversation.messageChannel ?? profile.conversation.messageProvider) &&
    profile.sender?.id,
  );
}

function assertPreparedScope(params: {
  pluginId: string;
  operation: PluginManifestCredentialBrokerOperation;
  registrationToolNames: readonly string[];
  defaultToolNames: readonly string[];
  profile: ResolvedConversationCapabilityProfile;
}): void {
  const { profile, operation } = params;
  const registered = params.registrationToolNames.some(
    (name) => normalizeToolName(name) === normalizeToolName(operation.tool),
  );
  if (!registered) {
    throw new Error("Credential broker denied an undeclared tool operation.");
  }
  if (!hasPreparedCredentialBrokerScope(profile)) {
    throw new Error(
      "Credential broker requires prepared agent, conversation, channel, and sender scope.",
    );
  }
  if (
    !hasExplicitScopedGrant({
      pluginId: params.pluginId,
      tool: operation.tool,
      defaultToolNames: params.defaultToolNames,
      profile,
    }) ||
    !isAllowedByScopedPolicies({
      pluginId: params.pluginId,
      tool: operation.tool,
      profile,
    })
  ) {
    throw new Error("Credential broker denied this conversation capability profile.");
  }
}

function resolveDestination(params: {
  config: OpenClawConfig;
  pluginId: string;
  operation: PluginManifestCredentialBrokerOperation;
  env: NodeJS.ProcessEnv;
}): string {
  const pluginConfig = readPluginConfig(params.config, params.pluginId);
  const configuredBaseUrl = params.operation.baseUrlConfigPath
    ? readPath(pluginConfig, params.operation.baseUrlConfigPath)
    : undefined;
  const configuredBaseUrlValue =
    typeof configuredBaseUrl === "string" && configuredBaseUrl.trim()
      ? configuredBaseUrl.trim()
      : undefined;
  const environmentBaseUrl = params.operation.baseUrlEnv
    ? params.env[params.operation.baseUrlEnv]?.trim()
    : undefined;
  const baseUrl = configuredBaseUrlValue || environmentBaseUrl || params.operation.defaultBaseUrl;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Credential broker destination is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Credential broker destination must be a credential-free HTTPS base URL.");
  }
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${params.operation.path}`;
  return url.toString();
}

function parseJsonSecret(secret: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(secret) as unknown };
  } catch {
    return undefined;
  }
}

function replaceExactSecret(value: unknown, secret: string): unknown {
  return replaceExactSecretValue(value, secret, parseJsonSecret(secret), new WeakSet());
}

function replaceExactSecretValue(
  value: unknown,
  secret: string,
  jsonSecret: { value: unknown } | undefined,
  seen: WeakSet<object>,
): unknown {
  if (jsonSecret && isDeepStrictEqual(value, jsonSecret.value)) {
    return REDACTED_VALUE;
  }
  if (typeof value === "string") {
    return value.includes(secret) ? value.replaceAll(secret, REDACTED_VALUE) : value;
  }
  const matchesScalar = (value === null || typeof value === "boolean") && String(value) === secret;
  const matchesNumber = typeof value === "number" && String(value) === secret;
  if (matchesScalar || matchesNumber) {
    return REDACTED_VALUE;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((entry) => replaceExactSecretValue(entry, secret, jsonSecret, seen));
    seen.delete(value);
    return result;
  }
  if (!isRecord(value)) {
    seen.delete(value);
    return value;
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    const redactedKey = key.includes(secret) ? key.replaceAll(secret, REDACTED_VALUE) : key;
    result[redactedKey] = replaceExactSecretValue(entry, secret, jsonSecret, seen);
  }
  seen.delete(value);
  return result;
}

async function executeOperation(params: {
  pluginId: string;
  operation: PluginManifestCredentialBrokerOperation;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
  body: string;
  signal?: AbortSignal;
  deps: CredentialBrokerDeps;
}): Promise<BrokeredCredentialJsonResponse> {
  const destination = resolveDestination({
    config: params.sourceConfig,
    pluginId: params.pluginId,
    operation: params.operation,
    env: params.deps.env,
  });
  const credential = readOperationCredential({
    config: params.runtimeConfig,
    pluginId: params.pluginId,
    operation: params.operation,
  });
  if (!credential) {
    throw new Error("Credential broker could not resolve operation credentials.");
  }

  let headers: Headers;
  try {
    headers = new Headers(params.operation.headers);
    headers.set("Content-Type", "application/json");
    headers.set(
      params.operation.credentialHeader,
      params.operation.credentialScheme
        ? `${params.operation.credentialScheme} ${credential}`
        : credential,
    );
  } catch {
    throw new Error("Credential broker could not prepare operation credentials.");
  }

  try {
    return await params.deps.withTrustedWebToolsEndpoint(
      {
        url: destination,
        requireHttps: true,
        maxRedirects: 0,
        capture: false,
        auditContext: `credential-broker:${params.pluginId}:${params.operation.id}`,
        timeoutMs: params.operation.timeoutMs,
        signal: params.signal,
        init: {
          method: params.operation.method,
          headers,
          body: params.body,
        },
      },
      async ({ response }) => {
        if (!response.ok) {
          void response.body?.cancel();
          throw new CredentialBrokerOperationError(
            `Credential broker request failed with status ${response.status}.`,
          );
        }
        let bytes: Buffer;
        try {
          bytes = await readResponseWithLimit(response, params.operation.maxResponseBodyBytes);
        } catch {
          throw new CredentialBrokerOperationError(
            "Credential broker response exceeded its declared limit.",
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        } catch {
          throw new CredentialBrokerOperationError("Credential broker received malformed JSON.");
        }
        return {
          status: response.status,
          body: replaceExactSecret(parsed, credential),
        };
      },
    );
  } catch (error) {
    if (error instanceof CredentialBrokerOperationError) {
      throw error;
    }
    throw new Error("Credential broker request failed before receiving a response.");
  }
}

export function createCredentialBrokerClient(params: {
  pluginId: string;
  operations: readonly PluginManifestCredentialBrokerOperation[];
  registrationToolNames: readonly string[];
  defaultToolNames: readonly string[];
  context: CredentialBrokerContext;
  deps?: Partial<CredentialBrokerDeps>;
}): OpenClawCredentialBroker {
  const deps = { ...defaultDeps, ...params.deps };
  const operations = new Map(params.operations.map((operation) => [operation.id, operation]));

  return {
    isConfigured(operationId) {
      const operation = operations.get(operationId);
      return Boolean(
        operation &&
        hasOperationSecretRef({
          config: params.context.sourceConfig,
          pluginId: params.pluginId,
          operation,
        }),
      );
    },
    createRequest({ operationId, body }) {
      const operation = operations.get(operationId);
      if (!operation) {
        throw new Error("Credential broker operation is not declared.");
      }
      assertPreparedScope({
        pluginId: params.pluginId,
        operation,
        registrationToolNames: params.registrationToolNames,
        defaultToolNames: params.defaultToolNames,
        profile: params.context.profile,
      });
      const hasSecretRef = hasOperationSecretRef({
        config: params.context.sourceConfig,
        pluginId: params.pluginId,
        operation,
      });
      if (!hasSecretRef) {
        throw new Error("Credential broker operation has no configured SecretRef.");
      }
      const runtimeConfig = params.context.runtimeConfig;
      if (!runtimeConfig) {
        throw new Error("Credential broker requires a paired runtime credential snapshot.");
      }
      let serializedBody: string | undefined;
      try {
        serializedBody = JSON.stringify(body);
      } catch {
        throw new Error("Credential broker request body must be JSON serializable.");
      }
      if (typeof serializedBody !== "string") {
        throw new Error("Credential broker request body must be JSON serializable.");
      }
      if (Buffer.byteLength(serializedBody) > operation.maxRequestBodyBytes) {
        throw new Error("Credential broker request body exceeds its declared limit.");
      }

      const id = deps.randomUUID();
      const expiresAtMs = deps.now() + REQUEST_HANDLE_TTL_MS;
      let state: BrokeredCredentialRequestHandleSnapshot["state"] = "pending";
      const snapshot = (): BrokeredCredentialRequestHandleSnapshot => ({
        id,
        operationId,
        expiresAtMs,
        state,
      });
      const handle: BrokeredCredentialRequestHandle = {
        id,
        operationId,
        expiresAtMs,
        async execute(options) {
          if (state === "revoked") {
            throw new Error("Credential broker request handle was revoked.");
          }
          if (state !== "pending") {
            throw new Error("Credential broker request handle was already consumed.");
          }
          if (deps.now() >= expiresAtMs) {
            state = "revoked";
            throw new Error("Credential broker request handle expired.");
          }
          state = "running";
          try {
            return await executeOperation({
              pluginId: params.pluginId,
              operation,
              sourceConfig: params.context.sourceConfig,
              runtimeConfig,
              body: serializedBody,
              signal: options?.signal,
              deps,
            });
          } finally {
            state = "consumed";
          }
        },
        revoke() {
          if (state === "pending") {
            state = "revoked";
          }
        },
        toJSON: snapshot,
      };
      return handle;
    },
  };
}

/** Removes broker-owned credential inputs from the plugin-visible config snapshots. */
export function bindCredentialBrokerToToolContext(params: {
  context: OpenClawPluginToolContext;
  broker?: OpenClawCredentialBroker;
  sourceConfig: OpenClawConfig;
  pluginId: string;
  operations: readonly PluginManifestCredentialBrokerOperation[];
}): OpenClawPluginToolContext {
  const secretInputPaths = params.operations
    .filter((operation) =>
      hasOperationSecretRef({
        config: params.sourceConfig,
        pluginId: params.pluginId,
        operation,
      }),
    )
    .map((operation) => operation.secretInputPath);
  const configuredOperationIds = new Set(
    params.operations
      .filter((operation) => secretInputPaths.includes(operation.secretInputPath))
      .map((operation) => operation.id),
  );
  // Preserve the configured-broker signal on control-plane paths that lack conversation scope.
  // Otherwise a plugin could mistake the scrubbed config for literal/env fallback authorization.
  const credentialBroker: OpenClawCredentialBroker | undefined =
    params.broker ??
    (configuredOperationIds.size > 0
      ? {
          isConfigured: (operationId) => configuredOperationIds.has(operationId),
          createRequest: () => {
            throw new Error(
              "Credential broker requires a prepared conversation capability profile.",
            );
          },
        }
      : undefined);
  const getRuntimeConfig = params.context.getRuntimeConfig;
  const config = omitBrokeredSecrets(params.context.config, params.pluginId, secretInputPaths);
  const runtimeConfig = omitBrokeredSecrets(
    params.context.runtimeConfig,
    params.pluginId,
    secretInputPaths,
  );
  const preparedConfig = runtimeConfig ?? config;
  const safeConfigGetter =
    getRuntimeConfig && preparedConfig
      ? createCredentialBrokerSafeConfigGetter({
          getRuntimeConfig,
          preparedConfig,
          plugins: [
            {
              id: params.pluginId,
              credentialBroker: { operations: params.operations },
            },
          ],
        })
      : undefined;
  return {
    ...params.context,
    config,
    runtimeConfig,
    ...(safeConfigGetter ? { getRuntimeConfig: safeConfigGetter } : {}),
    ...(credentialBroker ? { credentialBroker } : {}),
  };
}
