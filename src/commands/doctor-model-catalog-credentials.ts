/** Doctor-owned migration of plaintext model-catalog credentials into agent SQLite. */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { resolveSharedAuthStorePath } from "../agents/auth-profiles/path-resolve.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
  mergeAuthProfileStores,
} from "../agents/auth-profiles/persisted.js";
import { removeRuntimeExternalProfileReferences } from "../agents/auth-profiles/runtime-external-profile-references.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { resolveProviderConfigSecretInput } from "../agents/model-auth-provider-config.js";
import { parseModelCatalogJson } from "../agents/model-catalog-json.js";
import {
  isGeneratedPluginModelCatalog,
  loadPersistedPluginModelCatalogsReadOnly,
} from "../agents/plugin-model-catalog.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseCandidatePaths } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { decodeUtf8Input } from "../infra/utf8-input.js";
import type { RuntimeEnv } from "../runtime.js";
import { listAgentModelsJsonPaths } from "../secrets/storage-scan.js";
import { shellEscape } from "../shared/shell-quote.js";
import { createRetainedAgentDatabaseMatcher } from "../state/agent-deletion-discovery.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { createAuthMigrationWarningRecorder } from "./doctor/auth-migration-findings.js";

type PlaintextCredential = { key: string; provider: string; catalog: boolean };

function emptyStore(): AuthProfileStore {
  return { version: AUTH_STORE_VERSION, profiles: {} };
}

function credentialMatches(
  credential: AuthProfileCredential | undefined,
  { provider, key }: PlaintextCredential,
): boolean {
  if (normalizeProviderId(credential?.provider ?? "") !== normalizeProviderId(provider)) {
    return false;
  }
  return (
    (credential?.type === "api_key" && credential.key === key) ||
    (credential?.type === "token" && credential.token === key)
  );
}

function hasProviderSecretRef(store: AuthProfileStore, provider: string): boolean {
  return Object.values(store.profiles).some(
    (credential) =>
      normalizeProviderId(credential.provider) === normalizeProviderId(provider) &&
      ((credential.type === "api_key" && credential.keyRef !== undefined) ||
        (credential.type === "token" && credential.tokenRef !== undefined)),
  );
}

function findProviderSecretRefProfiles(store: AuthProfileStore, cfg: OpenClawConfig) {
  return Object.entries(store.profiles).filter(([, credential]) => {
    if (credential.type !== "api_key" || !credential.key) {
      return false;
    }
    const ref = resolveProviderConfigSecretInput(cfg, credential.provider).ref;
    const id = ref?.id.trim();
    // Only this provider's declared env markers are non-secret; uppercase keys can be real.
    return ref?.source === "env" && [id, `$${id}`, `\${${id}}`].includes(credential.key.trim());
  });
}

function collectCredentials(
  providers: unknown,
  store: AuthProfileStore,
  blockedStores: readonly AuthProfileStore[] = [],
  cfg?: OpenClawConfig,
  catalog = false,
): PlaintextCredential[] {
  if (!isRecord(providers)) {
    return [];
  }
  return Object.entries(providers).flatMap(([provider, entry]) => {
    if (!isRecord(entry) || typeof entry.apiKey !== "string") {
      return [];
    }
    const key = entry.apiKey;
    const credential = { provider, key, catalog };
    if (
      !key.trim() ||
      // An authored SecretRef owns this provider; generated catalog copies are never fallbacks.
      (cfg && resolveProviderConfigSecretInput(cfg, provider).ref) ||
      (catalog && hasProviderSecretRef(store, provider)) ||
      isNonSecretApiKeyMarker(key) ||
      store.profiles[key] !== undefined ||
      findMatchingProfileId(store, credential, blockedStores) !== undefined
    ) {
      return [];
    }
    return [credential];
  });
}

function uniqueCredentials(credentials: readonly PlaintextCredential[]): PlaintextCredential[] {
  return [
    ...new Map(
      credentials.map((credential) => [
        `${normalizeProviderId(credential.provider)}\0${credential.key}`,
        credential,
      ]),
    ).values(),
  ];
}

