import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import {
  AUTH_PROFILE_STORE_KV_SCOPE,
  authProfileStoreKey,
  buildPersistedAuthProfileSecretsStore,
  coercePersistedAuthProfileStore,
} from "../agents/auth-profiles/persisted.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import {
  replaceConfigFile,
  resolveStateDir,
  type ConfigFileSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import type { ConfigWriteOptions } from "../config/io.js";
import { coerceSecretRef, type SecretProviderConfig } from "../config/types.secrets.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  deleteOpenClawStateKvJson,
  readOpenClawStateKvJsonResult,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
  type OpenClawStateKvJsonReadResult,
} from "../state/openclaw-state-kv.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { iterateAuthProfileCredentials } from "./auth-profiles-scan.js";
import { listAuthProfileStoreAgentDirs } from "./auth-store-paths.js";
import { createSecretsConfigIO } from "./config-io.js";
import { getSkippedExecRefStaticError } from "./exec-resolution-policy.js";
import { deletePathStrict, getPath, setPathCreateStrict } from "./path-utils.js";
import {
  type SecretsApplyPlan,
  type SecretsPlanTarget,
  normalizeSecretsPlanOptions,
  resolveValidatedPlanTarget,
} from "./plan.js";
import { listKnownSecretEnvVarNames } from "./provider-env-vars.js";
import { resolveSecretRefValue } from "./resolve.js";
import { prepareSecretsRuntimeSnapshot } from "./runtime.js";
import { assertExpectedResolvedSecretValue } from "./secret-value.js";
import { isNonEmptyString, isRecord, writeTextFileAtomic } from "./shared.js";
import { parseEnvAssignmentValue } from "./storage-scan.js";
import { AUTH_PROFILE_TARGET_STORE } from "./target-registry-types.js";

type FileSnapshot = {
  existed: boolean;
  content: string;
  mode: number;
};

type ApplyWrite = {
  path: string;
  content: string;
  mode: number;
};

type ProjectedState = {
  nextConfig: OpenClawConfig;
  configSnapshot: ConfigFileSnapshot;
  configPath: string;
  configWriteOptions: ConfigWriteOptions;
  authStoreByAgentDir: Map<string, Record<string, unknown>>;
  envRawByPath: Map<string, string>;
  changedFiles: Set<string>;
  env: NodeJS.ProcessEnv;
  warnings: string[];
  refsChecked: number;
  skippedExecRefs: number;
  resolvabilityComplete: boolean;
};

type ResolvedPlanTargetEntry = {
  target: SecretsPlanTarget;
  resolved: NonNullable<ReturnType<typeof resolveValidatedPlanTarget>>;
};

type ConfigTargetMutationResult = {
  resolvedTargets: ResolvedPlanTargetEntry[];
  scrubbedValues: Set<string>;
  providerTargets: Set<string>;
  configChanged: boolean;
  authStoreByAgentDir: Map<string, Record<string, unknown>>;
};

type MutableAuthProfileStore = Record<string, unknown> & {
  profiles: Record<string, unknown>;
};

type AuthStoreSnapshot = OpenClawStateKvJsonReadResult;

export type SecretsApplyResult = {
  mode: "dry-run" | "write";
  changed: boolean;
  changedFiles: string[];
  checks: {
    resolvability: boolean;
    resolvabilityComplete: boolean;
  };
  refsChecked: number;
  skippedExecRefs: number;
  warningCount: number;
  warnings: string[];
};

function planContainsExecReferences(plan: SecretsApplyPlan): boolean {
  if (plan.targets.some((target) => target.ref.source === "exec")) {
    return true;
  }
  return Object.values(plan.providerUpserts ?? {}).some((provider) => provider.source === "exec");
}

