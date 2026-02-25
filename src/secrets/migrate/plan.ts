import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { listAgentIds, resolveAgentDir } from "../../agents/agent-scope.js";
import { resolveAuthStorePath } from "../../agents/auth-profiles/paths.js";
import { resolveStateDir, type OpenClawConfig } from "../../config/config.js";
import { coerceSecretRef, DEFAULT_SECRET_PROVIDER_ALIAS } from "../../config/types.secrets.js";
import { resolveConfigDir, resolveUserPath } from "../../utils.js";
import {
  encodeJsonPointerToken,
  readJsonPointer as readJsonPointerRaw,
  setJsonPointer,
} from "../json-pointer.js";
import { listKnownSecretEnvVarNames } from "../provider-env-vars.js";
import { isNonEmptyString, isRecord } from "../shared.js";
import { createSecretsMigrationConfigIO } from "./config-io.js";
import type { AuthStoreChange, EnvChange, MigrationCounters, MigrationPlan } from "./types.js";

const DEFAULT_SECRETS_FILE_PATH = "~/.openclaw/secrets.json";

function readJsonPointer(root: unknown, pointer: string): unknown {
  return readJsonPointerRaw(root, pointer, { onMissing: "undefined" });
}

function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scrubEnvRaw(
  raw: string,
  migratedValues: Set<string>,
  allowedEnvKeys: Set<string>,
): {
  nextRaw: string;
  removed: number;
} {
  if (migratedValues.size === 0 || allowedEnvKeys.size === 0) {
    return { nextRaw: raw, removed: 0 };
  }
  const lines = raw.split(/\r?\n/);
  const nextLines: string[] = [];
  let removed = 0;
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      nextLines.push(line);
      continue;
    }
    const envKey = match[1] ?? "";
    if (!allowedEnvKeys.has(envKey)) {
      nextLines.push(line);
      continue;
    }
    const parsedValue = parseEnvValue(match[2] ?? "");
    if (migratedValues.has(parsedValue)) {
      removed += 1;
      continue;
    }
    nextLines.push(line);
  }
  const hadTrailingNewline = raw.endsWith("\n");
  const joined = nextLines.join("\n");
  return {
    nextRaw:
      hadTrailingNewline || joined.length === 0
        ? `${joined}${joined.endsWith("\n") ? "" : "\n"}`
        : joined,
    removed,
  };
}

function resolveFileSource(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): {
  providerName: string;
  path: string;
  hadConfiguredProvider: boolean;
} {
  const configuredProviders = config.secrets?.providers;
  const defaultProviderName =
    config.secrets?.defaults?.file?.trim() || DEFAULT_SECRET_PROVIDER_ALIAS;

  if (configuredProviders) {
    const defaultProvider = configuredProviders[defaultProviderName];
    if (defaultProvider?.source === "file" && isNonEmptyString(defaultProvider.path)) {
      return {
        providerName: defaultProviderName,
        path: resolveUserPath(defaultProvider.path),
        hadConfiguredProvider: true,
      };
    }

    for (const [providerName, provider] of Object.entries(configuredProviders)) {
      if (provider?.source === "file" && isNonEmptyString(provider.path)) {
        return {
          providerName,
          path: resolveUserPath(provider.path),
          hadConfiguredProvider: true,
        };
      }
    }
  }

  return {
    providerName: defaultProviderName,
    path: resolveUserPath(resolveDefaultSecretsConfigPath(env)),
    hadConfiguredProvider: false,
  };
}

function resolveDefaultSecretsConfigPath(env: NodeJS.ProcessEnv): string {
  if (env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim()) {
    return path.join(resolveStateDir(env, os.homedir), "secrets.json");
  }
  return DEFAULT_SECRETS_FILE_PATH;
}

async function readSecretsFileJson(pathname: string): Promise<Record<string, unknown>> {
  if (!fs.existsSync(pathname)) {
    return {};
  }
  const raw = fs.readFileSync(pathname, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Secrets file payload is not a JSON object.");
  }
  return parsed;
}

