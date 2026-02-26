import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { resolveStateDir, type OpenClawConfig } from "../config/config.js";
import { coerceSecretRef, type SecretRef } from "../config/types.secrets.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { createSecretsConfigIO } from "./config-io.js";
import { listKnownSecretEnvVarNames } from "./provider-env-vars.js";
import { secretRefKey } from "./ref-contract.js";
import {
  resolveSecretRefValue,
  resolveSecretRefValues,
  type SecretRefResolveCache,
} from "./resolve.js";
import { isNonEmptyString, isRecord } from "./shared.js";

export type SecretsAuditCode =
  | "PLAINTEXT_FOUND"
  | "REF_UNRESOLVED"
  | "REF_SHADOWED"
  | "LEGACY_RESIDUE";

export type SecretsAuditSeverity = "info" | "warn" | "error";

export type SecretsAuditFinding = {
  code: SecretsAuditCode;
  severity: SecretsAuditSeverity;
  file: string;
  jsonPath: string;
  message: string;
  provider?: string;
  profileId?: string;
};

export type SecretsAuditStatus = "clean" | "findings" | "unresolved";

export type SecretsAuditReport = {
  version: 1;
  status: SecretsAuditStatus;
  filesScanned: string[];
  summary: {
    plaintextCount: number;
    unresolvedRefCount: number;
    shadowedRefCount: number;
    legacyResidueCount: number;
  };
  findings: SecretsAuditFinding[];
};

type RefAssignment = {
  file: string;
  path: string;
  ref: SecretRef;
  expected: "string" | "string-or-object";
  provider?: string;
};

type ProviderAuthState = {
  hasUsableStaticOrOAuth: boolean;
  modes: Set<"api_key" | "token" | "oauth">;
};

type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
};

type AuditCollector = {
  findings: SecretsAuditFinding[];
  refAssignments: RefAssignment[];
  configProviderRefPaths: Map<string, string[]>;
  authProviderState: Map<string, ProviderAuthState>;
  filesScanned: Set<string>;
};

function addFinding(collector: AuditCollector, finding: SecretsAuditFinding): void {
  collector.findings.push(finding);
}

function collectProviderRefPath(
  collector: AuditCollector,
  providerId: string,
  configPath: string,
): void {
  const key = normalizeProviderId(providerId);
  const existing = collector.configProviderRefPaths.get(key);
  if (existing) {
    existing.push(configPath);
    return;
  }
  collector.configProviderRefPaths.set(key, [configPath]);
}

function trackAuthProviderState(
  collector: AuditCollector,
  provider: string,
  mode: "api_key" | "token" | "oauth",
): void {
  const key = normalizeProviderId(provider);
  const existing = collector.authProviderState.get(key);
  if (existing) {
    existing.hasUsableStaticOrOAuth = true;
    existing.modes.add(mode);
    return;
  }
  collector.authProviderState.set(key, {
    hasUsableStaticOrOAuth: true,
    modes: new Set([mode]),
  });
}

function parseDotPath(pathname: string): string[] {
  return pathname.split(".").filter(Boolean);
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

function collectEnvPlaintext(params: { envPath: string; collector: AuditCollector }): void {
  if (!fs.existsSync(params.envPath)) {
    return;
  }
  params.collector.filesScanned.add(params.envPath);
  const knownKeys = new Set(listKnownSecretEnvVarNames());
  const raw = fs.readFileSync(params.envPath, "utf8");
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1] ?? "";
    if (!knownKeys.has(key)) {
      continue;
    }
    const value = parseEnvValue(match[2] ?? "");
    if (!value) {
      continue;
    }
    addFinding(params.collector, {
      code: "PLAINTEXT_FOUND",
      severity: "warn",
      file: params.envPath,
      jsonPath: `$env.${key}`,
      message: `Potential secret found in .env (${key}).`,
    });
  }
}