function resolveTarget(
  target: SecretsPlanTarget,
): NonNullable<ReturnType<typeof resolveValidatedPlanTarget>> {
  const resolved = resolveValidatedPlanTarget(target);
  if (!resolved) {
    throw new Error(`Invalid plan target path for ${target.type}: ${target.path}`);
  }
  return resolved;
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
    const parsedValue = parseEnvAssignmentValue(match[2] ?? "");
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

function applyProviderPlanMutations(params: {
  config: OpenClawConfig;
  upserts: Record<string, SecretProviderConfig> | undefined;
  deletes: string[] | undefined;
}): boolean {
  const currentProviders = isRecord(params.config.secrets?.providers)
    ? structuredClone(params.config.secrets?.providers)
    : {};
  let changed = false;

  for (const providerAlias of params.deletes ?? []) {
    if (!Object.prototype.hasOwnProperty.call(currentProviders, providerAlias)) {
      continue;
    }
    delete currentProviders[providerAlias];
    changed = true;
  }

  for (const [providerAlias, providerConfig] of Object.entries(params.upserts ?? {})) {
    const previous = currentProviders[providerAlias];
    if (isDeepStrictEqual(previous, providerConfig)) {
      continue;
    }
    currentProviders[providerAlias] = structuredClone(providerConfig);
    changed = true;
  }

  if (!changed) {
    return false;
  }

  params.config.secrets ??= {};
  if (Object.keys(currentProviders).length === 0) {
    if ("providers" in params.config.secrets) {
      delete params.config.secrets.providers;
    }
    return true;
  }
  params.config.secrets.providers = currentProviders;
  return true;
}

async function projectPlanState(params: {
  plan: SecretsApplyPlan;
  env: NodeJS.ProcessEnv;
  write: boolean;
  allowExecInDryRun: boolean;
}): Promise<ProjectedState> {
  const io = createSecretsConfigIO({ env: params.env });
  const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("Cannot apply secrets plan: config is invalid.");
  }

  const options = normalizeSecretsPlanOptions(params.plan.options);
  const nextConfig = structuredClone(snapshot.config);
  const stateDir = resolveStateDir(params.env, os.homedir);
  const changedFiles = new Set<string>();
  const warnings: string[] = [];
  const configPath = resolveUserPath(snapshot.path);

  const providerConfigChanged = applyProviderPlanMutations({
    config: nextConfig,
    upserts: params.plan.providerUpserts,
    deletes: params.plan.providerDeletes,
  });
  if (providerConfigChanged) {
    changedFiles.add(configPath);
  }

  const targetMutations = applyConfigTargetMutations({
    planTargets: params.plan.targets,
    nextConfig,
    stateDir,
    env: params.env,
    authStoreByAgentDir: new Map<string, Record<string, unknown>>(),
    changedFiles,
  });
  if (targetMutations.configChanged) {
    changedFiles.add(configPath);
  }

  const authStoreByAgentDir = scrubAuthStoresForProviderTargets({
    nextConfig,
    stateDir,
    env: params.env,
    providerTargets: targetMutations.providerTargets,
    scrubbedValues: targetMutations.scrubbedValues,
    authStoreByAgentDir: targetMutations.authStoreByAgentDir,
    changedFiles,
    warnings,
    enabled: options.scrubAuthProfilesForProviderTargets,
  });

  const envRawByPath = scrubEnvFiles({
    env: params.env,
    scrubbedValues: targetMutations.scrubbedValues,
    changedFiles,
    enabled: options.scrubEnv,
  });
  const checkFullRuntime = params.write ? changedFiles.size > 0 : params.allowExecInDryRun;

  const validation = await validateProjectedSecretsState({
    env: params.env,
    nextConfig,
    resolvedTargets: targetMutations.resolvedTargets,
    authStoreByAgentDir,
    write: params.write,
    allowExecInDryRun: params.allowExecInDryRun,
    checkFullRuntime,
  });

  return {
    nextConfig,
    configSnapshot: snapshot,
    configPath,
    configWriteOptions: writeOptions,
    authStoreByAgentDir,
    envRawByPath,
    changedFiles,
    env: params.env,
    warnings,
    refsChecked: validation.refsChecked,
    skippedExecRefs: validation.skippedExecRefs,
    resolvabilityComplete: validation.resolvabilityComplete,
  };
}

