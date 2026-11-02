import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import {
  applyLegacyAuthStore,
  coerceLegacyAuthStore,
  coerceLegacyAuthProfileStore,
  normalizeLegacyAuthProfileFields,
  parseLegacyCredentialEntry,
  hasUsableAuthProfileCredential,
} from "../agents/auth-profiles/legacy-flat-credential.js";
import {
  clearAuthProfileMigrationDiagnostics,
  listLegacyAuthProfileArchives,
  readLegacyAuthProfileProviders,
  resolveLegacyOAuthPath,
} from "../agents/auth-profiles/legacy-source-diagnostic.js";
import {
  areOAuthCredentialsEquivalent,
  hasMatchingOAuthIdentity,
} from "../agents/auth-profiles/oauth-shared.js";
import { isInheritedMainOAuthCredentialFromStores } from "../agents/auth-profiles/ownership.js";
import {
  prepareSharedAuthStoreOwnershipForNative as resolveSharedAuthStoreOwnership,
  resolveNativeSharedAuthStorePath as resolveSharedAuthStorePath,
} from "../agents/auth-profiles/path-resolve.native.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import {
  inspectAuthProfileJsonCell,
  readAuthProfileJsonCellText,
} from "../agents/auth-profiles/sqlite-json.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  inspectPersistedSharedAuthProfileStateRaw,
  inspectPersistedSharedAuthProfileStoreRaw,
  readAuthProfileStateJsonTextReadOnly,
  readPersistedAuthProfileStateRaw,
  readPersistedAuthProfileStoreRaw,
  readPersistedSharedAuthProfileStateRaw,
  readPersistedSharedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
  type AuthProfileDatabase,
} from "../agents/auth-profiles/sqlite.js";
import { coerceAuthProfileState } from "../agents/auth-profiles/state.js";
import { saveAuthProfileStoreWithPreparedOwner } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileState, AuthProfileStore } from "../agents/auth-profiles/types.js";
import { resolveLegacyInheritedAuthAgentDir } from "../agents/legacy-inherited-auth-dir.js";
import { OPENAI_PROVIDER_ID } from "../agents/openai-routing.js";
import { formatCliCommand } from "../cli/command-format.js";
import { createConfigRuntimeEnv } from "../config/config-env-vars.js";
import { copyConfigResolutionFactsThroughRewrite } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { loadJsonFileThroughSymlink } from "../infra/json-file.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../infra/sqlite-worker-identity.js";
import { readLegacyMigrationReceipt } from "../infra/state-migrations.receipts.js";
import { rewritePluginAuthProfileRefs } from "../plugins/auth-profile-config-refs.js";
import { createVerifiedDatabaseMigrationBackup } from "../snapshot/database-backup.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { requireOpenClawStateDatabaseIdentity } from "../state/openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { renameUserProfileAuthLinks } from "../state/user-model-accounts.js";
import { shortenHomePath } from "../utils.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import {
  listAuthProfileRepairCandidates,
  listReferencedLegacyOAuthSidecarPaths,
  resolveLegacyAuthStatePath as resolveAuthStatePath,
  resolveLegacyFlatAuthPath as resolveLegacyAuthStorePath,
  type AuthProfileRepairCandidate,
} from "./doctor-auth-legacy-paths.js";
import {
  acquireAuthProfileMigrationSourceLocks,
  archivePreviouslyMigratedAuthProfileSource,
  prepareAuthProfileSourceReceipt,
  parseAuthProfileMigrationSource,
  assertAuthProfileMigrationSourcesUnchanged,
  digestAuthProfileMigrationValue,
  finalizeAuthProfileMigrationSource,
  resumePendingAuthProfileMigrationArchives,
  type AuthProfileMigrationSourceReceipt,
} from "./doctor-auth-migration-receipts.js";
import {
  ensureConfigAuthProfiles,
  stripImportedConfigAuthProfileCredentials,
} from "./doctor-auth-profile-config.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  runWithAuthAliasMigrationReceipt,
  recordAuthAliasMigration,
  recoverAuthAliasMigration,
  type AuthAliasArchiveMapping,
  type AuthAliasStoreSnapshot,
} from "./doctor/auth-alias-receipt.js";
import {
  isLegacyOpenAICodexProvider,
  isLegacyOpenAICodexProfileId,
  canonicalLegacyAuthProvider,
  legacyAuthProfileTarget,
  isLegacyAuthProfileId,
  collectRawAuthRotationProfileIds,
  isReadableAuthAliasState,
  isReadableAuthAliasStore,
  allocateLegacyAuthProfileId,
  canonicalizeLegacyAuthProfileEntries,
  canonicalizeLegacyAuthOrder,
  canonicalizeLegacyAuthStore,
} from "./doctor/auth-alias-transforms.js";
import {
  coerceLegacyConfigAuthProfileStore,
  coerceLegacyFlatAuthProfileStore,
  extractProviderPrefix,
  isSafeLegacyProviderKey,
} from "./doctor/auth-legacy-config-coercion.js";
import { createAuthMigrationWarningRecorder } from "./doctor/auth-migration-findings.js";
import { listMutableCodexRouteAgentEntries } from "./doctor/shared/codex-route-agent-entries.js";
import {
  collectUnresolvedLegacyOAuthSidecarProfileIds,
  prepareLegacyOAuthSidecarImport,
  parseLegacyOAuthFile,
  finalizeLegacyOAuthSidecarImports,
  resolveLegacyOAuthSecretKeyFiles,
} from "./doctor/shared/legacy-oauth-sidecar.js";
import {
  repairModelRefAuthProfile,
  repairRetiredConfigModelRefs,
} from "./doctor/shared/retired-model-ref-repair.js";
import { inspectAuthDatabaseFiles } from "./doctor/shared/stale-auth-order-store.js";

type AuthProfileSqliteMigrationCandidate = AuthProfileRepairCandidate & {
  statePath: string;
  legacyPath: string;
};

function resolveMigrationTargetDatabasePath(
  agentDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return agentDir ? resolveAuthProfileDatabasePath(agentDir) : resolveSharedAuthStorePath(env);
}

function listAuthProfileMigrationTargets(
  candidates: readonly AuthProfileRepairCandidate[],
  env: NodeJS.ProcessEnv,
): Map<string, string | undefined> {
  const targets = new Map<string, string | undefined>([
    [resolveSharedAuthStorePath(env), undefined],
  ]);
  for (const agentDir of [
    resolveSharedMainAuthAgentDir(env),
    ...candidates.flatMap((candidate) => (candidate.agentDir ? [candidate.agentDir] : [])),
  ]) {
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    if (!targets.has(databasePath)) {
      targets.set(databasePath, agentDir);
    }
  }
  return targets;
}

type AwsSdkProfileMarker = {
  profileId: string;
  provider: string;
  email?: string;
  displayName?: string;
};

class AuthProfileMigrationVerificationError extends Error {
  constructor(readonly detail: string | null) {
    super("auth profile SQLite verification failed");
    this.name = "AuthProfileMigrationVerificationError";
  }
}

type LegacyFlatAuthProfileRepairResult = {
  detected: string[];
  changes: string[];
  configChanged?: boolean;
  /** Source and target IDs from verified imports whose archival completed. */
  migratedProfileIds: Set<string>;
  blockedProfileIds: Set<string>;
  warnings: string[];
  findings: HealthFinding[];
  aliasFindings: readonly HealthFinding[];
};

function listAuthProfileSqliteMigrationCandidates(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): AuthProfileSqliteMigrationCandidate[] {
  return listAuthProfileRepairCandidates(cfg, env).map((candidate) => ({
    agentDir: candidate.agentDir,
    authPath: candidate.authPath,
    statePath: resolveAuthStatePath(path.dirname(candidate.authPath)),
    legacyPath: resolveLegacyAuthStorePath(path.dirname(candidate.authPath)),
  }));
}

function hasAuthProfileState(state: AuthProfileState): boolean {
  return Boolean(state.order || state.lastGood || state.usageStats);
}

function collectAuthProfileStateProfileIds(state: AuthProfileState): string[] {
  return [
    ...new Set([
      ...Object.values(state.order ?? {}).flat(),
      ...Object.values(state.lastGood ?? {}),
      ...Object.keys(state.usageStats ?? {}),
    ]),
  ];
}

function collectAuthOwnerProfileIds(store: unknown, state: unknown): Set<string> {
  const profiles = isRecord(store) && isRecord(store.profiles) ? store.profiles : {};
  return new Set([
    ...Object.keys(profiles),
    ...collectRawAuthRotationProfileIds(store),
    ...collectRawAuthRotationProfileIds(state),
  ]);
}

function isDefaultAgentCandidate(
  candidate: AuthProfileSqliteMigrationCandidate,
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    candidate.agentDir === undefined ||
    path.resolve(candidate.agentDir) === path.resolve(resolveLegacyInheritedAuthAgentDir(cfg, env))
  );
}