function migrateModelProviderSecrets(params: {
  config: OpenClawConfig;
  payload: Record<string, unknown>;
  counters: MigrationCounters;
  migratedValues: Set<string>;
  fileProviderName: string;
}): void {
  const providers = params.config.models?.providers as
    | Record<string, { apiKey?: unknown }>
    | undefined;
  if (!providers) {
    return;
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    if (coerceSecretRef(provider.apiKey)) {
      continue;
    }
    if (!isNonEmptyString(provider.apiKey)) {
      continue;
    }
    const value = provider.apiKey.trim();
    const id = `/providers/${encodeJsonPointerToken(providerId)}/apiKey`;
    const existing = readJsonPointer(params.payload, id);
    if (!isDeepStrictEqual(existing, value)) {
      setJsonPointer(params.payload, id, value);
      params.counters.secretsWritten += 1;
    }
    provider.apiKey = { source: "file", provider: params.fileProviderName, id };
    params.counters.configRefs += 1;
    params.migratedValues.add(value);
  }
}

function migrateSkillEntrySecrets(params: {
  config: OpenClawConfig;
  payload: Record<string, unknown>;
  counters: MigrationCounters;
  migratedValues: Set<string>;
  fileProviderName: string;
}): void {
  const entries = params.config.skills?.entries as Record<string, { apiKey?: unknown }> | undefined;
  if (!entries) {
    return;
  }
  for (const [skillKey, entry] of Object.entries(entries)) {
    if (!isRecord(entry) || coerceSecretRef(entry.apiKey)) {
      continue;
    }
    if (!isNonEmptyString(entry.apiKey)) {
      continue;
    }
    const value = entry.apiKey.trim();
    const id = `/skills/entries/${encodeJsonPointerToken(skillKey)}/apiKey`;
    const existing = readJsonPointer(params.payload, id);
    if (!isDeepStrictEqual(existing, value)) {
      setJsonPointer(params.payload, id, value);
      params.counters.secretsWritten += 1;
    }
    entry.apiKey = { source: "file", provider: params.fileProviderName, id };
    params.counters.configRefs += 1;
    params.migratedValues.add(value);
  }
}

function migrateGoogleChatServiceAccount(params: {
  account: Record<string, unknown>;
  pointerId: string;
  counters: MigrationCounters;
  payload: Record<string, unknown>;
  fileProviderName: string;
}): void {
  const explicitRef = coerceSecretRef(params.account.serviceAccountRef);
  const inlineRef = coerceSecretRef(params.account.serviceAccount);
  if (explicitRef || inlineRef) {
    if (
      params.account.serviceAccount !== undefined &&
      !coerceSecretRef(params.account.serviceAccount)
    ) {
      delete params.account.serviceAccount;
      params.counters.plaintextRemoved += 1;
    }
    return;
  }

  const value = params.account.serviceAccount;
  const hasStringValue = isNonEmptyString(value);
  const hasObjectValue = isRecord(value) && Object.keys(value).length > 0;
  if (!hasStringValue && !hasObjectValue) {
    return;
  }

  const id = `${params.pointerId}/serviceAccount`;
  const normalizedValue = hasStringValue ? value.trim() : structuredClone(value);
  const existing = readJsonPointer(params.payload, id);
  if (!isDeepStrictEqual(existing, normalizedValue)) {
    setJsonPointer(params.payload, id, normalizedValue);
    params.counters.secretsWritten += 1;
  }

  params.account.serviceAccountRef = {
    source: "file",
    provider: params.fileProviderName,
    id,
  };
  delete params.account.serviceAccount;
  params.counters.configRefs += 1;
}

function migrateGoogleChatSecrets(params: {
  config: OpenClawConfig;
  payload: Record<string, unknown>;
  counters: MigrationCounters;
  fileProviderName: string;
}): void {
  const googlechat = params.config.channels?.googlechat;
  if (!isRecord(googlechat)) {
    return;
  }

  migrateGoogleChatServiceAccount({
    account: googlechat,
    pointerId: "/channels/googlechat",
    payload: params.payload,
    counters: params.counters,
    fileProviderName: params.fileProviderName,
  });

  if (!isRecord(googlechat.accounts)) {
    return;
  }
  for (const [accountId, accountValue] of Object.entries(googlechat.accounts)) {
    if (!isRecord(accountValue)) {
      continue;
    }
    migrateGoogleChatServiceAccount({
      account: accountValue,
      pointerId: `/channels/googlechat/accounts/${encodeJsonPointerToken(accountId)}`,
      payload: params.payload,
      counters: params.counters,
      fileProviderName: params.fileProviderName,
    });
  }
}