function applyConfigTargetMutations(params: {
  planTargets: SecretsPlanTarget[];
  nextConfig: OpenClawConfig;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  authStoreByAgentDir: Map<string, Record<string, unknown>>;
  changedFiles: Set<string>;
}): ConfigTargetMutationResult {
  const resolvedTargets = params.planTargets.map((target) => ({
    target,
    resolved: resolveTarget(target),
  }));
  const scrubbedValues = new Set<string>();
  const providerTargets = new Set<string>();
  let configChanged = false;

  for (const { target, resolved } of resolvedTargets) {
    if (resolved.entry.store === AUTH_PROFILE_TARGET_STORE) {
      const authStoreChanged = applyAuthProfileTargetMutation({
        target,
        resolved,
        nextConfig: params.nextConfig,
        stateDir: params.stateDir,
        env: params.env,
        authStoreByAgentDir: params.authStoreByAgentDir,
        scrubbedValues,
      });
      if (authStoreChanged) {
        const agentId = (target.agentId ?? "").trim();
        if (!agentId) {
          throw new Error(`Missing required agentId for auth-profiles target ${target.path}.`);
        }
        params.changedFiles.add(resolveOpenClawStateSqlitePath(params.env));
      }
      continue;
    }

    const targetPathSegments = resolved.pathSegments;
    const usesSiblingRef = resolved.entry.secretShape === "sibling_ref"; // pragma: allowlist secret
    if (usesSiblingRef) {
      const previous = getPath(params.nextConfig, targetPathSegments);
      if (isNonEmptyString(previous)) {
        scrubbedValues.add(previous.trim());
      }
      const refPathSegments = resolved.refPathSegments;
      if (!refPathSegments) {
        throw new Error(`Missing sibling ref path for target ${target.type}.`);
      }
      const wroteRef = setPathCreateStrict(params.nextConfig, refPathSegments, target.ref);
      const deletedLegacy = deletePathStrict(params.nextConfig, targetPathSegments);
      if (wroteRef || deletedLegacy) {
        configChanged = true;
      }
      continue;
    }

    const previous = getPath(params.nextConfig, targetPathSegments);
    if (isNonEmptyString(previous)) {
      scrubbedValues.add(previous.trim());
    }
    const wroteRef = setPathCreateStrict(params.nextConfig, targetPathSegments, target.ref);
    if (wroteRef) {
      configChanged = true;
    }
    if (resolved.entry.trackProviderShadowing && resolved.providerId) {
      providerTargets.add(normalizeProviderId(resolved.providerId));
    }
  }

  return {
    resolvedTargets,
    scrubbedValues,
    providerTargets,
    configChanged,
    authStoreByAgentDir: params.authStoreByAgentDir,
  };
}

function scrubAuthStoresForProviderTargets(params: {
  nextConfig: OpenClawConfig;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  providerTargets: Set<string>;
  scrubbedValues: Set<string>;
  authStoreByAgentDir: Map<string, Record<string, unknown>>;
  changedFiles: Set<string>;
  warnings: string[];
  enabled: boolean;
}): Map<string, Record<string, unknown>> {
  if (!params.enabled || params.providerTargets.size === 0) {
    return params.authStoreByAgentDir;
  }

  for (const agentDir of listAuthProfileStoreAgentDirs(params.nextConfig, params.stateDir)) {
    const existing = params.authStoreByAgentDir.get(agentDir);
    const parsed =
      existing ??
      readPersistedAuthProfileStoreObject({
        agentDir,
        env: params.env,
      });
    if (!parsed || !isRecord(parsed.profiles)) {
      continue;
    }
    const nextStore = structuredClone(parsed);
    const profiles = nextStore.profiles;
    if (!isRecord(profiles)) {
      continue;
    }
    let mutated = false;
    for (const profile of iterateAuthProfileCredentials(profiles)) {
      const provider = normalizeProviderId(profile.provider);
      if (!params.providerTargets.has(provider)) {
        continue;
      }
      if (profile.kind === "api_key" || profile.kind === "token") {
        if (isNonEmptyString(profile.value)) {
          params.scrubbedValues.add(profile.value.trim());
        }
        if (profile.valueField in profile.profile) {
          delete profile.profile[profile.valueField];
          mutated = true;
        }
        if (
          profile.refField in profile.profile &&
          coerceSecretRef(profile.refValue, params.nextConfig.secrets?.defaults) === null
        ) {
          delete profile.profile[profile.refField];
          mutated = true;
        }
        continue;
      }
      if (profile.kind === "oauth" && (profile.hasAccess || profile.hasRefresh)) {
        params.warnings.push(
          `Provider "${provider}" has OAuth credentials in SQLite auth profile store for ${agentDir}; those still take precedence and are out of scope for static SecretRef migration.`,
        );
      }
    }
    if (mutated) {
      params.authStoreByAgentDir.set(agentDir, nextStore);
      params.changedFiles.add(resolveOpenClawStateSqlitePath(params.env));
    }
  }

  return params.authStoreByAgentDir;
}