function readJsonObject(filePath: string): {
  value: Record<string, unknown> | null;
  error?: string;
} {
  if (!fs.existsSync(filePath)) {
    return { value: null };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { value: null };
    }
    return { value: parsed };
  } catch (err) {
    return {
      value: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function collectConfigSecrets(params: {
  config: OpenClawConfig;
  configPath: string;
  collector: AuditCollector;
}): void {
  const defaults = params.config.secrets?.defaults;
  const providers = params.config.models?.providers as
    | Record<string, { apiKey?: unknown }>
    | undefined;
  if (providers) {
    for (const [providerId, provider] of Object.entries(providers)) {
      const pathLabel = `models.providers.${providerId}.apiKey`;
      const ref = coerceSecretRef(provider.apiKey, defaults);
      if (ref) {
        params.collector.refAssignments.push({
          file: params.configPath,
          path: pathLabel,
          ref,
          expected: "string",
          provider: providerId,
        });
        collectProviderRefPath(params.collector, providerId, pathLabel);
        continue;
      }
      if (isNonEmptyString(provider.apiKey)) {
        addFinding(params.collector, {
          code: "PLAINTEXT_FOUND",
          severity: "warn",
          file: params.configPath,
          jsonPath: pathLabel,
          message: "Provider apiKey is stored as plaintext.",
          provider: providerId,
        });
      }
    }
  }

  const entries = params.config.skills?.entries as Record<string, { apiKey?: unknown }> | undefined;
  if (entries) {
    for (const [entryId, entry] of Object.entries(entries)) {
      const pathLabel = `skills.entries.${entryId}.apiKey`;
      const ref = coerceSecretRef(entry.apiKey, defaults);
      if (ref) {
        params.collector.refAssignments.push({
          file: params.configPath,
          path: pathLabel,
          ref,
          expected: "string",
        });
        continue;
      }
      if (isNonEmptyString(entry.apiKey)) {
        addFinding(params.collector, {
          code: "PLAINTEXT_FOUND",
          severity: "warn",
          file: params.configPath,
          jsonPath: pathLabel,
          message: "Skill apiKey is stored as plaintext.",
        });
      }
    }
  }

  const googlechat = params.config.channels?.googlechat as
    | {
        serviceAccount?: unknown;
        serviceAccountRef?: unknown;
        accounts?: Record<string, unknown>;
      }
    | undefined;
  if (!googlechat) {
    return;
  }

  const collectGoogleChatValue = (
    value: unknown,
    refValue: unknown,
    pathLabel: string,
    accountId?: string,
  ) => {
    const explicitRef = coerceSecretRef(refValue, defaults);
    const inlineRef = explicitRef ? null : coerceSecretRef(value, defaults);
    const ref = explicitRef ?? inlineRef;
    if (ref) {
      params.collector.refAssignments.push({
        file: params.configPath,
        path: pathLabel,
        ref,
        expected: "string-or-object",
        provider: accountId ? "googlechat" : undefined,
      });
      return;
    }
    if (isNonEmptyString(value) || (isRecord(value) && Object.keys(value).length > 0)) {
      addFinding(params.collector, {
        code: "PLAINTEXT_FOUND",
        severity: "warn",
        file: params.configPath,
        jsonPath: pathLabel,
        message: "Google Chat serviceAccount is stored as plaintext.",
      });
    }
  };

  collectGoogleChatValue(
    googlechat.serviceAccount,
    googlechat.serviceAccountRef,
    "channels.googlechat.serviceAccount",
  );
  if (!isRecord(googlechat.accounts)) {
    return;
  }
  for (const [accountId, accountValue] of Object.entries(googlechat.accounts)) {
    if (!isRecord(accountValue)) {
      continue;
    }
    collectGoogleChatValue(
      accountValue.serviceAccount,
      accountValue.serviceAccountRef,
      `channels.googlechat.accounts.${accountId}.serviceAccount`,
      accountId,
    );
  }
}

function collectAuthStorePaths(config: OpenClawConfig, stateDir: string): string[] {
  const paths = new Set<string>();
  // Scope default auth store discovery to the provided stateDir instead of
  // ambient process env, so audits do not include unrelated host-global stores.
  paths.add(path.join(resolveUserPath(stateDir), "agents", "main", "agent", "auth-profiles.json"));

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
    if (agentId === "main") {
      paths.add(
        path.join(resolveUserPath(stateDir), "agents", "main", "agent", "auth-profiles.json"),
      );
      continue;
    }
    const agentDir = resolveAgentDir(config, agentId);
    paths.add(resolveUserPath(resolveAuthStorePath(agentDir)));
  }

  return [...paths];
}

function collectAuthStoreSecrets(params: {
  authStorePath: string;
  collector: AuditCollector;
  defaults?: SecretDefaults;
}): void {
  if (!fs.existsSync(params.authStorePath)) {
    return;
  }
  params.collector.filesScanned.add(params.authStorePath);
  const parsedResult = readJsonObject(params.authStorePath);
  if (parsedResult.error) {
    addFinding(params.collector, {
      code: "REF_UNRESOLVED",
      severity: "error",
      file: params.authStorePath,
      jsonPath: "<root>",
      message: `Invalid JSON in auth-profiles store: ${parsedResult.error}`,
    });
    return;
  }
  const parsed = parsedResult.value;
  if (!parsed || !isRecord(parsed.profiles)) {
    return;
  }
  for (const [profileId, profileValue] of Object.entries(parsed.profiles)) {
    if (!isRecord(profileValue) || !isNonEmptyString(profileValue.provider)) {
      continue;
    }
    const provider = String(profileValue.provider);
    if (profileValue.type === "api_key") {
      const keyRef = coerceSecretRef(profileValue.keyRef, params.defaults);
      const inlineRef = keyRef ? null : coerceSecretRef(profileValue.key, params.defaults);
      const ref = keyRef ?? inlineRef;
      if (ref) {
        params.collector.refAssignments.push({
          file: params.authStorePath,
          path: `profiles.${profileId}.key`,
          ref,
          expected: "string",
          provider,
        });
        trackAuthProviderState(params.collector, provider, "api_key");
      }
      if (isNonEmptyString(profileValue.key)) {
        addFinding(params.collector, {
          code: "PLAINTEXT_FOUND",
          severity: "warn",
          file: params.authStorePath,
          jsonPath: `profiles.${profileId}.key`,
          message: "Auth profile API key is stored as plaintext.",
          provider,
          profileId,
        });
        trackAuthProviderState(params.collector, provider, "api_key");
      }
      continue;
    }
    if (profileValue.type === "token") {
      const tokenRef = coerceSecretRef(profileValue.tokenRef, params.defaults);
      const inlineRef = tokenRef ? null : coerceSecretRef(profileValue.token, params.defaults);
      const ref = tokenRef ?? inlineRef;
      if (ref) {
        params.collector.refAssignments.push({
          file: params.authStorePath,
          path: `profiles.${profileId}.token`,
          ref,
          expected: "string",
          provider,
        });
        trackAuthProviderState(params.collector, provider, "token");
      }
      if (isNonEmptyString(profileValue.token)) {
        addFinding(params.collector, {
          code: "PLAINTEXT_FOUND",
          severity: "warn",
          file: params.authStorePath,
          jsonPath: `profiles.${profileId}.token`,
          message: "Auth profile token is stored as plaintext.",
          provider,
          profileId,
        });
        trackAuthProviderState(params.collector, provider, "token");
      }
      continue;
    }
    if (profileValue.type === "oauth") {
      const hasAccess = isNonEmptyString(profileValue.access);
      const hasRefresh = isNonEmptyString(profileValue.refresh);
      if (hasAccess || hasRefresh) {
        addFinding(params.collector, {
          code: "LEGACY_RESIDUE",
          severity: "info",
          file: params.authStorePath,
          jsonPath: `profiles.${profileId}`,
          message: "OAuth credentials are present (out of scope for static SecretRef migration).",
          provider,
          profileId,
        });
        trackAuthProviderState(params.collector, provider, "oauth");
      }
    }
  }
}

function collectAuthJsonResidue(params: { stateDir: string; collector: AuditCollector }): void {
  const agentsRoot = path.join(resolveUserPath(params.stateDir), "agents");
  if (!fs.existsSync(agentsRoot)) {
    return;
  }
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const authJsonPath = path.join(agentsRoot, entry.name, "agent", "auth.json");
    if (!fs.existsSync(authJsonPath)) {
      continue;
    }
    params.collector.filesScanned.add(authJsonPath);
    const parsedResult = readJsonObject(authJsonPath);
    if (parsedResult.error) {
      addFinding(params.collector, {
        code: "REF_UNRESOLVED",
        severity: "error",
        file: authJsonPath,
        jsonPath: "<root>",
        message: `Invalid JSON in legacy auth.json: ${parsedResult.error}`,
      });
      continue;
    }
    const parsed = parsedResult.value;
    if (!parsed) {
      continue;
    }
    for (const [providerId, value] of Object.entries(parsed)) {
      if (!isRecord(value)) {
        continue;
      }
      if (value.type === "api_key" && isNonEmptyString(value.key)) {
        addFinding(params.collector, {
          code: "LEGACY_RESIDUE",
          severity: "warn",
          file: authJsonPath,
          jsonPath: providerId,
          message: "Legacy auth.json contains static api_key credentials.",
          provider: providerId,
        });
      }
    }
  }
}

