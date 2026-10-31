/** Applies secrets migration plans across config files, auth stores, and env files. */
import fs from "node:fs";
import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { loadAuthProfileStoreForSecretsRuntime } from "../agents/auth-profiles.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { resolveSharedAuthStorePath } from "../agents/auth-profiles/path-resolve.js";
import {
  coercePersistedAuthProfileStore,
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../agents/auth-profiles/persisted.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStoreIfPersistenceSnapshotMatches } from "../agents/auth-profiles/store-runtime.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  restoreAuthProfileStorePersistenceSnapshot,
} from "../agents/auth-profiles/store.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { replaceConfigFile, resolveStateDir, type OpenClawConfig } from "../config/config.js";
import { coerceSecretRef, type SecretProviderConfig } from "../config/types.secrets.js";
import { decodeUtf8Input } from "../infra/utf8-input.js";
import {
  findPluginConfigEntry,
  hasPluginConfigId,
  normalizePluginConfigId,
} from "../plugins/plugin-config-trust.js";
import { resolveUserPath } from "../utils.js";
import { iterateAuthProfileCredentials } from "./auth-profiles-scan.js";
import { listAuthProfileStoreTargets, type AuthProfileStoreTarget } from "./auth-store-paths.js";
import { createSecretsConfigIO, writeTextFileAtomic } from "./config-io.js";
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
import { isNonEmptyString, isRecord } from "./shared.js";
import { listSecretsDotEnvPaths, parseEnvAssignmentValue } from "./storage-scan.js";

type FileSnapshot = {
  existed: boolean;
  content: string;
  mode: number;
};

type AuthStoreSnapshot = {
  target: AuthProfileStoreTarget;
  persistence: ReturnType<typeof captureAuthProfileStorePersistenceSnapshot>;
  owned?: ReturnType<typeof captureAuthProfileStorePersistenceSnapshot>;
};

type ProjectedAuthStore = {
  target: AuthProfileStoreTarget;
  store: Record<string, unknown>;
};

type ResolvedPlanTargetEntry = {
  target: SecretsPlanTarget;
  resolved: NonNullable<ReturnType<typeof resolveValidatedPlanTarget>>;
};

type MutableAuthProfileStore = Record<string, unknown> & {
  profiles: Record<string, unknown>;
};

/** Result summary for a secrets apply dry-run or write run. */
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
): string {
  if (migratedValues.size === 0 || allowedEnvKeys.size === 0) {
    return raw;
  }
  const lines = raw.split(/\r?\n/);
  const nextLines = lines.filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    return (
      !match ||
      !allowedEnvKeys.has(match[1] ?? "") ||
      !migratedValues.has(parseEnvAssignmentValue(match[2] ?? ""))
    );
  });
  if (nextLines.length === lines.length) {
    return raw;
  }
  const hadTrailingNewline = raw.endsWith("\n");
  const joined = nextLines.join("\n");
  return hadTrailingNewline || joined.length === 0
    ? `${joined}${joined.endsWith("\n") ? "" : "\n"}`
    : joined;
}