function ensureMutableAuthStore(
  store: Record<string, unknown> | undefined,
): MutableAuthProfileStore {
  const next: Record<string, unknown> = store ? structuredClone(store) : {};
  const profiles = isRecord(next.profiles) ? next.profiles : {};
  if (typeof next.version !== "number" || !Number.isFinite(next.version)) {
    next.version = AUTH_STORE_VERSION;
  }
  return { ...next, profiles };
}

function resolveAuthStoreForTarget(params: {
  target: SecretsPlanTarget;
  nextConfig: OpenClawConfig;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  authStoreByAgentDir: Map<string, Record<string, unknown>>;
}): { agentDir: string; store: MutableAuthProfileStore } {
  const agentId = (params.target.agentId ?? "").trim();
  if (!agentId) {
    throw new Error(`Missing required agentId for auth-profiles target ${params.target.path}.`);
  }
  const agentDir = resolveAuthStoreAgentDirForAgent({
    nextConfig: params.nextConfig,
    stateDir: params.stateDir,
    agentId,
  });
  const existing = params.authStoreByAgentDir.get(agentDir);
  const loaded =
    existing ??
    readPersistedAuthProfileStoreObject({
      agentDir,
      env: params.env,
    });
  const store = ensureMutableAuthStore(isRecord(loaded) ? loaded : undefined);
  params.authStoreByAgentDir.set(agentDir, store);
  return { agentDir, store };
}

function resolveAuthStoreAgentDirForAgent(params: {
  nextConfig: OpenClawConfig;
  stateDir: string;
  agentId: string;
}): string {
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const configuredAgentDir = resolveAgentConfig(
    params.nextConfig,
    normalizedAgentId,
  )?.agentDir?.trim();
  if (configuredAgentDir) {
    return resolveUserPath(configuredAgentDir);
  }
  return path.join(resolveUserPath(params.stateDir), "agents", normalizedAgentId, "agent");
}

function ensureAuthProfileContainer(params: {
  target: SecretsPlanTarget;
  resolved: ResolvedPlanTargetEntry["resolved"];
  store: MutableAuthProfileStore;
}): boolean {
  let changed = false;
  const profilePathSegments = params.resolved.pathSegments.slice(0, 2);
  const profileId = profilePathSegments[1];
  if (!profileId) {
    throw new Error(`Invalid auth profile target path: ${params.target.path}`);
  }
  const current = getPath(params.store, profilePathSegments);
  const expectedType = params.resolved.entry.authProfileType;
  if (isRecord(current)) {
    if (expectedType && typeof current.type === "string" && current.type !== expectedType) {
      throw new Error(
        `Auth profile "${profileId}" type mismatch for ${params.target.path}: expected "${expectedType}", got "${current.type}".`,
      );
    }
    if (
      !isNonEmptyString(current.provider) &&
      isNonEmptyString(params.target.authProfileProvider)
    ) {
      const wroteProvider = setPathCreateStrict(
        params.store,
        [...profilePathSegments, "provider"],
        params.target.authProfileProvider,
      );
      changed = changed || wroteProvider;
    }
    return changed;
  }
  if (!expectedType) {
    throw new Error(
      `Auth profile target ${params.target.path} is missing auth profile type metadata.`,
    );
  }
  const provider = (params.target.authProfileProvider ?? "").trim();
  if (!provider) {
    throw new Error(
      `Cannot create auth profile "${profileId}" for ${params.target.path} without authProfileProvider.`,
    );
  }
  const wroteProfile = setPathCreateStrict(params.store, profilePathSegments, {
    type: expectedType,
    provider,
  });
  changed = changed || wroteProfile;
  return changed;
}