function findMatchingProfileId(
  store: AuthProfileStore,
  credential: PlaintextCredential,
  blockedStores: readonly AuthProfileStore[],
): string | undefined {
  return Object.entries(store.profiles).find(
    ([profileId, stored]) =>
      credentialMatches(stored, credential) &&
      blockedStores.every(
        (blocked) =>
          blocked.profiles[profileId] === undefined ||
          credentialMatches(blocked.profiles[profileId], credential),
      ),
  )?.[0];
}

function allocateProfileId(
  store: AuthProfileStore,
  credential: PlaintextCredential,
  blockedStores: readonly AuthProfileStore[],
): string {
  const provider = normalizeProviderId(credential.provider);
  for (let suffix = 1; ; suffix += 1) {
    const profileId =
      suffix === 1
        ? `${provider}:default`
        : `${provider}:models-json${suffix === 2 ? "" : `-${suffix}`}`;
    if (
      (!store.profiles[profileId] || credentialMatches(store.profiles[profileId], credential)) &&
      blockedStores.every(
        (blocked) =>
          !blocked.profiles[profileId] ||
          credentialMatches(blocked.profiles[profileId], credential),
      )
    ) {
      return profileId;
    }
  }
}

async function persistCredentials(params: {
  agentDir?: string;
  blockedStores?: readonly AuthProfileStore[];
  credentials: readonly PlaintextCredential[];
  env: NodeJS.ProcessEnv;
  invalidProfiles: ReadonlyArray<[string, AuthProfileCredential]>;
  skipCatalogCredential: (credential: PlaintextCredential, store: AuthProfileStore) => boolean;
}): Promise<{ migrated: number; removed: number }> {
  const credentials = uniqueCredentials(params.credentials);
  const { invalidProfiles } = params;
  if (credentials.length === 0 && invalidProfiles.length === 0) {
    return { migrated: 0, removed: 0 };
  }
  const blockedStores = params.blockedStores ?? [];
  const profileIds = new Map<string, PlaintextCredential>();
  let added = 0;
  let inheritedStore: AuthProfileStore | null | undefined;
  let removedProfiles: [string, AuthProfileCredential][] = [];
  const updated = await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    stateDir: resolveStateDir(params.env),
    saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    updater: (localStore, _owner, sharedStore) => {
      // Confirmation can pause while another writer replaces a marker. Only remove
      // the exact credential observed before prompting, including its references.
      removedProfiles = invalidProfiles.filter(([profileId, credential]) =>
        isDeepStrictEqual(localStore.profiles[profileId], credential),
      );
      if (removedProfiles.length > 0) {
        Object.assign(
          localStore,
          removeRuntimeExternalProfileReferences({
            store: localStore,
            profileIds: new Set(removedProfiles.map(([profileId]) => profileId)),
          }),
        );
      }
      inheritedStore = sharedStore;
      const effectiveStore = sharedStore
        ? mergeAuthProfileStores(sharedStore, localStore)
        : localStore;
      for (const credential of credentials) {
        if (credential.catalog && hasProviderSecretRef(effectiveStore, credential.provider)) {
          continue;
        }
        if (
          credential.catalog &&
          (sharedStore || !params.agentDir) &&
          params.skipCatalogCredential(credential, sharedStore ?? localStore)
        ) {
          continue;
        }
        const profileId =
          findMatchingProfileId(effectiveStore, credential, blockedStores) ??
          allocateProfileId(effectiveStore, credential, blockedStores);
        profileIds.set(profileId, credential);
        if (credentialMatches(effectiveStore.profiles[profileId], credential)) {
          continue;
        }
        localStore.profiles[profileId] = {
          type: "api_key",
          provider: normalizeProviderId(credential.provider),
          key: credential.key,
        };
        effectiveStore.profiles[profileId] = localStore.profiles[profileId];
        added += 1;
      }
      return added > 0 || removedProfiles.length > 0;
    },
  });
  if (!updated) {
    throw new Error("auth profile store could not be updated");
  }
  const persisted = params.agentDir
    ? loadPersistedAuthProfileStore(params.agentDir)
    : loadPersistedSharedAuthProfileStore(params.env);
  const effectivePersisted = inheritedStore
    ? mergeAuthProfileStores(inheritedStore, persisted ?? emptyStore())
    : persisted;
  for (const [profileId, credential] of removedProfiles) {
    if (isDeepStrictEqual(persisted?.profiles[profileId], credential)) {
      throw new Error(`credential cleanup verification failed for profile "${profileId}"`);
    }
  }
  for (const [profileId, credential] of profileIds) {
    if (!credentialMatches(effectivePersisted?.profiles[profileId], credential)) {
      throw new Error(`credential verification failed for provider "${credential.provider}"`);
    }
  }
  return { migrated: added, removed: removedProfiles.length };
}