function collectAuthStorePaths(config: OpenClawConfig, stateDir: string): string[] {
  const paths = new Set<string>();
  paths.add(resolveUserPath(resolveAuthStorePath()));

  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      paths.add(path.join(agentsRoot, entry.name, "agent", "auth-profiles.json"));
    }
  }

  for (const agentId of listAgentIds(config)) {
    const agentDir = resolveAgentDir(config, agentId);
    paths.add(resolveUserPath(resolveAuthStorePath(agentDir)));
  }

  return [...paths];
}

function deriveAuthStoreScope(authStorePath: string, stateDir: string): string {
  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  const relative = path.relative(agentsRoot, authStorePath);
  if (!relative.startsWith("..")) {
    const segments = relative.split(path.sep);
    if (segments.length >= 3 && segments[1] === "agent" && segments[2] === "auth-profiles.json") {
      const candidate = segments[0]?.trim();
      if (candidate) {
        return candidate;
      }
    }
  }

  const digest = crypto.createHash("sha1").update(authStorePath).digest("hex").slice(0, 8);
  return `path-${digest}`;
}

function migrateAuthStoreSecrets(params: {
  store: Record<string, unknown>;
  scope: string;
  payload: Record<string, unknown>;
  counters: MigrationCounters;
  migratedValues: Set<string>;
  fileProviderName: string;
}): boolean {
  const profiles = params.store.profiles;
  if (!isRecord(profiles)) {
    return false;
  }

  let changed = false;
  for (const [profileId, profileValue] of Object.entries(profiles)) {
    if (!isRecord(profileValue)) {
      continue;
    }
    if (profileValue.type === "api_key") {
      const keyRef = coerceSecretRef(profileValue.keyRef);
      const key = isNonEmptyString(profileValue.key) ? profileValue.key.trim() : "";
      if (keyRef) {
        if (key) {
          delete profileValue.key;
          params.counters.plaintextRemoved += 1;
          changed = true;
        }
        continue;
      }
      if (!key) {
        continue;
      }
      const id = `/auth-profiles/${encodeJsonPointerToken(params.scope)}/${encodeJsonPointerToken(profileId)}/key`;
      const existing = readJsonPointer(params.payload, id);
      if (!isDeepStrictEqual(existing, key)) {
        setJsonPointer(params.payload, id, key);
        params.counters.secretsWritten += 1;
      }
      profileValue.keyRef = { source: "file", provider: params.fileProviderName, id };
      delete profileValue.key;
      params.counters.authProfileRefs += 1;
      params.migratedValues.add(key);
      changed = true;
      continue;
    }

    if (profileValue.type === "token") {
      const tokenRef = coerceSecretRef(profileValue.tokenRef);
      const token = isNonEmptyString(profileValue.token) ? profileValue.token.trim() : "";
      if (tokenRef) {
        if (token) {
          delete profileValue.token;
          params.counters.plaintextRemoved += 1;
          changed = true;
        }
        continue;
      }
      if (!token) {
        continue;
      }
      const id = `/auth-profiles/${encodeJsonPointerToken(params.scope)}/${encodeJsonPointerToken(profileId)}/token`;
      const existing = readJsonPointer(params.payload, id);
      if (!isDeepStrictEqual(existing, token)) {
        setJsonPointer(params.payload, id, token);
        params.counters.secretsWritten += 1;
      }
      profileValue.tokenRef = { source: "file", provider: params.fileProviderName, id };
      delete profileValue.token;
      params.counters.authProfileRefs += 1;
      params.migratedValues.add(token);
      changed = true;
    }
  }

  return changed;
}