function applyAuthProfileTargetMutation(params: {
  target: SecretsPlanTarget;
  resolved: ResolvedPlanTargetEntry["resolved"];
  nextConfig: OpenClawConfig;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  authStoreByAgentDir: Map<string, Record<string, unknown>>;
  scrubbedValues: Set<string>;
}): boolean {
  if (params.resolved.entry.store !== AUTH_PROFILE_TARGET_STORE) {
    return false;
  }
  const { store } = resolveAuthStoreForTarget({
    target: params.target,
    nextConfig: params.nextConfig,
    stateDir: params.stateDir,
    env: params.env,
    authStoreByAgentDir: params.authStoreByAgentDir,
  });
  let changed = ensureAuthProfileContainer({
    target: params.target,
    resolved: params.resolved,
    store,
  });
  const targetPathSegments = params.resolved.pathSegments;
  const usesSiblingRef = params.resolved.entry.secretShape === "sibling_ref"; // pragma: allowlist secret
  if (usesSiblingRef) {
    const previous = getPath(store, targetPathSegments);
    if (isNonEmptyString(previous)) {
      params.scrubbedValues.add(previous.trim());
    }
    const refPathSegments = params.resolved.refPathSegments;
    if (!refPathSegments) {
      throw new Error(`Missing sibling ref path for auth-profiles target ${params.target.path}.`);
    }
    const wroteRef = setPathCreateStrict(store, refPathSegments, params.target.ref);
    const deletedPlaintext = deletePathStrict(store, targetPathSegments);
    changed = changed || wroteRef || deletedPlaintext;
    return changed;
  }
  const previous = getPath(store, targetPathSegments);
  if (isNonEmptyString(previous)) {
    params.scrubbedValues.add(previous.trim());
  }
  const wroteRef = setPathCreateStrict(store, targetPathSegments, params.target.ref);
  changed = changed || wroteRef;
  return changed;
}

function scrubEnvFiles(params: {
  env: NodeJS.ProcessEnv;
  scrubbedValues: Set<string>;
  changedFiles: Set<string>;
  enabled: boolean;
}): Map<string, string> {
  const envRawByPath = new Map<string, string>();
  if (!params.enabled || params.scrubbedValues.size === 0) {
    return envRawByPath;
  }
  const envPath = path.join(resolveConfigDir(params.env, os.homedir), ".env");
  if (!fs.existsSync(envPath)) {
    return envRawByPath;
  }
  const current = fs.readFileSync(envPath, "utf8");
  const scrubbed = scrubEnvRaw(
    current,
    params.scrubbedValues,
    new Set(listKnownSecretEnvVarNames()),
  );
  if (scrubbed.removed > 0 && scrubbed.nextRaw !== current) {
    envRawByPath.set(envPath, scrubbed.nextRaw);
    params.changedFiles.add(envPath);
  }
  return envRawByPath;
}

async function validateProjectedSecretsState(params: {
  env: NodeJS.ProcessEnv;
  nextConfig: OpenClawConfig;
  resolvedTargets: ResolvedPlanTargetEntry[];
  authStoreByAgentDir: Map<string, Record<string, unknown>>;
  write: boolean;
  allowExecInDryRun: boolean;
  checkFullRuntime: boolean;
}): Promise<{ refsChecked: number; skippedExecRefs: number; resolvabilityComplete: boolean }> {
  const cache = {};
  let refsChecked = 0;
  let skippedExecRefs = 0;
  for (const { target, resolved: resolvedTarget } of params.resolvedTargets) {
    if (!params.write && target.ref.source === "exec" && !params.allowExecInDryRun) {
      skippedExecRefs += 1;
      const staticError = getSkippedExecRefStaticError({
        ref: target.ref,
        config: params.nextConfig,
      });
      if (staticError) {
        throw new Error(staticError);
      }
      continue;
    }
    const resolved = await resolveSecretRefValue(target.ref, {
      config: params.nextConfig,
      env: params.env,
      cache,
    });
    refsChecked += 1;
    assertExpectedResolvedSecretValue({
      value: resolved,
      expected: resolvedTarget.entry.expectedResolvedValue,
      errorMessage:
        resolvedTarget.entry.expectedResolvedValue === "string"
          ? `Ref ${target.ref.source}:${target.ref.provider}:${target.ref.id} is not a non-empty string.`
          : `Ref ${target.ref.source}:${target.ref.provider}:${target.ref.id} is not string/object.`,
    });
  }

  const authStoreLookup = new Map<string, Record<string, unknown>>();
  for (const [agentDir, store] of params.authStoreByAgentDir.entries()) {
    authStoreLookup.set(resolveUserPath(agentDir), store);
  }
  if (params.checkFullRuntime) {
    await prepareSecretsRuntimeSnapshot({
      config: params.nextConfig,
      env: params.env,
      // Dry-run preflight only needs auth-store materialization when this plan
      // actually touches auth-profile state. Write mode keeps the stricter
      // whole-runtime check.
      includeAuthStoreRefs: params.write || params.authStoreByAgentDir.size > 0,
      loadAuthStore: (agentDir?: string) => {
        const resolvedAgentDir = agentDir
          ? resolveUserPath(agentDir)
          : path.join(resolveStateDir(params.env, os.homedir), "agents", "main", "agent");
        const override = authStoreLookup.get(resolvedAgentDir);
        if (override) {
          return (
            coercePersistedAuthProfileStore(structuredClone(override)) ?? {
              version: AUTH_STORE_VERSION,
              profiles: {},
            }
          );
        }
        return readAuthProfileStoreFromState({
          agentDir: resolvedAgentDir,
          env: params.env,
        });
      },
    });
  }
  return {
    refsChecked,
    skippedExecRefs,
    // Dry-run without exec consent intentionally skips full runtime preflight.
    resolvabilityComplete: params.write || params.allowExecInDryRun || skippedExecRefs === 0,
  };
}