async function collectUnresolvedRefFindings(params: {
  collector: AuditCollector;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const cache: SecretRefResolveCache = {};
  const refsByProvider = new Map<string, Map<string, SecretRef>>();
  for (const assignment of params.collector.refAssignments) {
    const providerKey = `${assignment.ref.source}:${assignment.ref.provider}`;
    let refsForProvider = refsByProvider.get(providerKey);
    if (!refsForProvider) {
      refsForProvider = new Map<string, SecretRef>();
      refsByProvider.set(providerKey, refsForProvider);
    }
    refsForProvider.set(secretRefKey(assignment.ref), assignment.ref);
  }

  const resolvedByRefKey = new Map<string, unknown>();
  const errorsByRefKey = new Map<string, unknown>();

  for (const refsForProvider of refsByProvider.values()) {
    const refs = [...refsForProvider.values()];
    try {
      const resolved = await resolveSecretRefValues(refs, {
        config: params.config,
        env: params.env,
        cache,
      });
      for (const [key, value] of resolved.entries()) {
        resolvedByRefKey.set(key, value);
      }
      continue;
    } catch {
      // Fall back to per-ref resolution for provider-specific pinpoint errors.
    }

    for (const ref of refs) {
      const key = secretRefKey(ref);
      try {
        const resolved = await resolveSecretRefValue(ref, {
          config: params.config,
          env: params.env,
          cache,
        });
        resolvedByRefKey.set(key, resolved);
      } catch (err) {
        errorsByRefKey.set(key, err);
      }
    }
  }

  for (const assignment of params.collector.refAssignments) {
    const key = secretRefKey(assignment.ref);
    const resolveErr = errorsByRefKey.get(key);
    if (resolveErr) {
      addFinding(params.collector, {
        code: "REF_UNRESOLVED",
        severity: "error",
        file: assignment.file,
        jsonPath: assignment.path,
        message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (${describeUnknownError(resolveErr)}).`,
        provider: assignment.provider,
      });
      continue;
    }

    if (!resolvedByRefKey.has(key)) {
      addFinding(params.collector, {
        code: "REF_UNRESOLVED",
        severity: "error",
        file: assignment.file,
        jsonPath: assignment.path,
        message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is missing).`,
        provider: assignment.provider,
      });
      continue;
    }

    const resolved = resolvedByRefKey.get(key);
    if (assignment.expected === "string") {
      if (!isNonEmptyString(resolved)) {
        addFinding(params.collector, {
          code: "REF_UNRESOLVED",
          severity: "error",
          file: assignment.file,
          jsonPath: assignment.path,
          message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is not a non-empty string).`,
          provider: assignment.provider,
        });
      }
      continue;
    }
    if (!(isNonEmptyString(resolved) || isRecord(resolved))) {
      addFinding(params.collector, {
        code: "REF_UNRESOLVED",
        severity: "error",
        file: assignment.file,
        jsonPath: assignment.path,
        message: `Failed to resolve ${assignment.ref.source}:${assignment.ref.provider}:${assignment.ref.id} (resolved value is not a string/object).`,
        provider: assignment.provider,
      });
    }
  }
}

function collectShadowingFindings(collector: AuditCollector): void {
  for (const [provider, paths] of collector.configProviderRefPaths.entries()) {
    const authState = collector.authProviderState.get(provider);
    if (!authState?.hasUsableStaticOrOAuth) {
      continue;
    }
    const modeText = [...authState.modes].join("/");
    for (const configPath of paths) {
      addFinding(collector, {
        code: "REF_SHADOWED",
        severity: "warn",
        file: "openclaw.json",
        jsonPath: configPath,
        message: `Auth profile credentials (${modeText}) take precedence for provider "${provider}", so this config ref may never be used.`,
        provider,
      });
    }
  }
}

function describeUnknownError(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message;
  }
  if (typeof err === "string" && err.trim().length > 0) {
    return err;
  }
  try {
    const serialized = JSON.stringify(err);
    return serialized ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

function summarizeFindings(findings: SecretsAuditFinding[]): SecretsAuditReport["summary"] {
  return {
    plaintextCount: findings.filter((entry) => entry.code === "PLAINTEXT_FOUND").length,
    unresolvedRefCount: findings.filter((entry) => entry.code === "REF_UNRESOLVED").length,
    shadowedRefCount: findings.filter((entry) => entry.code === "REF_SHADOWED").length,
    legacyResidueCount: findings.filter((entry) => entry.code === "LEGACY_RESIDUE").length,
  };
}

export async function runSecretsAudit(
  params: {
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<SecretsAuditReport> {
  const env = params.env ?? process.env;
  const previousAuthStoreReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY;
  process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
  try {
    const io = createSecretsConfigIO({ env });
    const snapshot = await io.readConfigFileSnapshot();
    const configPath = resolveUserPath(snapshot.path);
    const defaults = snapshot.valid ? snapshot.config.secrets?.defaults : undefined;

    const collector: AuditCollector = {
      findings: [],
      refAssignments: [],
      configProviderRefPaths: new Map(),
      authProviderState: new Map(),
      filesScanned: new Set([configPath]),
    };

    const stateDir = resolveStateDir(env, os.homedir);
    const envPath = path.join(resolveConfigDir(env, os.homedir), ".env");
    const config = snapshot.valid ? snapshot.config : ({} as OpenClawConfig);

    if (snapshot.valid) {
      collectConfigSecrets({
        config,
        configPath,
        collector,
      });
      for (const authStorePath of collectAuthStorePaths(config, stateDir)) {
        collectAuthStoreSecrets({
          authStorePath,
          collector,
          defaults,
        });
      }
      await collectUnresolvedRefFindings({
        collector,
        config,
        env,
      });
      collectShadowingFindings(collector);
    } else {
      addFinding(collector, {
        code: "REF_UNRESOLVED",
        severity: "error",
        file: configPath,
        jsonPath: "<root>",
        message: "Config is invalid; cannot validate secret references reliably.",
      });
    }

    collectEnvPlaintext({
      envPath,
      collector,
    });
    collectAuthJsonResidue({
      stateDir,
      collector,
    });

    const summary = summarizeFindings(collector.findings);
    const status: SecretsAuditStatus =
      summary.unresolvedRefCount > 0
        ? "unresolved"
        : collector.findings.length > 0
          ? "findings"
          : "clean";

    return {
      version: 1,
      status,
      filesScanned: [...collector.filesScanned].toSorted(),
      summary,
      findings: collector.findings,
    };
  } finally {
    if (previousAuthStoreReadOnly === undefined) {
      delete process.env.OPENCLAW_AUTH_STORE_READONLY;
    } else {
      process.env.OPENCLAW_AUTH_STORE_READONLY = previousAuthStoreReadOnly;
    }
  }
}

export function resolveSecretsAuditExitCode(report: SecretsAuditReport, check: boolean): number {
  if (report.summary.unresolvedRefCount > 0) {
    return 2;
  }
  if (check && report.findings.length > 0) {
    return 1;
  }
  return 0;
}

export function applySecretsPlanTarget(
  config: OpenClawConfig,
  pathLabel: string,
  value: unknown,
): void {
  const segments = parseDotPath(pathLabel);
  if (segments.length === 0) {
    throw new Error("Invalid target path.");
  }
  let cursor: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (!isRecord(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}