function mergeImportedAuthProfiles(params: {
  store: AuthProfileStore;
  profiles: AuthProfileStore["profiles"];
  existingProfileIds: ReadonlySet<string>;
  replaceExistingWithoutCredential?: boolean;
}): AuthProfileStore {
  const profiles = { ...params.store.profiles };
  for (const [profileId, credential] of Object.entries(params.profiles)) {
    const existing = profiles[profileId];
    if (
      !params.existingProfileIds.has(profileId) ||
      (params.replaceExistingWithoutCredential &&
        existing &&
        !hasUsableAuthProfileCredential(existing) &&
        hasUsableAuthProfileCredential(credential))
    ) {
      profiles[profileId] = credential;
    }
  }
  return { ...params.store, profiles };
}

function mergeImportedAuthProfileState(params: {
  store: AuthProfileStore;
  state: AuthProfileState;
  existingState: AuthProfileState;
}): AuthProfileStore {
  // Preserve current SQLite state over imported JSON state; old files are backup-only after import.
  const next = { ...params.store };
  for (const field of ["order", "lastGood", "usageStats"] as const) {
    const incoming = params.state[field];
    if (!incoming) {
      continue;
    }
    const existing = params.existingState[field] ?? {};
    Object.assign(next, {
      [field]: {
        ...params.store[field],
        ...Object.fromEntries(
          Object.entries(incoming).filter(([key]) => !Object.hasOwn(existing, key)),
        ),
      },
    });
  }
  return next;
}