function applyProviderPlanMutations(params: {
  config: OpenClawConfig;
  upserts: Record<string, SecretProviderConfig> | undefined;
  deletes: string[] | undefined;
}): boolean {
  const currentProviders = params.config.secrets?.providers ?? {};
  let changed = false;

  for (const providerAlias of params.deletes ?? []) {
    if (!Object.hasOwn(currentProviders, providerAlias)) {
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
    currentProviders[providerAlias] = providerConfig;
    changed = true;
  }

  for (const providerConfig of Object.values(params.upserts ?? {})) {
    if (providerConfig.source !== "exec" || !("pluginIntegration" in providerConfig)) {
      continue;
    }
    // Plugin-managed exec providers fail closed unless the owner is active.
    // A secrets plan that upserts one must also make that owner resolvable.
    const pluginId = normalizePluginConfigId(providerConfig.pluginIntegration.pluginId);
    params.config.plugins ??= {};
    if (params.config.plugins.enabled === false) {
      throw new Error(
        `Cannot apply plugin-managed SecretRef provider "${pluginId}" because plugins.enabled is false. Enable plugins before applying this plan.`,
      );
    }
    if (hasPluginConfigId(params.config.plugins.deny, pluginId)) {
      throw new Error(
        `Cannot apply plugin-managed SecretRef provider "${pluginId}" because plugins.deny includes "${pluginId}". Remove the deny rule before applying this plan.`,
      );
    }
    const previousEntry = findPluginConfigEntry(params.config.plugins.entries, pluginId);
    if (previousEntry?.enabled === false) {
      throw new Error(
        `Cannot apply plugin-managed SecretRef provider "${pluginId}" because plugins.entries.${pluginId}.enabled is false. Enable the plugin explicitly before applying this plan.`,
      );
    }
    if (
      Array.isArray(params.config.plugins.allow) &&
      params.config.plugins.allow.length > 0 &&
      !hasPluginConfigId(params.config.plugins.allow, pluginId)
    ) {
      throw new Error(
        `Cannot apply plugin-managed SecretRef provider "${pluginId}" because plugins.allow does not include "${pluginId}". Add the plugin to plugins.allow before applying this plan.`,
      );
    }
    params.config.plugins.entries ??= {};
    if (previousEntry?.enabled === true) {
      continue;
    }
    params.config.plugins.entries[pluginId] = {
      ...previousEntry,
      enabled: true,
    };
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
}) {
  const io = createSecretsConfigIO({ env: params.env });
  const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("Cannot apply secrets plan: config is invalid.");
  }

  const options = normalizeSecretsPlanOptions(params.plan.options);
  const nextConfig = structuredClone(snapshot.config);
  const stateDir = resolveStateDir(params.env, os.homedir);
  const authStoreEnv = {
    ...params.env,
    OPENCLAW_STATE_DIR: stateDir,
  };
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

  const authStores = new Map<string, ProjectedAuthStore>();
  const resolvedTargets = params.plan.targets.map((target) => ({
    target,
    resolved: resolveTarget(target),
  }));
  const scrubbedValues = new Set<string>();
  const providerTargets = new Set<string>();
  let configChanged = false;

  for (const { target, resolved } of resolvedTargets) {
    if (resolved.entry.configFile === "auth-profile-store") {
      const { path, store } = resolveAuthStoreForTarget({
        target,
        nextConfig,
        stateDir,
        env: params.env,
        authStores,
      });
      const containerChanged = ensureAuthProfileContainer({ target, resolved, store });
      const refChanged = applySecretRefTargetMutation(store, target, resolved, scrubbedValues);
      if (containerChanged || refChanged) {
        changedFiles.add(path);
      }
      continue;
    }

    if (applySecretRefTargetMutation(nextConfig, target, resolved, scrubbedValues)) {
      configChanged = true;
    }
    if (
      resolved.entry.secretShape !== "sibling_ref" &&
      resolved.entry.trackProviderShadowing &&
      resolved.providerId
    ) {
      providerTargets.add(normalizeProviderId(resolved.providerId));
    }
  }

  if (configChanged) {
    changedFiles.add(configPath);
  }

  if (options.scrubAuthProfilesForProviderTargets && providerTargets.size > 0) {
    for (const target of listAuthProfileStoreTargets(nextConfig, stateDir, params.env)) {
      const authStorePath = target.path;
      const existing = authStores.get(authStorePath)?.store;
      if (!existing && !fs.existsSync(authStorePath)) {
        continue;
      }
      const parsed =
        existing ??
        (target.kind === "shared"
          ? loadPersistedSharedAuthProfileStore(target.env)
          : loadPersistedAuthProfileStore(target.agentDir));
      if (!parsed || !isRecord(parsed.profiles)) {
        continue;
      }
      let mutated = false;
      for (const profile of iterateAuthProfileCredentials(parsed.profiles)) {
        const provider = normalizeProviderId(profile.provider);
        if (!providerTargets.has(provider)) {
          continue;
        }
        if (profile.kind === "api_key" || profile.kind === "token") {
          if (isNonEmptyString(profile.value)) {
            scrubbedValues.add(profile.value.trim());
          }
          if (profile.valueField in profile.profile) {
            delete profile.profile[profile.valueField];
            mutated = true;
          }
          if (
            profile.refField in profile.profile &&
            coerceSecretRef(profile.refValue, nextConfig.secrets?.defaults) === null
          ) {
            delete profile.profile[profile.refField];
            mutated = true;
          }
          continue;
        }
        if (profile.kind === "oauth" && (profile.hasAccess || profile.hasRefresh)) {
          warnings.push(
            `Provider "${provider}" has OAuth credentials in ${authStorePath}; those still take precedence and are out of scope for static SecretRef migration.`,
          );
        }
      }
      if (mutated) {
        authStores.set(authStorePath, { store: parsed, target });
        changedFiles.add(authStorePath);
      }
    }
  }

  const envRawByPath = new Map<string, string>();
  if (options.scrubEnv && scrubbedValues.size > 0) {
    const knownSecretEnvVars = new Set(listKnownSecretEnvVarNames());
    for (const envPath of listSecretsDotEnvPaths({ configPath, stateDir })) {
      if (!fs.existsSync(envPath)) {
        continue;
      }
      const bytes = fs.readFileSync(envPath);
      const current = bytes.toString("utf8");
      const scrubbed = scrubEnvRaw(current, scrubbedValues, knownSecretEnvVars);
      if (scrubbed !== current) {
        // No-op inspections may tolerate legacy bytes; rewrites must not replace them.
        decodeUtf8Input(bytes, `File ${envPath}`);
        envRawByPath.set(envPath, scrubbed);
        changedFiles.add(envPath);
      }
    }
  }
  const checkFullRuntime = params.write ? changedFiles.size > 0 : params.allowExecInDryRun;
  const { env, write, allowExecInDryRun } = params;
  const cache = {};
  let refsChecked = 0;
  let skippedExecRefs = 0;
  for (const { target, resolved: resolvedTarget } of resolvedTargets) {
    if (!write && target.ref.source === "exec" && !allowExecInDryRun) {
      skippedExecRefs += 1;
      const staticError = getSkippedExecRefStaticError({
        ref: target.ref,
        config: nextConfig,
      });
      if (staticError) {
        throw new Error(staticError);
      }
      continue;
    }
    const resolved = await resolveSecretRefValue(target.ref, {
      config: nextConfig,
      env,
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
  for (const [authStorePath, { store }] of authStores) {
    authStoreLookup.set(resolveUserPath(authStorePath, env), store);
  }
  if (checkFullRuntime) {
    await prepareSecretsRuntimeSnapshot({
      config: nextConfig,
      env,
      // Dry-run preflight only needs auth-store materialization when this plan
      // actually touches auth-profile state. Write mode keeps the stricter
      // whole-runtime check.
      includeAuthStoreRefs: write || authStores.size > 0,
      loadAuthStore: (agentDir?: string) => {
        const storePath = resolveUserPath(
          agentDir ? resolveAuthProfileDatabasePath(agentDir) : resolveSharedAuthStorePath(env),
          env,
        );
        const override = authStoreLookup.get(storePath);
        if (override) {
          return (
            coercePersistedAuthProfileStore(override) ?? {
              version: AUTH_STORE_VERSION,
              profiles: {},
            }
          );
        }
        return loadAuthProfileStoreForSecretsRuntime(agentDir);
      },
    });
  }
  return {
    nextConfig,
    authStoreEnv,
    configSnapshot: snapshot,
    configPath,
    configWriteOptions: writeOptions,
    authStores,
    envRawByPath,
    changedFiles,
    warnings,
    refsChecked,
    skippedExecRefs,
    // Dry-run without exec consent intentionally skips full runtime preflight.
    resolvabilityComplete: write || allowExecInDryRun || skippedExecRefs === 0,
  };
}

function resolveAuthStoreForTarget(params: {
  target: SecretsPlanTarget;
  nextConfig: OpenClawConfig;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  authStores: Map<string, ProjectedAuthStore>;
}): { path: string; store: MutableAuthProfileStore } {
  const agentId = (params.target.agentId ?? "").trim();
  if (!agentId) {
    throw new Error(`Missing required agentId for auth-profiles target ${params.target.path}.`);
  }
  const scopedEnv = {
    ...params.env,
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_AGENT_DIR: undefined,
  };
  const agentDir = resolveAgentDir(params.nextConfig, agentId, scopedEnv);
  const authStoreTarget: Extract<AuthProfileStoreTarget, { kind: "agent" }> = {
    kind: "agent",
    agentDir,
    path: resolveAuthProfileDatabasePath(agentDir),
  };
  const authStorePath = authStoreTarget.path;
  const existing = params.authStores.get(authStorePath)?.store;
  const loaded = existing ?? loadPersistedAuthProfileStore(authStoreTarget.agentDir);
  const next: Record<string, unknown> = isRecord(loaded) ? loaded : {};
  const profiles = isRecord(next.profiles) ? next.profiles : {};
  if (typeof next.version !== "number" || !Number.isFinite(next.version)) {
    next.version = AUTH_STORE_VERSION;
  }
  const store = { ...next, profiles };
  params.authStores.set(authStorePath, { store, target: authStoreTarget });
  return { path: authStorePath, store };
}

function ensureAuthProfileContainer(params: {
  target: SecretsPlanTarget;
  resolved: ResolvedPlanTargetEntry["resolved"];
  store: MutableAuthProfileStore;
}): boolean {
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
      return setPathCreateStrict(
        params.store,
        [...profilePathSegments, "provider"],
        params.target.authProfileProvider,
      );
    }
    return false;
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
  return setPathCreateStrict(params.store, profilePathSegments, {
    type: expectedType,
    provider,
  });
}

function applySecretRefTargetMutation(
  root: Record<string, unknown>,
  target: SecretsPlanTarget,
  resolved: ResolvedPlanTargetEntry["resolved"],
  scrubbedValues: Set<string>,
): boolean {
  const previous = getPath(root, resolved.pathSegments);
  if (isNonEmptyString(previous)) {
    scrubbedValues.add(previous.trim());
  }
  if (resolved.entry.secretShape === "sibling_ref") {
    const refPathTokens = resolved.refPathTokens;
    if (!refPathTokens) {
      throw new Error(
        resolved.entry.configFile === "auth-profile-store"
          ? `Missing sibling ref path for auth-profiles target ${target.path}.`
          : `Missing sibling ref path for target ${target.type}.`,
      );
    }
    const wroteRef = setPathCreateStrict(root, refPathTokens, target.ref);
    const deletedPlaintext = deletePathStrict(root, resolved.pathSegments);
    return wroteRef || deletedPlaintext;
  }
  return setPathCreateStrict(root, resolved.pathTokens, target.ref);
}

function captureFileSnapshot(pathname: string): FileSnapshot {
  if (!fs.existsSync(pathname)) {
    return { existed: false, content: "", mode: 0o600 };
  }
  const stat = fs.statSync(pathname);
  return {
    existed: true,
    content: decodeUtf8Input(fs.readFileSync(pathname), `File ${pathname}`),
    mode: stat.mode & 0o777,
  };
}

function restoreFileSnapshot(
  pathname: string,
  snapshot: FileSnapshot,
  env: NodeJS.ProcessEnv,
): void {
  if (!snapshot.existed) {
    if (fs.existsSync(pathname)) {
      fs.rmSync(pathname, { force: true });
    }
    return;
  }
  writeTextFileAtomic(pathname, snapshot.content, snapshot.mode || 0o600, env);
}

/** Applies a normalized secrets plan, or reports file/auth-store changes in dry-run mode. */
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
  const result: SecretsApplyResult = {
    mode: write ? "write" : "dry-run",
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
  if (!write || changedFiles.length === 0) {
    return result;
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
  for (const pathname of projected.envRawByPath.keys()) {
    capture(pathname);
  }
  for (const [pathname, { target }] of projected.authStores) {
    authStoreSnapshots.set(pathname, {
      target,
      persistence: captureAuthProfileStorePersistenceSnapshot(
        target.kind === "agent" ? target.agentDir : undefined,
        { env: target.kind === "shared" ? target.env : projected.authStoreEnv },
      ),
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
    for (const [pathname, raw] of projected.envRawByPath.entries()) {
      writeTextFileAtomic(pathname, raw, 0o600, env);
    }
    for (const [pathname, { store: value, target }] of projected.authStores) {
      const store = coercePersistedAuthProfileStore(value);
      if (store) {
        const snapshot = authStoreSnapshots.get(pathname);
        if (!snapshot) {
          throw new Error(`missing captured auth profile store for ${pathname}`);
        }
        const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
          store,
          snapshot: snapshot.persistence,
          agentDir: target.kind === "agent" ? target.agentDir : undefined,
          ...(target.kind === "shared" ? { stateDir: target.stateDir } : {}),
        });
        // Persisted rows commit before runtime publication. Record their exact
        // ownership first so a publication failure can still roll them back.
        snapshot.owned = committed.owned;
        if (!committed.publishRuntimeSnapshots()) {
          throw new Error(`auth profile runtime publication failed for ${pathname}`);
        }
      }
    }
  } catch (err) {
    // Apply can touch multiple files; restore captured snapshots so partial writes do not leave
    // config/auth/env stores out of sync when a later write fails.
    for (const [pathname, snapshot] of snapshots.entries()) {
      try {
        restoreFileSnapshot(pathname, snapshot, env);
      } catch {
        // Best effort only; preserve original error.
      }
    }
    for (const snapshot of authStoreSnapshots.values()) {
      if (!snapshot.owned) {
        continue;
      }
      try {
        restoreAuthProfileStorePersistenceSnapshot(
          snapshot.persistence,
          snapshot.owned,
          snapshot.target.kind === "agent" ? snapshot.target.agentDir : undefined,
          snapshot.target.kind === "shared" ? { stateDir: snapshot.target.stateDir } : {},
        );
      } catch {
        // Best effort only; preserve original error.
      }
    }
    throw new Error(`Secrets apply failed: ${String(err)}`, { cause: err });
  }

  return result;
}

export const testing = {
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