export async function buildMigrationPlan(params: {
  env: NodeJS.ProcessEnv;
  scrubEnv: boolean;
}): Promise<MigrationPlan> {
  const io = createSecretsMigrationConfigIO({ env: params.env });
  const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    const issues =
      snapshot.issues.length > 0
        ? snapshot.issues.map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("\n")
        : "Unknown validation issue.";
    throw new Error(`Cannot migrate secrets because config is invalid:\n${issues}`);
  }

  const stateDir = resolveStateDir(params.env, os.homedir);
  const nextConfig = structuredClone(snapshot.config);
  const fileSource = resolveFileSource(nextConfig, params.env);
  const previousPayload = await readSecretsFileJson(fileSource.path);
  const nextPayload = structuredClone(previousPayload);

  const counters: MigrationCounters = {
    configRefs: 0,
    authProfileRefs: 0,
    plaintextRemoved: 0,
    secretsWritten: 0,
    envEntriesRemoved: 0,
    authStoresChanged: 0,
  };

  const migratedValues = new Set<string>();

  migrateModelProviderSecrets({
    config: nextConfig,
    payload: nextPayload,
    counters,
    migratedValues,
    fileProviderName: fileSource.providerName,
  });
  migrateSkillEntrySecrets({
    config: nextConfig,
    payload: nextPayload,
    counters,
    migratedValues,
    fileProviderName: fileSource.providerName,
  });
  migrateGoogleChatSecrets({
    config: nextConfig,
    payload: nextPayload,
    counters,
    fileProviderName: fileSource.providerName,
  });

  const authStoreChanges: AuthStoreChange[] = [];
  for (const authStorePath of collectAuthStorePaths(nextConfig, stateDir)) {
    if (!fs.existsSync(authStorePath)) {
      continue;
    }
    const raw = fs.readFileSync(authStorePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }

    const nextStore = structuredClone(parsed);
    const scope = deriveAuthStoreScope(authStorePath, stateDir);
    const changed = migrateAuthStoreSecrets({
      store: nextStore,
      scope,
      payload: nextPayload,
      counters,
      migratedValues,
      fileProviderName: fileSource.providerName,
    });
    if (!changed) {
      continue;
    }
    authStoreChanges.push({ path: authStorePath, nextStore });
  }
  counters.authStoresChanged = authStoreChanges.length;

  if (counters.secretsWritten > 0 && !fileSource.hadConfiguredProvider) {
    const defaultConfigPath = resolveDefaultSecretsConfigPath(params.env);
    nextConfig.secrets ??= {};
    nextConfig.secrets.providers ??= {};
    nextConfig.secrets.providers[fileSource.providerName] = {
      source: "file",
      path: defaultConfigPath,
      mode: "jsonPointer",
    };
    nextConfig.secrets.defaults ??= {};
    nextConfig.secrets.defaults.file ??= fileSource.providerName;
  }

  const configChanged = !isDeepStrictEqual(snapshot.config, nextConfig);
  const payloadChanged = !isDeepStrictEqual(previousPayload, nextPayload);

  let envChange: EnvChange | null = null;
  if (params.scrubEnv && migratedValues.size > 0) {
    const envPath = path.join(resolveConfigDir(params.env, os.homedir), ".env");
    if (fs.existsSync(envPath)) {
      const rawEnv = fs.readFileSync(envPath, "utf8");
      const scrubbed = scrubEnvRaw(rawEnv, migratedValues, new Set(listKnownSecretEnvVarNames()));
      if (scrubbed.removed > 0 && scrubbed.nextRaw !== rawEnv) {
        counters.envEntriesRemoved = scrubbed.removed;
        envChange = {
          path: envPath,
          nextRaw: scrubbed.nextRaw,
        };
      }
    }
  }

  const backupTargets = new Set<string>();
  if (configChanged) {
    backupTargets.add(io.configPath);
  }
  if (payloadChanged) {
    backupTargets.add(fileSource.path);
  }
  for (const change of authStoreChanges) {
    backupTargets.add(change.path);
  }
  if (envChange) {
    backupTargets.add(envChange.path);
  }

  return {
    changed: configChanged || payloadChanged || authStoreChanges.length > 0 || Boolean(envChange),
    counters,
    stateDir,
    configChanged,
    nextConfig,
    configWriteOptions: writeOptions,
    authStoreChanges,
    payloadChanged,
    nextPayload,
    secretsFilePath: fileSource.path,
    envChange,
    backupTargets: [...backupTargets],
  };
}