function collectAgentCatalogs(agentDir: string, warnings: string[], findings: HealthFinding[]) {
  const reportWarning = createAuthMigrationWarningRecorder(warnings, findings);
  const localStore = loadPersistedAuthProfileStore(agentDir) ?? emptyStore();
  const providers: Record<string, unknown>[] = [];
  const rootPath = path.join(agentDir, "models.json");
  try {
    const root = parseModelCatalogJson(
      decodeUtf8Input(fs.readFileSync(rootPath), `Model catalog ${rootPath}`),
    );
    if (isRecord(root) && isRecord(root.providers)) {
      providers.push(root.providers);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      reportWarning(
        `Could not read model catalog ${shortenHomePath(rootPath)}: ${error instanceof Error ? error.message : String(error)}`,
        "catalog-read-failed",
        "Keep the model catalog. Correct the reported file access or JSON error, then rerun openclaw doctor --fix to verify credential migration.",
        rootPath,
      );
    }
  }
  try {
    for (const catalog of loadPersistedPluginModelCatalogsReadOnly(agentDir)) {
      try {
        const parsed = JSON.parse(catalog.contents) as unknown;
        if (
          isGeneratedPluginModelCatalog(parsed) &&
          isRecord(parsed) &&
          isRecord(parsed.providers)
        ) {
          providers.push(parsed.providers);
        }
      } catch {
        reportWarning(
          `Could not parse generated model catalog for plugin ${catalog.pluginId}.`,
          "catalog-parse-failed",
          "Keep the agent database and recovery copy. Check the plugin catalog format with its maintainer before retrying openclaw doctor --fix; use openclaw models status to identify affected providers.",
          catalog.pluginId,
        );
      }
    }
  } catch (error) {
    reportWarning(
      `Could not read generated model catalogs for ${shortenHomePath(agentDir)}: ${error instanceof Error ? error.message : String(error)}`,
      "catalog-owner-read-failed",
      "Keep the agent database and recovery copy. Correct the reported database access error before rerunning openclaw doctor --fix; do not delete the credential database.",
      agentDir,
    );
  }
  return { agentDir, localStore, providers };
}