function formatMissingAuthProfileSqliteVerification(params: {
  expected: AuthProfileStore;
  importedProfileIds: ReadonlySet<string>;
  loaded: AuthProfileStore | null;
}): string | null {
  const missingProfileIds = [...params.importedProfileIds].filter(
    (profileId) => !params.loaded?.profiles[profileId],
  );
  const missingStateFields: string[] = [];
  for (const field of ["order", "lastGood"] as const) {
    for (const [provider, expected] of Object.entries(params.expected[field] ?? {})) {
      if (!isDeepStrictEqual(params.loaded?.[field]?.[provider], expected)) {
        missingStateFields.push(`${field}.${provider}`);
      }
    }
  }
  for (const profileId of Object.keys(params.expected.usageStats ?? {})) {
    if (!params.loaded?.usageStats?.[profileId]) {
      missingStateFields.push(`usageStats.${profileId}`);
    }
  }

  const parts: string[] = [];
  if (missingProfileIds.length > 0) {
    parts.push(`imported profile(s): ${missingProfileIds.toSorted().join(", ")}`);
  }
  if (missingStateFields.length > 0) {
    parts.push(`auth state field(s): ${missingStateFields.toSorted().join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function hasImportableAuthProfileStore(store: AuthProfileStore | null): store is AuthProfileStore {
  return Boolean(store && (Object.keys(store.profiles).length > 0 || hasAuthProfileState(store)));
}

function loadAuthProfileMigrationTargetStore(
  agentDir: string | undefined,
  database?: AuthProfileDatabase,
  env: NodeJS.ProcessEnv = process.env,
): AuthProfileStore {
  const explicitSharedRead = agentDir === undefined && database === undefined;
  const inspection = explicitSharedRead
    ? inspectPersistedSharedAuthProfileStoreRaw(env)
    : inspectPersistedAuthProfileStoreRaw(agentDir, database);
  const store = explicitSharedRead
    ? loadPersistedSharedAuthProfileStore(env)
    : loadPersistedAuthProfileStore(agentDir, database ? { database } : undefined);
  if (store) {
    return store;
  }
  if (inspection.status !== "missing") {
    throw new Error("current auth profile store is unreadable; legacy source left in place");
  }
  const stateInspection = explicitSharedRead
    ? inspectPersistedSharedAuthProfileStateRaw(env)
    : inspectPersistedAuthProfileStateRaw(agentDir, database);
  if (stateInspection.status === "unreadable") {
    throw new Error("current auth profile state is unreadable; legacy source left in place");
  }
  return {
    version: AUTH_STORE_VERSION,
    profiles: {},
    ...coerceAuthProfileState(
      explicitSharedRead
        ? readPersistedSharedAuthProfileStateRaw(env)
        : readPersistedAuthProfileStateRaw(agentDir, database),
    ),
  };
}

/**
 * Imports legacy auth profile JSON and state files into the per-agent SQLite store.
 *
 * JSON files are verified and atomically renamed to timestamped archives only after import.
 * Referenced OAuth sidecars are decoded only here; unavailable secrets retain ref-only rows.
 * Sources are archived after verification, with re-authentication guidance for gaps.
 */
export async function maybeMigrateAuthProfileJsonStoresToSqlite(params: {
  cfg: OpenClawConfig;
  prompter: Pick<DoctorPrompter, "confirmAutoFix">;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  openAICodexAuthProfileIdMap?: ReadonlyMap<string, string>;
}): Promise<LegacyFlatAuthProfileRepairResult> {
  const now = params.now ?? Date.now;
  const env = params.env ?? process.env;
  const candidates = listAuthProfileSqliteMigrationCandidates(params.cfg, env);
  const oauthEnv = createConfigRuntimeEnv(params.cfg, env);
  const oauthPath = resolveLegacyOAuthPath(oauthEnv);
  const recoverableSources = new Set<string>();
  let recoveryApproved = false;
  const recoverCompleted = (receipt: AuthProfileMigrationSourceReceipt): boolean => {
    const candidate = candidates.find((entry) =>
      [entry.authPath, entry.legacyPath].includes(receipt.sourcePath),
    );
    if (!candidate) {
      return false;
    }
    const raw = parseAuthProfileMigrationSource(receipt);
    normalizeLegacyAuthProfileFields(raw);
    const imported = coerceLegacyAuthProfileStore(raw) ?? coerceLegacyFlatAuthProfileStore(raw);
    if (!imported || !Object.values(imported.profiles).some(hasUsableAuthProfileCredential)) {
      return false;
    }
    // Current ownership wins over the receipt's historical database path.
    // Legacy provider aliases are ambiguous without fingerprints; any surviving
    // credential for that provider prevents replay under a newly allocated id.
    const inspection = candidate.agentDir
      ? inspectPersistedAuthProfileStoreRaw(candidate.agentDir)
      : inspectPersistedSharedAuthProfileStoreRaw(env);
    const rawTarget =
      inspection.status === "missing"
        ? { profiles: {} }
        : inspection.status === "readable"
          ? inspection.raw
          : null;
    if (!isRecord(rawTarget) || !isRecord(rawTarget.profiles)) {
      return false;
    }
    const existing = rawTarget.profiles;
    if (
      Object.entries(imported.profiles).some(
        ([id, credential]) =>
          Object.hasOwn(existing, id) ||
          ((isLegacyOpenAICodexProfileId(id) || isLegacyOpenAICodexProvider(credential.provider)) &&
            Object.entries(existing).some(
              ([key, entry]) =>
                key.startsWith("openai:") ||
                (isRecord(entry) && entry.provider === OPENAI_PROVIDER_ID),
            )),
      )
    ) {
      return false;
    }
    recoverableSources.add(receipt.sourcePath);
    return recoveryApproved;
  };
  const warnings: string[] = [];
  const findings: HealthFinding[] = [];
  const reportWarning = createAuthMigrationWarningRecorder(warnings, findings);
  const migratedProfileIds = new Set<string>();
  const blockedProfileIds = new Set<string>();
  const resume = () => {
    try {
      return resumePendingAuthProfileMigrationArchives(env, recoverCompleted);
    } catch (err) {
      params.openAICodexAuthProfileIdMap?.forEach((_target, id) => blockedProfileIds.add(id));
      reportWarning(
        `Could not finalize an interrupted auth profile archive; legacy sources were left for recovery: ${String(err)}`,
        "archive-finalization",
        "Keep the retained sources and archives. Check the reported filesystem error and access permissions, then rerun openclaw doctor --fix to finish archival. Verify current auth separately with openclaw models status.",
        undefined,
        "historical",
      );
      return [];
    }
  };
  const resumedChanges = resume();
  const configStore = coerceLegacyConfigAuthProfileStore(params.cfg);
  const candidateSources = (candidate: AuthProfileSqliteMigrationCandidate) =>
    [
      candidate.authPath,
      candidate.statePath,
      candidate.legacyPath,
      ...(isDefaultAgentCandidate(candidate, params.cfg, env) ? [oauthPath] : []),
    ].filter(
      (pathname) =>
        fs.existsSync(pathname) ||
        recoverableSources.has(pathname) ||
        (configStore &&
          isDefaultAgentCandidate(candidate, params.cfg, env) &&
          pathname === candidate.authPath),
    );
  const detected = candidates.filter((candidate) => candidateSources(candidate).length > 0);
  const result: LegacyFlatAuthProfileRepairResult = {
    detected: detected.flatMap(candidateSources),
    changes: resumedChanges,
    migratedProfileIds,
    blockedProfileIds,
    warnings,
    findings,
    aliasFindings: [],
  };
  if (warnings.length > 0) {
    // A pending imported receipt owns its source until recovery succeeds.
    // Starting a new hash-based run would orphan that crash-recovery record.
    return result;
  }
  if (detected.length === 0) {
    return result;
  }

  note(
    [
      ...detected.map((candidate) => {
        const hasCredentials =
          fs.existsSync(candidate.authPath) || fs.existsSync(candidate.legacyPath);
        const providers = readLegacyAuthProfileProviders([
          { kind: "auth-profiles", path: candidate.authPath },
          ...(fs.existsSync(candidate.legacyPath)
            ? [{ kind: "legacy-auth" as const, path: candidate.legacyPath }]
            : []),
        ]);
        return `- ${shortenHomePath(candidate.authPath)} / ${shortenHomePath(candidate.statePath)}${hasCredentials ? ` (affected providers: ${providers?.join(", ") ?? "unknown; provider scope unavailable"})` : ""}`;
      }),
      `- ${formatCliCommand("openclaw doctor --fix")} imports legacy auth profile JSON into SQLite, verifies it, records a receipt, and archives the original bytes.`,
    ].join("\n"),
    "Auth profile SQLite migration",
  );

  const shouldRepair = await params.prompter.confirmAutoFix({
    message: "Migrate auth profile JSON files into SQLite now?",
    initialValue: true,
  });
  if (!shouldRepair) {
    return result;
  }
  if (recoverableSources.size > 0) {
    recoveryApproved = true;
    const warningCount = warnings.length;
    result.changes.push(...resume());
    if (warnings.length > warningCount) {
      return result;
    }
  }

  // Validate the same collision decision before either source family can lose its old IDs.
  const requestedProfileIdMap =
    params.openAICodexAuthProfileIdMap ??
    collectOpenAICodexAuthProfileStoreIdMap({ cfg: params.cfg, env });
  const repairedFields = await maybeRepairLegacyAuthProfileStores({
    cfg: params.cfg,
    env,
    profileIdMap: requestedProfileIdMap,
    renameProfileIds: false,
  });
  result.changes.push(...repairedFields.changes);
  warnings.push(...repairedFields.warnings);
  result.aliasFindings = repairedFields.findings;
  const openAIProfileIdMap = repairedFields.profileIdMap;
  for (const [from, to] of requestedProfileIdMap) {
    if (openAIProfileIdMap.get(from) !== to) {
      blockedProfileIds.add(from);
      blockedProfileIds.add(to);
    }
  }
  const sidecarPaths = listReferencedLegacyOAuthSidecarPaths(env, params.cfg);
  const pendingSidecarArchives = new Map<string, AuthProfileMigrationSourceReceipt>();
  for (const candidate of detected) {
    const configOwnerCandidate = isDefaultAgentCandidate(candidate, params.cfg, env);
    const candidateProfileIds = new Set<string>();
    let completed = false;
    let releaseSources: (() => void) | undefined;
    try {
      const candidateSourcePaths = [
        candidate.authPath,
        candidate.statePath,
        candidate.legacyPath,
        ...(configOwnerCandidate ? [oauthPath] : []),
      ];
      for (const pathname of candidateSourcePaths) {
        fs.mkdirSync(path.dirname(pathname), { recursive: true });
      }
      releaseSources = acquireAuthProfileMigrationSourceLocks([
        ...candidateSourcePaths,
        ...sidecarPaths,
      ]);
      const targetDatabasePath = resolveMigrationTargetDatabasePath(candidate.agentDir, env);
      const sharedStateTarget =
        candidate.agentDir === undefined &&
        resolveSharedAuthStoreOwnership(env).location === "state-db";
      // A shared candidate on a legacy root names the main agent dir explicitly: it resolves to the
      // same database, but an undefined agent dir would enter the shared-write bootstrap and could
      // record state-db ownership midway through this import. Doctor stays the only owner of that flip.
      const transactionAgentDir =
        sharedStateTarget || candidate.agentDir !== undefined
          ? candidate.agentDir
          : resolveSharedMainAuthAgentDir(env);
      let sourceReceipts = candidateSourcePaths.filter(fs.existsSync).map((pathname) =>
        prepareAuthProfileSourceReceipt({
          pathname,
          targetDatabasePath,
          targetTable:
            pathname === candidate.statePath
              ? "auth_profile_state"
              : sharedStateTarget
                ? "auth_profile_stores"
                : "auth_profile_store",
          targetStoreKey: sharedStateTarget ? "shared" : "primary",
          now,
          env,
        }),
      );
      sourceReceipts = sourceReceipts.filter((receipt) => {
        const archivePath = archivePreviouslyMigratedAuthProfileSource(receipt);
        if (!archivePath) {
          return true;
        }
        result.changes.push(
          `Preserved a previously migrated legacy auth source without replaying credentials (${shortenHomePath(archivePath)}).`,
        );
        return false;
      });
      assertAuthProfileMigrationSourcesUnchanged(candidateSourcePaths, sourceReceipts);
      if (sourceReceipts.length === 0 && !configStore) {
        continue;
      }
      const receiptByPath = new Map(
        sourceReceipts.map((receipt) => [receipt.sourcePath, receipt] as const),
      );
      const rawStore = parseAuthProfileMigrationSource(
        receiptByPath.get(path.resolve(candidate.authPath)),
      );
      const sidecarReceipts = prepareLegacyOAuthSidecarImport({
        rawStore,
        env,
        oauthEnv,
        targetDatabasePath,
        targetStoreKey: sharedStateTarget ? "shared" : "primary",
        now,
      });
      const importedAliasProfileIds = new Set(
        isRecord(rawStore) && isRecord(rawStore.profiles) ? Object.keys(rawStore.profiles) : [],
      );
      const rawState = parseAuthProfileMigrationSource(
        receiptByPath.get(path.resolve(candidate.statePath)),
      );
      for (const id of [
        ...importedAliasProfileIds,
        ...collectRawAuthRotationProfileIds(rawStore),
        ...collectRawAuthRotationProfileIds(rawState),
        ...(configOwnerCandidate && configStore ? Object.keys(configStore.profiles) : []),
      ]) {
        candidateProfileIds.add(id);
      }
      const openAIProviderRepair = canonicalizeLegacyAuthStore(
        rawStore,
        rawState,
        openAIProfileIdMap,
      );
      const unresolvedSidecarProfileIds = new Set(
        collectUnresolvedLegacyOAuthSidecarProfileIds(rawStore),
      );
      const unresolvedSidecarWarning =
        unresolvedSidecarProfileIds.size > 0
          ? `Migrated ${unresolvedSidecarProfileIds.size} legacy OAuth sidecar profile${unresolvedSidecarProfileIds.size === 1 ? "" : "s"} from ${shortenHomePath(candidate.authPath)} into SQLite as configured-unavailable without credentials (archives: ${[...sourceReceipts, ...sidecarReceipts].map((receipt) => shortenHomePath(receipt.archivePath)).join(", ")}). Doctor could not recover credentials using the historical key files (${resolveLegacyOAuthSecretKeyFiles(
              oauthEnv,
            )
              .map((filePath) => shortenHomePath(filePath))
              .join(
                ", ",
              )}) or macOS Keychain. The archives preserve the original material; sign in again with ${formatCliCommand("openclaw models auth login --provider openai")}.`
          : undefined;
      const rawProfiles =
        isRecord(rawStore) && isRecord(rawStore.profiles) ? rawStore.profiles : undefined;
      const awsSdkMarkers = rawProfiles ? readAwsSdkAuthProfileMarkers(candidate) : null;
      if (rawProfiles && awsSdkMarkers) {
        for (const { profileId } of awsSdkMarkers) {
          delete rawProfiles[profileId];
        }
      }
      const canonicalizedSecretRefs = normalizeLegacyAuthProfileFields(rawStore);
      const maybeCanonicalStore =
        coerceLegacyAuthProfileStore(rawStore) ??
        coerceLegacyFlatAuthProfileStore(rawStore) ??
        null;
      const canonicalStore = hasImportableAuthProfileStore(maybeCanonicalStore)
        ? maybeCanonicalStore
        : null;
      const configCanonicalStore =
        configStore && configOwnerCandidate ? structuredClone(configStore) : null;
      if (configCanonicalStore) {
        Object.keys(configCanonicalStore.profiles).forEach((id) => importedAliasProfileIds.add(id));
        canonicalizeLegacyAuthStore(configCanonicalStore, null, openAIProfileIdMap);
      }
      const oauthSource = receiptByPath.get(path.resolve(oauthPath));
      const { store: oldOAuthStore, rejectedEntries: rejectedOAuthEntries } = parseLegacyOAuthFile(
        oauthSource ? parseAuthProfileMigrationSource(oauthSource) : undefined,
      );
      const legacyStore = {
        ...oldOAuthStore,
        ...coerceLegacyAuthStore(
          parseAuthProfileMigrationSource(receiptByPath.get(path.resolve(candidate.legacyPath))),
        ),
      };
      const hasLegacyStore = Object.keys(legacyStore).length > 0;
      const state = coerceAuthProfileState(rawState);
      if (
        !canonicalStore &&
        !configCanonicalStore &&
        !hasLegacyStore &&
        !hasAuthProfileState(state) &&
        !awsSdkMarkers
      ) {
        if (sourceReceipts.length > 0) {
          const archived = sourceReceipts.map((receipt) => {
            finalizeAuthProfileMigrationSource(receipt, "archived-unparsed");
            return receipt.archivePath;
          });
          reportWarning(
            unresolvedSidecarWarning ??
              `Archived unparseable auth profile input without import for ${shortenHomePath(candidate.authPath)} (${archived.map(shortenHomePath).join(", ")}).`,
            unresolvedSidecarWarning ? "missing-oauth-sidecar" : "archived-unparsed",
            unresolvedSidecarWarning
              ? "Run openclaw models status to identify the unavailable profiles, then openclaw models auth login --provider <provider-id> for their configured providers. Keep the archived sources."
              : "Keep the listed archives. Compare openclaw models status with your expected accounts; if credentials are missing, inspect the archive for manual recovery or sign in with openclaw models auth login --provider <provider-id>.",
            candidate.authPath,
            unresolvedSidecarWarning ? "fix-now" : "historical",
          );
          continue;
        }
        reportWarning(
          `Left auth profile JSON in place for ${shortenHomePath(candidate.authPath)} because no importable auth profiles or state were found.`,
          "unimportable-source",
          "Inspect the retained source and compare openclaw models status with the accounts you expect. If credentials are unavailable, use openclaw models auth login --provider <provider-id>; keep the source for manual recovery.",
          candidate.authPath,
          "recommended",
        );
        continue;
      }

      const existing = loadAuthProfileMigrationTargetStore(candidate.agentDir, undefined, env);
      const existingProfileIds = new Set(Object.keys(existing.profiles));
      const existingState = coerceAuthProfileState(existing);
      let next: AuthProfileStore = { ...existing };
      let verifiedStore = existing;
      const importedProfileIds = new Set<string>();
      const legacyAsStore: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
      if (hasLegacyStore) {
        applyLegacyAuthStore(legacyAsStore, legacyStore);
        Object.keys(legacyAsStore.profiles).forEach((id) => importedAliasProfileIds.add(id));
        Object.keys(legacyAsStore.profiles).forEach((id) => candidateProfileIds.add(id));
        canonicalizeLegacyAuthStore(legacyAsStore, null, openAIProfileIdMap);
      }
      for (const imported of [legacyAsStore, canonicalStore, configCanonicalStore]) {
        if (!imported) {
          continue;
        }
        Object.keys(imported.profiles).forEach((id) => importedProfileIds.add(id));
        const fromConfig = imported === configCanonicalStore;
        // Config fills missing credentials; canonical JSON overrides auth.json,
        // but neither replaces credentials already held by SQLite.
        next = mergeImportedAuthProfiles({
          store: next,
          profiles: imported.profiles,
          existingProfileIds: fromConfig ? new Set(Object.keys(next.profiles)) : existingProfileIds,
          replaceExistingWithoutCredential: fromConfig,
        });
        if (imported === canonicalStore) {
          next.version = Math.max(next.version, imported.version);
          next = mergeImportedAuthProfileState({
            store: next,
            state: coerceAuthProfileState(imported),
            existingState,
          });
        }
      }
      if (hasAuthProfileState(state)) {
        next = mergeImportedAuthProfileState({ store: next, state, existingState });
      }

      if (canonicalStore || configCanonicalStore || hasLegacyStore || hasAuthProfileState(state)) {
        const stateProfileIds = [state, canonicalStore, configCanonicalStore].flatMap((store) =>
          store ? collectAuthProfileStateProfileIds(coerceAuthProfileState(store)) : [],
        );
        try {
          assertAuthProfileMigrationSourcesUnchanged(candidateSourcePaths, [
            ...sourceReceipts,
            ...sidecarReceipts,
          ]);
          const aliasReceiptSha256 = recordAuthAliasMigration({
            profileIdMap: openAIProfileIdMap,
            stores: [{ databasePath: targetDatabasePath, store: existing, migratedStore: next }],
            importedProfileIds: importedAliasProfileIds,
            sources: sourceReceipts
              .filter((receipt) => receipt.sourcePath !== path.resolve(candidate.statePath))
              .map((receipt) => ({ path: receipt.sourcePath, sha256: receipt.sourceSha256 })),
            env,
          });
          verifiedStore = runWithAuthAliasMigrationReceipt(aliasReceiptSha256, env, () =>
            runAuthProfileWriteTransaction(
              transactionAgentDir,
              (database, owner) => {
                const authoritative = loadAuthProfileMigrationTargetStore(
                  candidate.agentDir,
                  database,
                );
                // This store includes the separately persisted auth_profile_state row,
                // so state-only concurrent changes abort before either table is written.
                if (!isDeepStrictEqual(authoritative, existing)) {
                  throw new Error("current auth profile store changed during legacy migration");
                }
                saveAuthProfileStoreWithPreparedOwner(
                  next,
                  candidate.agentDir,
                  {
                    filterExternalAuthProfiles: false,
                    // Imported state may reference external profiles absent from this store.
                    preserveStateProfileIds: stateProfileIds,
                    syncExternalCli: false,
                  },
                  database,
                  owner,
                );
                const loaded = loadPersistedAuthProfileStore(candidate.agentDir, { database });
                const isMainStore =
                  resolveMigrationTargetDatabasePath(candidate.agentDir, env) ===
                  resolveSharedAuthStorePath(env);
                const persistedStores = {
                  isMainStore,
                  localStore: loaded,
                  mainStore: isMainStore ? loaded : loadPersistedSharedAuthProfileStore(env),
                };
                // A non-main store drops an OAuth credential the main store already
                // owns at the same or newer expiry. That dedup is intentional, so
                // verifying it as missing would abort a migration that lost nothing
                // and leave the legacy JSON in place, which blocks gateway startup.
                const verifiableProfileIds = new Set(
                  [...importedProfileIds].filter((profileId) => {
                    const credential = next.profiles[profileId];
                    return !(
                      credential !== undefined &&
                      !loaded?.profiles[profileId] &&
                      isInheritedMainOAuthCredentialFromStores({
                        profileId,
                        credential,
                        persistedStores,
                      })
                    );
                  }),
                );
                const verificationFailure = formatMissingAuthProfileSqliteVerification({
                  expected: next,
                  importedProfileIds: verifiableProfileIds,
                  loaded,
                });
                const mismatchedCredential = [...verifiableProfileIds].some((profileId) => {
                  if (existingProfileIds.has(profileId)) {
                    return false;
                  }
                  return !isDeepStrictEqual(loaded?.profiles[profileId], next.profiles[profileId]);
                });
                if (verificationFailure || mismatchedCredential || !loaded) {
                  throw new AuthProfileMigrationVerificationError(verificationFailure);
                }
                return loaded;
              },
              { env },
            ),
          );
        } catch (error) {
          if (!(error instanceof AuthProfileMigrationVerificationError)) {
            throw error;
          }
          reportWarning(
            `Left auth profile JSON in place for ${shortenHomePath(candidate.authPath)} because SQLite verification failed${error.detail ? ` (${error.detail})` : ""}.`,
            "verification-failed",
            "Keep the original JSON and recovery copy. Inspect the reported SQLite verification error and filesystem permissions; rerun openclaw doctor --fix after correcting the cause. Do not delete the credential database.",
            candidate.authPath,
          );
          continue;
        }
      }

      const expectedProfileSha256 = Object.fromEntries(
        [...importedProfileIds].flatMap((profileId) => {
          const profileValue = verifiedStore.profiles[profileId];
          return profileValue
            ? [[profileId, digestAuthProfileMigrationValue(profileValue)] as const]
            : [];
        }),
      );
      const expectedStateSha256 = digestAuthProfileMigrationValue(
        candidate.agentDir
          ? readPersistedAuthProfileStateRaw(candidate.agentDir)
          : readPersistedSharedAuthProfileStateRaw(env),
      );
      const canonicalSourceCarriesState = canonicalStore
        ? hasAuthProfileState(coerceAuthProfileState(canonicalStore))
        : false;
      for (const receipt of sourceReceipts) {
        if (receipt.targetTable !== "auth_profile_state") {
          receipt.expectedProfileSha256 = expectedProfileSha256;
        }
        if (
          receipt.targetTable === "auth_profile_state" ||
          (receipt.sourcePath === candidate.authPath && canonicalSourceCarriesState)
        ) {
          receipt.expectedStateSha256 = expectedStateSha256;
        }
      }
      assertAuthProfileMigrationSourcesUnchanged(candidateSourcePaths, [
        ...sourceReceipts,
        ...sidecarReceipts,
      ]);
      for (const receipt of sidecarReceipts) {
        receipt.expectedProfileSha256 = expectedProfileSha256;
        pendingSidecarArchives.set(receipt.sourcePath, receipt);
      }
      const archives = sourceReceipts.map((receipt) => {
        finalizeAuthProfileMigrationSource(receipt, "completed");
        return receipt.archivePath;
      });
      for (const id of [
        ...importedAliasProfileIds,
        ...importedProfileIds,
        ...collectAuthProfileStateProfileIds(state),
        ...collectAuthProfileStateProfileIds(coerceAuthProfileState(canonicalStore)),
        ...collectAuthProfileStateProfileIds(coerceAuthProfileState(configCanonicalStore)),
      ]) {
        migratedProfileIds.add(id);
      }
      if (
        configStore &&
        configOwnerCandidate &&
        stripImportedConfigAuthProfileCredentials(params.cfg, configStore)
      ) {
        result.configChanged = true;
      }
      if (awsSdkMarkers) {
        const configProfiles = ensureConfigAuthProfiles(params.cfg);
        for (const marker of awsSdkMarkers) {
          configProfiles[marker.profileId] = {
            provider: marker.provider,
            mode: "aws-sdk",
            ...(marker.email ? { email: marker.email } : {}),
            ...(marker.displayName ? { displayName: marker.displayName } : {}),
          };
        }
        result.configChanged = true;
      }
      const archiveText =
        archives.length > 0
          ? `archive${archives.length === 1 ? "" : "s"}: ${archives.map(shortenHomePath).join(", ")}`
          : "no legacy JSON backup needed";
      result.changes.push(
        `Migrated auth profile JSON for ${shortenHomePath(candidate.authPath)} into SQLite (${archiveText}).`,
      );
      if (canonicalizedSecretRefs > 0) {
        result.changes.push(
          `Canonicalized ${canonicalizedSecretRefs} auth SecretRef(s) to source/provider/id; unsupported fields are preserved in the verified source archives (${archiveText}).`,
        );
      }
      completed = true;
      if (rejectedOAuthEntries > 0) {
        const oauthArchive = receiptByPath.get(path.resolve(oauthPath))?.archivePath;
        result.warnings.push(
          `Could not import ${rejectedOAuthEntries} legacy OAuth credential entries; original bytes are preserved in ${shortenHomePath(oauthArchive ?? oauthPath)}. Restore that archive to ${shortenHomePath(oauthPath)}, correct the entries, and rerun ${formatCliCommand("openclaw doctor --fix")}; alternatively re-authenticate with ${formatCliCommand("openclaw models auth login --provider <provider>")}.`,
        );
      }
      if (unresolvedSidecarWarning) {
        reportWarning(
          unresolvedSidecarWarning,
          "missing-oauth-sidecar",
          "Run openclaw models status to identify the unavailable profiles, then openclaw models auth login --provider <provider-id> for their configured providers. Keep the archived sources.",
          candidate.authPath,
        );
      }
      if (openAIProviderRepair !== null) {
        result.changes.push(
          `Migrated retired auth profile identifiers in ${shortenHomePath(candidate.authPath)}.`,
        );
      }
      if (awsSdkMarkers) {
        result.changes.push(
          `Moved aws-sdk profile metadata from ${shortenHomePath(candidate.authPath)} to auth.profiles before removing the legacy auth profile JSON.`,
        );
      }
    } catch (err) {
      // An unreadable source cannot authorize any planned reference substitution.
      if (candidateProfileIds.size === 0) {
        openAIProfileIdMap.forEach((_target, id) => blockedProfileIds.add(id));
      }
      reportWarning(
        `Failed to migrate auth profile JSON for ${shortenHomePath(candidate.authPath)}: ${String(err)}`,
        "import-failed",
        `Preserve the source and recovery copy. Restore valid UTF-8 JSON from a verified backup if unreadable; otherwise correct the reported source or database access error, then rerun ${formatCliCommand("openclaw doctor --fix")}. Use openclaw models status to identify credentials still requiring login.`,
        candidate.authPath,
      );
    } finally {
      if (!completed) {
        candidateProfileIds.forEach((id) => blockedProfileIds.add(id));
      }
      releaseSources?.();
    }
  }
  const sidecarArchives = finalizeLegacyOAuthSidecarImports({
    cfg: params.cfg,
    env,
    receipts: pendingSidecarArchives.values(),
  });
  result.changes.push(...sidecarArchives.changes);
  result.warnings.push(...sidecarArchives.warnings);
  clearRuntimeAuthProfileStoreSnapshots();
  clearAuthProfileMigrationDiagnostics();
  return result;
}

function readAwsSdkAuthProfileMarkers(
  candidate: AuthProfileRepairCandidate,
): AwsSdkProfileMarker[] | null {
  if (!fs.existsSync(candidate.authPath)) {
    return null;
  }
  const raw = loadJsonFileThroughSymlink(candidate.authPath);
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return null;
  }
  const markers: AwsSdkProfileMarker[] = [];
  for (const [profileId, value] of Object.entries(raw.profiles)) {
    if (!isRecord(value)) {
      continue;
    }
    const mode = readNonEmptyString(value.type) ?? readNonEmptyString(value.mode);
    if (mode !== "aws-sdk") {
      continue;
    }
    const provider = readNonEmptyString(value.provider) ?? extractProviderPrefix(profileId, ":");
    if (!provider || !isSafeLegacyProviderKey(provider)) {
      continue;
    }
    markers.push({
      profileId,
      provider,
      ...(readNonEmptyString(value.email) ? { email: readNonEmptyString(value.email) } : {}),
      ...(readNonEmptyString(value.displayName)
        ? { displayName: readNonEmptyString(value.displayName) }
        : {}),
    });
  }
  return markers.length > 0 ? markers : null;
}

function rewriteMappedAuthProfileRefs(
  config: OpenClawConfig,
  profileIdMap: ReadonlyMap<string, string>,
): boolean {
  let changed = false;
  const rewrite = (owner: unknown, key: string) => {
    if (!isRecord(owner) || typeof owner[key] !== "string") {
      return;
    }
    let profileId = owner[key];
    if (key === "apiKey") {
      profileId = normalizeSecretInput(profileId);
    } else if (key === "authProfileId") {
      profileId = profileId.trim();
    }
    const replacement = profileIdMap.get(profileId);
    if (replacement && replacement !== owner[key]) {
      owner[key] = replacement;
      changed = true;
    }
  };
  for (const provider of Object.values(config.models?.providers ?? {})) {
    rewrite(provider, "apiKey");
  }
  for (const model of config.tools?.media?.models ?? []) {
    rewrite(model, "profile");
    rewrite(model, "preferredProfile");
  }
  for (const server of Object.values(config.mcp?.servers ?? {})) {
    rewrite(server.oauth, "authProfileId");
  }
  const agents = [
    config.agents?.defaults,
    ...listMutableCodexRouteAgentEntries(config).map(({ agent }) => agent),
  ];
  for (const agent of agents) {
    if (!isRecord(agent) || !isRecord(agent.models)) {
      continue;
    }
    for (const model of Object.values(agent.models)) {
      rewrite(isRecord(model) ? model.agentRuntime : undefined, "authProfileId");
    }
  }
  return changed;
}

/**
 * Canonicalizes config references for retired provider and profile identifiers.
 *
 * The optional map lets config and store repairs share deterministic profile ids when both surfaces
 * contain the same legacy profile.
 */
export function maybeRepairOpenAICodexAuthConfig(
  cfg: OpenClawConfig,
  options?: { profileIdMap?: ReadonlyMap<string, string> },
): {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
} {
  let config = structuredClone(cfg);
  const auth = isRecord(config.auth) ? config.auth : undefined;
  const profileIdMap = new Map<string, string>(options?.profileIdMap);
  let changed = false;
  if (isRecord(auth?.profiles)) {
    const rewrite = canonicalizeLegacyAuthProfileEntries(auth.profiles, {
      profileIdMap,
      preserveUnmappedLegacyIds: options?.profileIdMap !== undefined,
    });
    rewrite.profileIdMap.forEach((to, from) => profileIdMap.set(from, to));
    changed ||= rewrite.changed;
  }
  if (auth) {
    const orderChanged = canonicalizeLegacyAuthOrder(auth, profileIdMap, {
      preserveUnmappedLegacyIds: options?.profileIdMap !== undefined,
    });
    changed ||= orderChanged;
  }
  if (profileIdMap.size > 0 && rewriteMappedAuthProfileRefs(config, profileIdMap)) {
    changed = true;
  }
  if (profileIdMap.size > 0) {
    const models = repairRetiredConfigModelRefs(config, ({ modelRef }) =>
      repairModelRefAuthProfile(modelRef, profileIdMap),
    );
    config = models.config;
    changed ||= models.changes.length > 0;
    changed = rewritePluginAuthProfileRefs(config, profileIdMap) || changed;
  }
  if (changed) {
    copyConfigResolutionFactsThroughRewrite(cfg, config);
  }
  return {
    config: changed ? config : cfg,
    changes: changed ? ["Migrated legacy auth profile config to current providers."] : [],
    warnings: [],
  };
}

/** Normalize already-SQLite stores under their current owners after legacy import. */
export async function maybeRepairLegacyAuthProfileStores(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  profileIdMap: ReadonlyMap<string, string>;
  renameProfileIds?: boolean;
}): Promise<{
  changes: string[];
  warnings: string[];
  profileIdMap: ReadonlyMap<string, string>;
  findings: HealthFinding[];
}> {
  const env = params.env ?? process.env;
  const warnings: string[] = [];
  const findings: HealthFinding[] = [];
  const reportWarning = createAuthMigrationWarningRecorder(warnings, findings);
  let incompleteCensus = false;
  const warnUnavailable = (pathname: string) => {
    incompleteCensus = true;
    reportWarning(
      `Skipped auth-profile alias migration because ${shortenHomePath(pathname)} is unavailable.`,
      "owner-unavailable",
      "Check that the credential owner path exists and is readable by the OpenClaw user, then rerun openclaw doctor --fix. Keep existing credentials and archives.",
      pathname,
    );
  };
  const candidates = listAuthProfileRepairCandidates(params.cfg, env, warnUnavailable);
  const stores: AuthAliasStoreSnapshot[] = [];
  const planned: Array<{
    databasePath: string;
    identity: DatabasePathIdentity;
    canRenameAliases: boolean;
    canReadRotationState: boolean;
    agentDir?: string;
    store: unknown;
    state: unknown;
    unreadableStateJson?: string;
  }> = [];
  for (const [databasePath, agentDir] of listAuthProfileMigrationTargets(candidates, env)) {
    let identity: DatabasePathIdentity;
    try {
      identity = readDatabasePathIdentitySync(databasePath);
    } catch {
      warnUnavailable(databasePath);
      continue;
    }
    const store = agentDir
      ? inspectPersistedAuthProfileStoreRaw(agentDir)
      : inspectPersistedSharedAuthProfileStoreRaw(env);
    const state = agentDir
      ? inspectPersistedAuthProfileStateRaw(agentDir)
      : inspectPersistedSharedAuthProfileStateRaw(env);
    if (
      store.status === "unreadable" ||
      (agentDir !== undefined && inspectAuthDatabaseFiles(agentDir) === "unreadable") ||
      (store.status === "readable" && (!isRecord(store.raw) || !isRecord(store.raw.profiles)))
    ) {
      incompleteCensus = true;
      reportWarning(
        `Skipped auth-profile alias migration because ${shortenHomePath(databasePath)} is unreadable or invalid.`,
        "owner-invalid",
        "Keep the database and recovery copy. Correct access permissions or recover the credential store from a verified backup before rerunning openclaw doctor --fix; do not delete the database.",
        databasePath,
      );
      continue;
    }
    stores.push({ databasePath, store: store.status === "readable" ? store.raw : null });
    if (
      store.status === "readable" ||
      state.status === "readable" ||
      state.status === "unreadable"
    ) {
      assertExistingDatabaseIdentity(databasePath, identity.key, identity.birthtime);
      const canReadRotationState =
        state.status === "missing" ||
        (state.status === "readable" && isReadableAuthAliasState(state.raw));
      const canRenameAliases =
        (store.status !== "readable" || isReadableAuthAliasStore(store.raw)) &&
        canReadRotationState;
      if (!canRenameAliases) {
        reportWarning(
          `Skipped auth-profile alias renames because ${shortenHomePath(databasePath)} is unreadable or invalid; supported credential fields can still be repaired.`,
          "alias-state-invalid",
          "Keep the credential database and recovery copy. Inspect the invalid auth or rotation state and restore a verified backup if needed, then rerun openclaw doctor --fix.",
          databasePath,
        );
      }
      const unreadableStateJson =
        state.status === "unreadable"
          ? readAuthProfileStateJsonTextReadOnly({
              path: databasePath,
              kind:
                agentDir === undefined &&
                resolveSharedAuthStoreOwnership(env).location === "state-db"
                  ? "shared-state"
                  : "agent",
              env,
            })
          : undefined;
      assertExistingDatabaseIdentity(databasePath, identity.key, identity.birthtime);
      if (state.status === "unreadable" && unreadableStateJson === undefined) {
        incompleteCensus = true;
        reportWarning(
          `Skipped auth-profile field repair because ${shortenHomePath(databasePath)} has no stable rotation-state source.`,
          "rotation-source-unavailable",
          "Keep the database and recovery copy. Restore readable rotation state from a verified backup or correct the reported access problem before rerunning openclaw doctor --fix.",
          databasePath,
        );
        continue;
      }
      planned.push({
        databasePath,
        identity,
        canRenameAliases,
        canReadRotationState,
        agentDir,
        store: store.status === "readable" ? store.raw : null,
        state: state.status === "readable" ? state.raw : null,
        ...(unreadableStateJson !== undefined ? { unreadableStateJson } : {}),
      });
    }
  }
  const profileIdMap = new Map(incompleteCensus ? [] : params.profileIdMap);
  if (incompleteCensus && params.profileIdMap.size > 0) {
    reportWarning(
      "Deferred auth profile aliases because an owner could not be inspected; repair that owner and rerun Doctor.",
      "owner-inspection-incomplete",
      "Resolve the credential-owner path or database finding shown above, then rerun openclaw doctor --fix. Keep all account credentials until every owner can be inspected.",
    );
  }
  for (const target of planned) {
    if (target.canRenameAliases) {
      continue;
    }
    const references = collectAuthOwnerProfileIds(target.store, target.state);
    for (const [from, to] of profileIdMap) {
      if (!target.canReadRotationState || references.has(from) || references.has(to)) {
        profileIdMap.delete(from);
        reportWarning(
          `Deferred auth profile alias ${from} because ${shortenHomePath(target.databasePath)} cannot safely rename its credential owner.`,
          "alias-owner-unsafe",
          "Keep this profile and its credential owner. Repair the reported unreadable auth or rotation state from a verified backup, then rerun openclaw doctor --fix.",
          from,
        );
      }
    }
  }
  const recovery = recoverAuthAliasMigration({
    stores,
    env,
    archivedMappings: recoverArchivedAuthProfileMappings({ candidates, env }),
  });
  const migrationMap = params.renameProfileIds === false ? new Map<string, string>() : profileIdMap;
  const unresolvedProfileIds = new Set(
    Object.entries(params.cfg.auth?.profiles ?? {})
      .filter(
        ([id, profile]) =>
          !profileIdMap.has(id) &&
          (isLegacyAuthProfileId(id) ||
            (typeof profile.provider === "string" &&
              canonicalLegacyAuthProvider(profile.provider) !== profile.provider)),
      )
      .map(([id]) => id),
  );
  for (const target of planned) {
    for (const id of [
      ...collectRawAuthRotationProfileIds(target.store),
      ...collectRawAuthRotationProfileIds(target.state),
    ]) {
      if (isLegacyAuthProfileId(id) && !profileIdMap.has(id)) {
        unresolvedProfileIds.add(id);
      }
    }
    if (!isRecord(target.store) || !isRecord(target.store.profiles)) {
      continue;
    }
    for (const [profileId, profile] of Object.entries(target.store.profiles)) {
      const provider =
        isRecord(profile) && typeof profile.provider === "string"
          ? profile.provider.trim().toLowerCase()
          : undefined;
      if (
        !profileIdMap.has(profileId) &&
        (isLegacyAuthProfileId(profileId) ||
          (provider !== undefined && canonicalLegacyAuthProvider(provider) !== provider))
      ) {
        unresolvedProfileIds.add(profileId);
      }
    }
  }
  for (const profileId of unresolvedProfileIds) {
    reportWarning(
      `Kept auth profile ${profileId} unchanged because its provider realm or identity is unresolved.`,
      "identity-unresolved",
      "Compare this profile and its configured provider realm with openclaw models status. Correct the provider/account selection before retrying openclaw doctor --fix; do not overwrite another account to force migration.",
      profileId,
    );
  }
  for (const target of planned) {
    const occupied = collectAuthOwnerProfileIds(target.store, target.state);
    for (const [from, to] of profileIdMap) {
      if (
        from !== to &&
        occupied.has(to) &&
        (occupied.has(from) || recovery.recovered.get(from) !== to)
      ) {
        profileIdMap.delete(from);
        reportWarning(
          `Deferred stale auth profile alias ${from}; the target is occupied.`,
          "alias-target-occupied",
          "Compare the source and target accounts with openclaw models status; preserve both credential profiles and choose the intended account in auth.profiles/auth.order before rerunning openclaw doctor --fix.",
          from,
        );
      }
    }
  }
  for (const from of profileIdMap.keys()) {
    if (recovery.blocked.has(from)) {
      profileIdMap.delete(from);
      reportWarning(
        `Kept auth profile ${from} unchanged because its recorded account changed; reconcile the migration before retrying.`,
        "recorded-account-changed",
        "Compare the retained migration archive with the current account shown by openclaw models status. Preserve both accounts and recovery data; reconcile the intended account and its config references before rerunning openclaw doctor --fix.",
        from,
        "historical",
      );
    }
  }
  const migrated = planned.map((target) => {
    const migratedStore = structuredClone(target.store);
    const migratedState = structuredClone(target.state);
    if (target.canRenameAliases) {
      canonicalizeLegacyAuthStore(migratedStore, migratedState, migrationMap);
    }
    const canonicalizedSecretRefs = normalizeLegacyAuthProfileFields(migratedStore);
    return Object.assign(target, { migratedStore, migratedState, canonicalizedSecretRefs });
  });
  const changed = migrated.filter(
    (target) =>
      !isDeepStrictEqual(target.store, target.migratedStore) ||
      !isDeepStrictEqual(target.state, target.migratedState),
  );
  if (changed.length === 0 && migrationMap.size === 0) {
    return { changes: [], warnings, findings, profileIdMap };
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const assertTargetCurrent = (
    target: (typeof migrated)[number],
    database?: AuthProfileDatabase,
  ) => {
    maintenance?.assertOwnerCurrent();
    assertExistingDatabaseIdentity(
      target.databasePath,
      target.identity.key,
      target.identity.birthtime,
    );
    if (database) {
      const native =
        "agentId" in database ? readOpenClawAgentDatabaseIdentity(database) : undefined;
      const identity = native
        ? { key: `file:${native.identity}`, birthtime: native.birthtime }
        : requireOpenClawStateDatabaseIdentity(database);
      if (identity.key !== target.identity.key) {
        throw new Error("Auth profile database generation changed after backup; retry Doctor.");
      }
      assertExistingDatabaseIdentity(database.path, identity.key, identity.birthtime);
    }
  };
  const changes: string[] = [];
  const backupId = randomUUID();
  for (const target of changed) {
    assertTargetCurrent(target);
    const kind =
      target.agentDir === undefined && resolveSharedAuthStoreOwnership(env).location === "state-db"
        ? "shared-state"
        : "agent";
    const backup = await createVerifiedDatabaseMigrationBackup({
      sourcePath: target.databasePath,
      targetPath: `${target.databasePath}.auth-profile-migration-${backupId}.bak`,
      config: params.cfg,
      assertCurrent: () => assertTargetCurrent(target),
      validate: (database) => {
        for (const field of ["store", "state"] as const) {
          if (field === "state" && target.unreadableStateJson !== undefined) {
            if (
              readAuthProfileJsonCellText(database, "state", kind) !== target.unreadableStateJson
            ) {
              throw new Error(
                "Auth profile backup differs from the planned rotation-state source; retry Doctor.",
              );
            }
            continue;
          }
          const row = inspectAuthProfileJsonCell(database, field, kind);
          if (
            row.status === "unreadable" ||
            !isDeepStrictEqual(row.status === "readable" ? row.raw : null, target[field])
          ) {
            throw new Error("Auth profile backup differs from the planned source; retry Doctor.");
          }
        }
      },
    });
    assertTargetCurrent(target);
    changes.push(`Saved auth profile migration backup: ${shortenHomePath(backup.path)}.`);
  }
  const assertSourceCurrent = (
    target: (typeof migrated)[number],
    database: AuthProfileDatabase,
  ) => {
    assertTargetCurrent(target, database);
    if (
      target.unreadableStateJson !== undefined &&
      readAuthProfileJsonCellText(
        database.db,
        "state",
        "agentId" in database ? "agent" : "shared-state",
      ) !== target.unreadableStateJson
    ) {
      throw new Error("Auth profile rotation-state source changed during migration; retry Doctor.");
    }
    if (
      !isDeepStrictEqual(
        readPersistedAuthProfileStoreRaw(target.agentDir, database),
        target.store,
      ) ||
      !isDeepStrictEqual(readPersistedAuthProfileStateRaw(target.agentDir, database), target.state)
    ) {
      throw new Error("auth profile store or rotation state changed during alias migration");
    }
  };
  // Receipt preimages are checked under their owners before being recorded.
  // Keep the receipt durable before independently committed database rewrites.
  for (const target of migrated) {
    runAuthProfileWriteTransaction(
      target.agentDir,
      (database) => assertSourceCurrent(target, database),
      { env },
    );
  }
  maintenance?.assertOwnerCurrent();
  const receiptSha256 = recordAuthAliasMigration({
    profileIdMap: migrationMap,
    stores: migrated,
    env,
    normalizeCredentialFields: true,
  });
  const locked: Array<{ database: AuthProfileDatabase; target: (typeof migrated)[number] }> = [];
  const migrate = (index: number, sharedDatabase?: OpenClawStateDatabase): void => {
    const nextTarget = migrated[index];
    if (nextTarget) {
      runAuthProfileWriteTransaction(
        nextTarget.agentDir,
        (database) => {
          assertSourceCurrent(nextTarget, database);
          locked.push({ database, target: nextTarget });
          migrate(index + 1, sharedDatabase);
        },
        { env },
      );
      return;
    }
    maintenance?.assertOwnerCurrent();
    // Every participating owner is locked and revalidated before the first write.
    const renamedLinks = renameUserProfileAuthLinks(migrationMap, {
      env,
      database: sharedDatabase,
    });
    if (renamedLinks > 0) {
      changes.push(
        `Updated renamed auth profiles in ${renamedLinks} personal account selection record(s).`,
      );
    }
    for (const { database, target } of locked) {
      const store = target.migratedStore;
      const state = target.migratedState;
      const storeChanged = !isDeepStrictEqual(store, target.store);
      const stateChanged = !isDeepStrictEqual(state, target.state);
      if (storeChanged) {
        writePersistedAuthProfileStoreRaw(store, target.agentDir, database);
        if (target.canonicalizedSecretRefs > 0) {
          changes.push(
            `Canonicalized ${target.canonicalizedSecretRefs} auth SecretRef(s) in ${shortenHomePath(target.databasePath)} to source/provider/id; unsupported fields are preserved in the verified migration backup.`,
          );
        }
      }
      if (stateChanged) {
        writePersistedAuthProfileStateRaw(state, target.agentDir, database);
      }
      if (storeChanged || stateChanged) {
        changes.push(
          `Migrated stored auth profile aliases in ${shortenHomePath(target.databasePath)}.`,
        );
      }
    }
  };
  runWithAuthAliasMigrationReceipt(receiptSha256, env, (database) => migrate(0, database));
  if (changes.length > 0) {
    clearRuntimeAuthProfileStoreSnapshots();
  }
  return { changes, warnings, findings, profileIdMap };
}

function recoverArchivedAuthProfileMappings(params: {
  candidates: readonly AuthProfileRepairCandidate[];
  env: NodeJS.ProcessEnv;
}): Map<string, AuthAliasArchiveMapping> {
  const recovered = new Map<string, AuthAliasArchiveMapping>();
  const ambiguous = new Set<string>();
  const agentDirs = [
    resolveSharedMainAuthAgentDir(params.env),
    ...params.candidates.flatMap((candidate) => (candidate.agentDir ? [candidate.agentDir] : [])),
  ];
  const archives = listLegacyAuthProfileArchives({ agentDirs, env: params.env }).filter(
    (archive) => archive.kind === "auth-profiles" || archive.kind === "legacy-auth",
  );
  for (const candidate of params.candidates) {
    const canonicalProfiles = coerceLegacyAuthProfileStore(
      candidate.agentDir
        ? readPersistedAuthProfileStoreRaw(candidate.agentDir)
        : readPersistedSharedAuthProfileStoreRaw(params.env),
    )?.profiles;
    if (!canonicalProfiles) {
      continue;
    }
    const sourcePaths = [
      candidate.authPath,
      resolveLegacyAuthStorePath(path.dirname(candidate.authPath)),
    ];
    for (const archive of archives) {
      const sourcePath = sourcePaths.find((source) =>
        archive.path.startsWith(`${source}.migrated-`),
      );
      if (!sourcePath) {
        continue;
      }
      try {
        const sourceBytes = fs.readFileSync(archive.path);
        const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
        const sourceKey = `auth-profile-v2:${createHash("sha256")
          .update(`${path.resolve(sourcePath)}\0${sourceSha256}`)
          .digest("hex")}`;
        const receipt = readLegacyMigrationReceipt(sourceKey, params.env);
        if (!receipt?.removedSource || receipt.sourceSha256 !== sourceSha256) {
          continue;
        }
        const report = JSON.parse(receipt.reportJson) as unknown;
        const sharedStateTarget =
          candidate.agentDir === undefined &&
          resolveSharedAuthStoreOwnership(params.env).location === "state-db";
        if (
          !isRecord(report) ||
          report.format !== "auth-profile-json-to-sqlite-v2" ||
          report.completionStatus !== "completed" ||
          report.targetTable !==
            (sharedStateTarget ? "auth_profile_stores" : "auth_profile_store") ||
          typeof report.archivePath !== "string" ||
          path.resolve(report.archivePath) !== path.resolve(archive.path) ||
          typeof report.targetDatabasePath !== "string" ||
          path.resolve(report.targetDatabasePath) !==
            path.resolve(resolveMigrationTargetDatabasePath(candidate.agentDir, params.env)) ||
          !isRecord(report.expectedProfileSha256)
        ) {
          continue;
        }
        const archivedStore = parseAuthProfileMigrationSource({ sourceBytes, sourcePath });
        const sourceStore =
          coerceLegacyAuthProfileStore(archivedStore) ??
          coerceLegacyFlatAuthProfileStore(archivedStore);
        if (!sourceStore) {
          continue;
        }
        for (const [legacyProfileId, rawCredential] of Object.entries(sourceStore.profiles)) {
          const target = legacyAuthProfileTarget(legacyProfileId);
          if (!target) {
            continue;
          }
          const archivedCredential = parseLegacyCredentialEntry(
            { ...rawCredential, provider: target.provider },
            target.provider,
          );
          if (!archivedCredential) {
            continue;
          }
          const matches = Object.entries(report.expectedProfileSha256).flatMap(
            ([canonicalProfileId, expectedSha256]) => {
              const credential = canonicalProfiles[canonicalProfileId];
              return typeof expectedSha256 === "string" &&
                credential?.provider === target.provider &&
                (archivedCredential.type === "oauth" && credential.type === "oauth"
                  ? hasMatchingOAuthIdentity(archivedCredential, credential) ||
                    areOAuthCredentialsEquivalent(archivedCredential, credential)
                  : isDeepStrictEqual(archivedCredential, credential))
                ? [canonicalProfileId]
                : [];
            },
          );
          if (matches.length !== 1) {
            continue;
          }
          const canonicalProfileId = matches[0]!;
          const previous = recovered.get(legacyProfileId);
          if (previous && previous.profileId !== canonicalProfileId) {
            recovered.delete(legacyProfileId);
            ambiguous.add(legacyProfileId);
          } else if (!ambiguous.has(legacyProfileId)) {
            recovered.set(legacyProfileId, {
              profileId: canonicalProfileId,
              origins: [
                ...(previous?.origins ?? []),
                {
                  sourcePath: path.resolve(sourcePath),
                  sourceSha256,
                  databasePath: resolveMigrationTargetDatabasePath(candidate.agentDir, params.env),
                },
              ],
            });
          }
        }
      } catch {
        // Archives without a matching verified receipt or parseable identity
        // cannot prove account ownership; leave their session pins untouched.
      }
    }
  }
  return recovered;
}

/** Collects collision-safe retired profile ids across config, SQLite, and legacy agent stores. */
export function collectOpenAICodexAuthProfileStoreIdMap(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  recoveredProfileIds?: Set<string>;
}): Map<string, string> {
  const env = params.env ?? process.env;
  const occupied = new Set<string>(["openai:codex-cli"]);
  const eligible = new Set<string>();
  const blocked = new Set<string>();
  const profileIdMap = new Map<string, string>();
  const sqliteStores: AuthAliasStoreSnapshot[] = [];
  let incompleteCensus = false;
  const candidates = listAuthProfileRepairCandidates(params.cfg, env, () => {
    incompleteCensus = true;
  });
  if (incompleteCensus) {
    return profileIdMap;
  }
  const configuredProviders = new Set(
    Object.keys(params.cfg.models?.providers ?? {}).map((provider) =>
      provider.trim().toLowerCase(),
    ),
  );
  const collectReferences = (raw: unknown): void => {
    for (const id of collectRawAuthRotationProfileIds(raw)) {
      occupied.add(id);
    }
  };
  const collectProfiles = (raw: unknown): boolean => {
    if (!isRecord(raw) || !isRecord(raw.profiles)) {
      return false;
    }
    for (const [profileId, value] of Object.entries(raw.profiles)) {
      occupied.add(profileId);
      const target = legacyAuthProfileTarget(profileId);
      const provider =
        isRecord(value) && typeof value.provider === "string"
          ? value.provider.trim().toLowerCase()
          : undefined;
      const canonical = provider === undefined ? undefined : canonicalLegacyAuthProvider(provider);
      if (!target && canonical === provider) {
        continue;
      }
      const legacyPrefix = profileId.slice(0, profileId.indexOf(":")).trim().toLowerCase();
      const changesRealm = provider !== canonical;
      const explicitRealm =
        isRecord(value) &&
        changesRealm &&
        ["enterpriseUrl", "tokenEndpoint", "deviceAuthorizationEndpoint", "issuer"].some(
          (field) => value[field] !== undefined,
        );
      if (
        provider === undefined ||
        canonical === undefined ||
        (target !== null && target.provider !== canonical) ||
        (target !== null && configuredProviders.has(legacyPrefix)) ||
        (changesRealm && configuredProviders.has(provider)) ||
        explicitRealm
      ) {
        blocked.add(profileId);
      } else {
        eligible.add(profileId);
      }
    }
    collectReferences(raw);
    return true;
  };
  collectProfiles({ profiles: params.cfg.auth?.profiles ?? {}, order: params.cfg.auth?.order });
  // Legacy JSON has one shared-main import owner; relocated SQLite can also contain local main state.
  for (const [databasePath, agentDir] of listAuthProfileMigrationTargets(candidates, env)) {
    if (agentDir && inspectAuthDatabaseFiles(agentDir) === "unreadable") {
      return profileIdMap;
    }
    const inspection = agentDir
      ? inspectPersistedAuthProfileStoreRaw(agentDir)
      : inspectPersistedSharedAuthProfileStoreRaw(env);
    const state = agentDir
      ? inspectPersistedAuthProfileStateRaw(agentDir)
      : inspectPersistedSharedAuthProfileStateRaw(env);
    if (inspection.status === "unreadable" || state.status === "unreadable") {
      return profileIdMap;
    }
    sqliteStores.push({
      databasePath,
      store: inspection.status === "readable" ? inspection.raw : null,
    });
    if (inspection.status === "readable") {
      if (!collectProfiles(inspection.raw)) {
        return profileIdMap;
      }
      if (
        !isReadableAuthAliasStore(inspection.raw) &&
        isRecord(inspection.raw) &&
        isRecord(inspection.raw.profiles)
      ) {
        Object.keys(inspection.raw.profiles).forEach((id) => blocked.add(id));
      }
    }
    if (state.status === "readable") {
      if (!isRecord(state.raw)) {
        return profileIdMap;
      }
      collectReferences(state.raw);
      if (
        !isReadableAuthAliasState(state.raw) &&
        inspection.status === "readable" &&
        isRecord(inspection.raw) &&
        isRecord(inspection.raw.profiles)
      ) {
        Object.keys(inspection.raw.profiles).forEach((id) => blocked.add(id));
      }
    }
  }
  for (const candidate of candidates) {
    if (
      fs.existsSync(candidate.authPath) &&
      !collectProfiles(loadJsonFileThroughSymlink(candidate.authPath))
    ) {
      return profileIdMap;
    }
    const legacyPath = resolveLegacyAuthStorePath(path.dirname(candidate.authPath));
    if (fs.existsSync(legacyPath)) {
      const legacy = coerceLegacyAuthStore(loadJsonFileThroughSymlink(legacyPath));
      if (!legacy) {
        return profileIdMap;
      }
      const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
      applyLegacyAuthStore(store, legacy);
      collectProfiles(store);
    }
    const statePath = resolveAuthStatePath(path.dirname(candidate.authPath));
    if (fs.existsSync(statePath)) {
      const raw = loadJsonFileThroughSymlink(statePath);
      if (!isRecord(raw)) {
        return profileIdMap;
      }
      collectReferences(raw);
    }
  }
  const archivedMappings = recoverArchivedAuthProfileMappings({ candidates, env });
  const recovery = recoverAuthAliasMigration({ stores: sqliteStores, env, archivedMappings });
  for (const profileId of recovery.blocked) {
    blocked.add(profileId);
  }
  for (const [from, to] of recovery.recovered) {
    if (!blocked.has(from)) {
      profileIdMap.set(from, to);
      if (archivedMappings.get(from)?.profileId === to) {
        params.recoveredProfileIds?.add(from);
      }
    }
  }
  for (const profileId of [...eligible].toSorted((left, right) => left.localeCompare(right))) {
    if (!blocked.has(profileId) && !profileIdMap.has(profileId)) {
      profileIdMap.set(
        profileId,
        isLegacyAuthProfileId(profileId)
          ? allocateLegacyAuthProfileId(profileId, occupied)
          : profileId,
      );
    }
  }
  for (const [legacyProfileId, archive] of archivedMappings) {
    const destinationIsVerified = sqliteStores.every(
      ({ databasePath, store }) =>
        !isRecord(store) ||
        !isRecord(store.profiles) ||
        store.profiles[archive.profileId] === undefined ||
        archive.origins.some((origin) => origin.databasePath === databasePath),
    );
    if (
      destinationIsVerified &&
      !profileIdMap.has(legacyProfileId) &&
      !blocked.has(legacyProfileId)
    ) {
      profileIdMap.set(legacyProfileId, archive.profileId);
      params.recoveredProfileIds?.add(legacyProfileId);
    }
  }
  return profileIdMap;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