function captureFileSnapshot(pathname: string): FileSnapshot {
  if (!fs.existsSync(pathname)) {
    return { existed: false, content: "", mode: 0o600 };
  }
  const stat = fs.statSync(pathname);
  return {
    existed: true,
    content: fs.readFileSync(pathname, "utf8"),
    mode: stat.mode & 0o777,
  };
}

function restoreFileSnapshot(pathname: string, snapshot: FileSnapshot): void {
  if (!snapshot.existed) {
    if (fs.existsSync(pathname)) {
      fs.rmSync(pathname, { force: true });
    }
    return;
  }
  writeTextFileAtomic(pathname, snapshot.content, snapshot.mode || 0o600);
}

function readPersistedAuthProfileStoreObject(params: {
  agentDir: string;
  env: NodeJS.ProcessEnv;
}): Record<string, unknown> | null {
  const result = readOpenClawStateKvJsonResult(
    AUTH_PROFILE_STORE_KV_SCOPE,
    authProfileStoreKey(params.agentDir),
    { env: params.env },
  );
  return result.exists && isRecord(result.value) ? result.value : null;
}

function readAuthProfileStoreFromState(params: { agentDir: string; env: NodeJS.ProcessEnv }) {
  const raw = readPersistedAuthProfileStoreObject(params);
  return (
    coercePersistedAuthProfileStore(raw) ?? {
      version: AUTH_STORE_VERSION,
      profiles: {},
    }
  );
}

function persistProjectedAuthProfileStore(params: {
  agentDir: string;
  store: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
}): void {
  const coerced = coercePersistedAuthProfileStore(params.store) ?? {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    AUTH_PROFILE_STORE_KV_SCOPE,
    authProfileStoreKey(params.agentDir),
    buildPersistedAuthProfileSecretsStore(coerced) as unknown as OpenClawStateJsonValue,
    { env: params.env },
  );
}

function captureAuthStoreSnapshot(params: {
  snapshots: Map<string, AuthStoreSnapshot>;
  agentDir: string;
  env: NodeJS.ProcessEnv;
}): void {
  if (params.snapshots.has(params.agentDir)) {
    return;
  }
  params.snapshots.set(
    params.agentDir,
    readOpenClawStateKvJsonResult(
      AUTH_PROFILE_STORE_KV_SCOPE,
      authProfileStoreKey(params.agentDir),
      { env: params.env },
    ),
  );
}

function restoreAuthStoreSnapshot(params: {
  agentDir: string;
  snapshot: AuthStoreSnapshot;
  env: NodeJS.ProcessEnv;
}): void {
  const key = authProfileStoreKey(params.agentDir);
  if (!params.snapshot.exists || params.snapshot.value === undefined) {
    deleteOpenClawStateKvJson(AUTH_PROFILE_STORE_KV_SCOPE, key, { env: params.env });
    return;
  }
  const { value, updatedAt } = params.snapshot;
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(AUTH_PROFILE_STORE_KV_SCOPE, key, value, {
    env: params.env,
    now: () => updatedAt,
  });
}