/** Copies and verifies catalog credentials before the runtime retires plaintext catalog auth. */
export async function maybeMigrateModelCatalogCredentials(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  prompter: DoctorPrompter;
  runtime: RuntimeEnv;
  reportFindings?: (findings: readonly HealthFinding[], warnings?: readonly string[]) => void;
}): Promise<{
  detected: number;
  migrated: number;
  removed: number;
  warnings: string[];
  findings: readonly HealthFinding[];
}> {
  const warnings: string[] = [];
  const findings: HealthFinding[] = [];
  const reportWarning = createAuthMigrationWarningRecorder(
    warnings,
    findings,
    params.reportFindings,
  );
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const mainAgentDir = resolveSharedMainAuthAgentDir(env);
  const isRetained = createRetainedAgentDatabaseMatcher(
    env,
    () =>
      listAgentIds(params.cfg).map((agentId) => ({
        agentId,
        path: resolveAgentDir(params.cfg, agentId, env),
      })),
    {
      kind: "agent-directory",
      readDatabasePaths: () => resolveConfiguredAgentDatabaseCandidatePaths(params.cfg, { env }),
    },
  );
  const agentDirs = listAgentModelsJsonPaths(params.cfg, stateDir, env)
    .map((modelsPath) => path.dirname(modelsPath))
    .filter((agentDir) => !isRetained(agentDir));
  const mainStore = loadPersistedSharedAuthProfileStore(env) ?? emptyStore();
  const catalogs = agentDirs.map((agentDir) => collectAgentCatalogs(agentDir, warnings, findings));
  const childStores = catalogs
    .filter((catalog) => catalog.agentDir !== mainAgentDir)
    .map((catalog) => catalog.localStore);
  const configCredentials = collectCredentials(
    params.cfg.models?.providers,
    mainStore,
    childStores,
    params.cfg,
  );
  const sharedProfileId = (store: AuthProfileStore, provider: string) =>
    resolveAuthProfileOrder({ cfg: params.cfg, store, provider, readinessMode: "read-only" }).find(
      (id) => store.profiles[id] !== undefined,
    );
  const catalogImports = catalogs.map(({ agentDir, localStore, providers }) => {
    const effectiveStore = mergeAuthProfileStores(mainStore, localStore);
    if (path.join(agentDir, "openclaw-agent.sqlite") !== resolveSharedAuthStorePath(env)) {
      for (const [profileId, credential] of Object.entries(localStore.profiles)) {
        const provider = normalizeProviderId(credential.provider);
        const inheritedId = sharedProfileId(mainStore, provider);
        if (
          !profileId.startsWith(`${provider}:models-json`) ||
          !/^models-json(?:-\d+)?$/.test(profileId.slice(provider.length + 1)) ||
          !inheritedId ||
          isDeepStrictEqual(credential, mainStore.profiles[inheritedId]) ||
          sharedProfileId(effectiveStore, provider) !== profileId
        ) {
          continue;
        }
        const agentId =
          listAgentIds(params.cfg).find(
            (id) => resolveAgentDir(params.cfg, id, env) === agentDir,
          ) ?? path.basename(path.dirname(agentDir));
        const command = `openclaw models auth logout ${shellEscape(profileId)} --agent ${shellEscape(agentId)} --yes`;
        reportWarning(
          `Agent-local auth profile "${profileId}" for provider "${provider}" takes precedence over shared profile "${inheritedId}". Its migration origin is unrecorded; credentials were left untouched. After confirming the shared account is intended, remove the local profile with: ${command}`,
          "catalog-profile-shadows-shared",
          `Confirm the shared account is intended, then run ${command}.`,
          agentDir,
        );
      }
    }
    const skippedProviders = new Set<string>();
    const skipCatalogCredential = (credential: PlaintextCredential, store: AuthProfileStore) => {
      const inheritedId = sharedProfileId(store, credential.provider);
      if (!inheritedId) {
        return false;
      }
      if (!skippedProviders.has(credential.provider)) {
        skippedProviders.add(credential.provider);
        reportWarning(
          `Skipped models.json credential for provider "${credential.provider}" in ${shortenHomePath(agentDir)}: shared auth profile "${inheritedId}" already provides effective credentials. The catalog source was left untouched.`,
          "catalog-credential-shared-auth",
          "Keep the shared auth profile and original catalog. Check openclaw models status for the intended account before changing credentials.",
          agentDir,
          "recommended",
        );
      }
      return true;
    };
    return {
      agentDir,
      credentials: uniqueCredentials(
        providers.flatMap((entries) =>
          collectCredentials(entries, effectiveStore, [], params.cfg, true),
        ),
      ).filter((credential) => !skipCatalogCredential(credential, mainStore)),
      skipCatalogCredential,
      invalidProfiles:
        agentDir === mainAgentDir ? [] : findProviderSecretRefProfiles(localStore, params.cfg),
    };
  });
  const invalidMainProfiles = findProviderSecretRefProfiles(mainStore, params.cfg);
  const detected =
    configCredentials.length +
    catalogImports.reduce((sum, entry) => sum + entry.credentials.length, 0);
  const removable =
    invalidMainProfiles.length +
    catalogImports.reduce((sum, entry) => sum + entry.invalidProfiles.length, 0);

  params.reportFindings?.(findings, warnings);
  for (const warning of warnings) {
    params.runtime.error(warning);
  }
  if (detected === 0 && removable === 0) {
    return { detected, migrated: 0, removed: 0, warnings, findings };
  }

  if (detected > 0) {
    note(
      `Found ${detected} plaintext model credential${detected === 1 ? "" : "s"}. Run openclaw doctor --fix to copy and verify them in agent SQLite before plaintext catalog authentication is retired.`,
      "Model catalog credentials",
    );
  }
  if (removable > 0) {
    note(
      `Found ${removable} stored unresolved model credential marker${removable === 1 ? "" : "s"}. Run openclaw doctor --fix to remove them from agent SQLite.`,
      "Model catalog credentials",
    );
  }
  const shouldRepair =
    params.prompter.shouldRepair ||
    (await params.prompter.confirmAutoFix({
      message: "Repair model credentials in agent SQLite now?",
      initialValue: true,
    }));
  if (!shouldRepair) {
    const pending: HealthFinding[] = [
      {
        checkId: "core/doctor/auth-migration/model-credential-repair-pending",
        severity: "warning",
        category: "recommended",
        message: `${detected} plaintext model credential${detected === 1 ? "" : "s"} and ${removable} unresolved marker${removable === 1 ? "" : "s"} remain pending repair.`,
        fixHint:
          "Run openclaw doctor --fix to copy and verify plaintext credentials in agent SQLite and remove unresolved markers. This prepares for catalog auth retirement; keep the original catalog values until verification completes.",
        docsUrl: "https://docs.openclaw.ai/cli/doctor/running#auth-migration-recovery",
      },
    ];
    findings.push(...pending);
    params.reportFindings?.(pending);
    return { detected, migrated: 0, removed: 0, warnings, findings };
  }

  function* migrationTargets() {
    yield {
      description: "configured model credentials",
      blockedStores: childStores,
      credentials: configCredentials,
      invalidProfiles: invalidMainProfiles,
      skipCatalogCredential: () => false,
    };
    for (const {
      agentDir,
      credentials,
      invalidProfiles,
      skipCatalogCredential,
    } of catalogImports) {
      yield {
        description: `model credentials for ${shortenHomePath(agentDir)}`,
        credentials,
        invalidProfiles,
        skipCatalogCredential,
        ...(agentDir === mainAgentDir ? {} : { agentDir }),
      };
    }
  }
  let migrated = 0;
  let removed = 0;
  for (const { description, ...target } of migrationTargets()) {
    try {
      const previousWarnings = warnings.length;
      const result = await persistCredentials({ ...target, env });
      for (const warning of warnings.slice(previousWarnings)) {
        params.runtime.error(warning);
      }
      migrated += result.migrated;
      removed += result.removed;
    } catch (error) {
      const warning = `Could not migrate ${description}: ${error instanceof Error ? error.message : String(error)}`;
      reportWarning(
        warning,
        "credential-import-failed",
        "Keep the original catalog values and recovery copy. Correct the reported credential-store error and rerun openclaw doctor --fix. Check openclaw models status for the intended accounts.",
        description,
      );
      params.runtime.error(warning);
    }
  }

  if (migrated > 0) {
    note(
      `Copied and verified ${migrated} model credential${migrated === 1 ? "" : "s"} in agent SQLite. Existing catalog values remain active until the runtime migration lands.`,
      "Doctor changes",
    );
  }
  if (removed > 0) {
    note(
      `Removed ${removed} unresolved model credential marker${removed === 1 ? "" : "s"} from agent SQLite.`,
      "Doctor changes",
    );
  }
  return { detected, migrated, removed, warnings, findings };
}