export async function runSecretsApply(params: {
  plan: SecretsApplyPlan;
  env?: NodeJS.ProcessEnv;
  write?: boolean;
  allowExec?: boolean;
}): Promise<SecretsApplyResult> {
  const env = params.env ?? process.env;
  const write = params.write === true;
  const allowExec = Boolean(params.allowExec);
  if (write && planContainsExecReferences(params.plan) && !allowExec) {
    throw new Error("Plan contains exec SecretRefs/providers. Re-run with --allow-exec.");
  }
  const allowExecInDryRun = write ? true : allowExec;
  const projected = await projectPlanState({
    plan: params.plan,
    env,
    write,
    allowExecInDryRun,
  });
  const changedFiles = [...projected.changedFiles].toSorted();
  if (!write) {
    return {
      mode: "dry-run",
      changed: changedFiles.length > 0,
      changedFiles,
      checks: {
        resolvability: true,
        resolvabilityComplete: projected.resolvabilityComplete,
      },
      refsChecked: projected.refsChecked,
      skippedExecRefs: projected.skippedExecRefs,
      warningCount: projected.warnings.length,
      warnings: projected.warnings,
    };
  }
  if (changedFiles.length === 0) {
    return {
      mode: "write",
      changed: false,
      changedFiles: [],
      checks: {
        resolvability: true,
        resolvabilityComplete: true,
      },
      refsChecked: projected.refsChecked,
      skippedExecRefs: 0,
      warningCount: projected.warnings.length,
      warnings: projected.warnings,
    };
  }

  const io = createSecretsConfigIO({ env });
  const snapshots = new Map<string, FileSnapshot>();
  const authStoreSnapshots = new Map<string, AuthStoreSnapshot>();
  const capture = (pathname: string) => {
    if (!snapshots.has(pathname)) {
      snapshots.set(pathname, captureFileSnapshot(pathname));
    }
  };

  capture(projected.configPath);
  const writes: ApplyWrite[] = [];
  for (const agentDir of projected.authStoreByAgentDir.keys()) {
    captureAuthStoreSnapshot({
      snapshots: authStoreSnapshots,
      agentDir,
      env: projected.env,
    });
  }
  for (const [pathname, raw] of projected.envRawByPath.entries()) {
    capture(pathname);
    writes.push({
      path: pathname,
      content: raw,
      mode: 0o600,
    });
  }

  try {
    await replaceConfigFile({
      nextConfig: projected.nextConfig,
      snapshot: projected.configSnapshot,
      writeOptions: projected.configWriteOptions,
      io,
      afterWrite: { mode: "auto" },
    });
    for (const [agentDir, store] of projected.authStoreByAgentDir.entries()) {
      persistProjectedAuthProfileStore({
        agentDir,
        store,
        env: projected.env,
      });
    }
    for (const write of writes) {
      writeTextFileAtomic(write.path, write.content, write.mode);
    }
  } catch (err) {
    for (const [agentDir, snapshot] of authStoreSnapshots.entries()) {
      try {
        restoreAuthStoreSnapshot({
          agentDir,
          snapshot,
          env: projected.env,
        });
      } catch {
        // Best effort only; preserve original error.
      }
    }
    for (const [pathname, snapshot] of snapshots.entries()) {
      try {
        restoreFileSnapshot(pathname, snapshot);
      } catch {
        // Best effort only; preserve original error.
      }
    }
    throw new Error(`Secrets apply failed: ${String(err)}`, { cause: err });
  }

  return {
    mode: "write",
    changed: changedFiles.length > 0,
    changedFiles,
    checks: {
      resolvability: true,
      resolvabilityComplete: true,
    },
    refsChecked: projected.refsChecked,
    skippedExecRefs: 0,
    warningCount: projected.warnings.length,
    warnings: projected.warnings,
  };
}

export const __testing = {
  async projectConfigForTest(params: {
    plan: SecretsApplyPlan;
    env?: NodeJS.ProcessEnv;
  }): Promise<OpenClawConfig> {
    const projected = await projectPlanState({
      plan: params.plan,
      env: params.env ?? process.env,
      write: false,
      allowExecInDryRun: false,
    });
    return projected.nextConfig;
  },
};
