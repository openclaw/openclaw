/** Doctor-owned migration of plaintext model-catalog credentials into agent SQLite. */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
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
import { stripPluginModelCatalogCredentials } from "../agents/plugin-model-catalog-repair.js";
import {
  isGeneratedPluginModelCatalog,
  loadPersistedPluginModelCatalogsReadOnly,
  repairPersistedPluginModelCatalogs,
  type PersistedPluginModelCatalog,
} from "../agents/plugin-model-catalog.js";
import { createConfigIO } from "../config/io.factory.js";
import { assertBaseSnapshotStillCurrent } from "../config/io.write-safety.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseCandidatePaths } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { createRetainedAgentDatabaseMatcher } from "../state/agent-deletion-discovery.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type PlaintextCredential = { key: string; provider: string };

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
    (credential?.type === "token" && credential.token === key) ||
    (credential?.type === "oauth" && credential.access === key)
  );
}

function matchesProviderEnvRefMarker(
  cfg: OpenClawConfig,
  provider: string,
  value: string,
): boolean {
  const ref = resolveProviderConfigSecretInput(cfg, provider).ref;
  if (ref?.source !== "env") {
    return false;
  }
  // Generated env markers are provider-scoped. Treating every uppercase value
  // as a marker would discard valid literal credentials.
  const id = ref.id.trim();
  const candidate = value.trim();
  return candidate === id || candidate === `$${id}` || candidate === `\${${id}}`;
}

function findProviderSecretRefProfiles(store: AuthProfileStore, cfg: OpenClawConfig) {
  return Object.entries(store.profiles).filter(
    ([, credential]) =>
      credential.type === "api_key" &&
      credential.key &&
      matchesProviderEnvRefMarker(cfg, credential.provider, credential.key),
  );
}

function collectCredentials(
  providers: unknown,
  store: AuthProfileStore,
  blockedStores: readonly AuthProfileStore[] = [],
  cfg?: OpenClawConfig,
): PlaintextCredential[] {
  if (!isRecord(providers)) {
    return [];
  }
  return Object.entries(providers).flatMap(([provider, entry]) => {
    if (!isRecord(entry) || typeof entry.apiKey !== "string") {
      return [];
    }
    const key = entry.apiKey;
    const credential = { provider, key };
    if (
      !key.trim() ||
      // An authored SecretRef owns this provider; generated catalog copies are never fallbacks.
      (cfg && resolveProviderConfigSecretInput(cfg, provider).ref) ||
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
  assertCurrent: () => void;
  invalidProfiles: ReadonlyArray<[string, AuthProfileCredential]>;
  stateDir: string;
}): Promise<{ migrated: number; removed: number }> {
  const credentials = uniqueCredentials(params.credentials);
  const { invalidProfiles } = params;
  if (credentials.length === 0 && invalidProfiles.length === 0) {
    return { migrated: 0, removed: 0 };
  }
  const blockedStores = params.blockedStores ?? [];
  const profileIds = new Map<string, PlaintextCredential>();
  let added = 0;
  let removedProfiles: [string, AuthProfileCredential][] = [];
  const updated = await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    stateDir: params.stateDir,
    saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
    assertCurrent: params.assertCurrent,
    updater: (localStore, _owner, sharedStore) => {
      // Confirmation can pause while another writer replaces a marker. Only remove
      // the exact credential observed for this attempt, including its references.
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
      const effectiveStore = sharedStore
        ? mergeAuthProfileStores(sharedStore, localStore)
        : localStore;
      for (const credential of credentials) {
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
    : loadPersistedSharedAuthProfileStore({
        ...process.env,
        OPENCLAW_STATE_DIR: params.stateDir,
      });
  const effectivePersisted = params.agentDir
    ? mergeAuthProfileStores(
        loadPersistedSharedAuthProfileStore({
          ...process.env,
          OPENCLAW_STATE_DIR: params.stateDir,
        }) ?? emptyStore(),
        persisted ?? emptyStore(),
      )
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

function readRootCatalog(rootPath: string): string | undefined {
  try {
    return fs.readFileSync(rootPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function collectAgentCatalogs(agentDir: string, warnings: string[]) {
  const localStore = loadPersistedAuthProfileStore(agentDir) ?? emptyStore();
  const providers: Record<string, unknown>[] = [];
  const rootPath = path.join(agentDir, "models.json");
  let rootContents: string | undefined;
  let rootProviders: Record<string, unknown> = {};
  try {
    rootContents = readRootCatalog(rootPath);
    const root = rootContents === undefined ? undefined : parseModelCatalogJson(rootContents);
    if (isRecord(root) && isRecord(root.providers)) {
      rootProviders = root.providers;
      providers.push(rootProviders);
    }
  } catch (error) {
    warnings.push(
      `Could not read model catalog ${shortenHomePath(rootPath)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let catalogs: PersistedPluginModelCatalog[] = [];
  const generated: Array<PersistedPluginModelCatalog & { providers: Record<string, unknown> }> = [];
  try {
    catalogs = loadPersistedPluginModelCatalogsReadOnly(agentDir);
    for (const catalog of catalogs) {
      try {
        const parsed = JSON.parse(catalog.contents) as unknown;
        if (isGeneratedPluginModelCatalog(parsed) && isRecord(parsed.providers)) {
          providers.push(parsed.providers);
          generated.push({ ...catalog, providers: parsed.providers });
        }
      } catch {
        warnings.push(`Could not parse generated model catalog for plugin ${catalog.pluginId}.`);
      }
    }
  } catch (error) {
    warnings.push(
      `Could not read generated model catalogs for ${shortenHomePath(agentDir)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const assertRootCurrent = () => {
    if (readRootCatalog(rootPath) !== rootContents) {
      throw new Error("authored model catalog changed; rerun openclaw doctor --fix");
    }
  };
  const assertCurrent = () => {
    assertRootCurrent();
    const current = loadPersistedPluginModelCatalogsReadOnly(agentDir);
    if (
      current.length !== catalogs.length ||
      catalogs.some(
        (catalog) =>
          !current.some(
            (entry) => entry.pluginId === catalog.pluginId && entry.contents === catalog.contents,
          ),
      )
    ) {
      throw new Error("generated model catalog changed; rerun openclaw doctor --fix");
    }
  };
  return {
    agentDir,
    localStore,
    providers,
    generated,
    rootProviders,
    assertRootCurrent,
    assertCurrent,
  };
}

function cleanupCredentials(
  catalog: ReturnType<typeof collectAgentCatalogs>,
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  warnings: string[],
) {
  const credentials = new Map<string, ReadonlyMap<string, ReadonlySet<string>>>();
  for (const generated of catalog.generated) {
    const byProvider = new Map<string, ReadonlySet<string>>();
    for (const [provider, entry] of Object.entries(generated.providers)) {
      if (!isRecord(entry)) {
        continue;
      }
      const allowed = new Set<string>();
      const unmatched: unknown[] = [];
      const authored = [cfg.models?.providers, catalog.rootProviders].flatMap((providers) =>
        Object.entries(providers ?? {}).flatMap(([id, value]) =>
          normalizeProviderId(id) === normalizeProviderId(provider) && isRecord(value)
            ? [value]
            : [],
        ),
      );
      for (const row of [
        entry,
        ...(Array.isArray(entry.models) ? entry.models.filter(isRecord) : []),
      ]) {
        const fields: Array<[string | undefined, unknown]> = [];
        if (row.apiKey !== undefined) {
          fields.push([undefined, row.apiKey]);
        }
        if (row.headers !== undefined) {
          if (isRecord(row.headers)) {
            fields.push(...Object.entries(row.headers));
          } else {
            fields.push(["headers", row.headers]);
          }
        }
        for (const [header, value] of fields) {
          const key =
            typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : value;
          const accounted =
            typeof key === "string" &&
            (!key.trim() ||
              isNonSecretApiKeyMarker(key) ||
              matchesProviderEnvRefMarker(cfg, provider, key) ||
              Object.values(store.profiles).some((credential) =>
                credentialMatches(credential, { provider, key }),
              ) ||
              normalizeProviderId(store.profiles[key]?.provider ?? "") ===
                normalizeProviderId(provider) ||
              (resolveProviderConfigSecretInput(cfg, provider).ref && key === entry.apiKey) ||
              authored.some((source) => {
                const sourceRow =
                  row === entry
                    ? source
                    : Array.isArray(source.models)
                      ? source.models.find((model) => isRecord(model) && model.id === row.id)
                      : undefined;
                const endpoint = row.baseUrl ?? entry.baseUrl;
                return (
                  isRecord(sourceRow) &&
                  typeof endpoint === "string" &&
                  (sourceRow.baseUrl ?? source.baseUrl) === endpoint &&
                  (header === undefined
                    ? sourceRow.apiKey === value
                    : isRecord(sourceRow.headers) && sourceRow.headers[header] === value)
                );
              }));
          if (accounted && typeof value === "string") {
            allowed.add(value);
          } else {
            unmatched.push(value);
          }
        }
      }
      // The cleanup owner selects values provider-wide. Do not let one authored
      // header authorize deletion of an unmatched copy on another model/endpoint.
      for (const value of allowed) {
        if (unmatched.some((other) => other === value || other === `Bearer ${value}`)) {
          allowed.delete(value);
        }
      }
      byProvider.set(provider, allowed);
      if (unmatched.length > 0) {
        warnings.push(
          `Retained unmatched model credentials or headers for provider "${provider}" in plugin "${generated.pluginId}". Move them to same-provider auth profiles or matching authored model configuration, then rerun openclaw doctor --fix.`,
        );
      }
    }
    credentials.set(generated.pluginId, byProvider);
  }
  return credentials;
}

/** Copies, verifies, and retires only generated credential copies. */
export async function maybeMigrateModelCatalogCredentials(params: {
  cfg: OpenClawConfig;
  configSource?: { path: string; hash: string | null };
  env?: NodeJS.ProcessEnv;
  prompter: DoctorPrompter;
  runtime: RuntimeEnv;
}): Promise<{ detected: number; migrated: number; removed: number; warnings: string[] }> {
  const warnings: string[] = [];
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
  // Inspect live configured agents even when they have only generated SQLite catalogs.
  const agentDirs = [
    ...new Set([
      mainAgentDir,
      ...listAgentIds(params.cfg).map((agentId) => resolveAgentDir(params.cfg, agentId, env)),
    ]),
  ].filter((agentDir) => !isRetained(agentDir));
  const mainStore = loadPersistedSharedAuthProfileStore(env) ?? emptyStore();
  const catalogs = agentDirs.map((agentDir) => collectAgentCatalogs(agentDir, warnings));
  const childStores = catalogs
    .filter((catalog) => catalog.agentDir !== mainAgentDir)
    .map((catalog) => catalog.localStore);
  const configCredentials = collectCredentials(
    params.cfg.models?.providers,
    mainStore,
    childStores,
    params.cfg,
  );
  const catalogImports = catalogs.map(({ agentDir, localStore, providers }) => {
    const effectiveStore = mergeAuthProfileStores(mainStore, localStore);
    return {
      agentDir,
      credentials: uniqueCredentials(
        providers.flatMap((entries) => collectCredentials(entries, effectiveStore, [], params.cfg)),
      ),
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

  for (const warning of warnings) {
    params.runtime.error(warning);
  }
  const reportedWarningCount = warnings.length;
  const pendingCleanup = catalogs.some((catalog) =>
    catalog.generated.some(
      (generated) => stripPluginModelCatalogCredentials(generated.contents) !== generated.contents,
    ),
  );
  if (detected === 0 && removable === 0 && !pendingCleanup) {
    return { detected, migrated: 0, removed: 0, warnings };
  }

  if (detected > 0) {
    note(
      `Found ${detected} plaintext model credential${detected === 1 ? "" : "s"}. Run openclaw doctor --fix to copy and verify them in agent SQLite before cleaning generated catalog copies.`,
      "Model catalog credentials",
    );
  }
  if (removable > 0) {
    note(
      `Found ${removable} stored unresolved model credential marker${removable === 1 ? "" : "s"}. Run openclaw doctor --fix to remove them from agent SQLite.`,
      "Model catalog credentials",
    );
  }
  const configSource = JSON.stringify(params.cfg.models?.providers);
  const configIo = createConfigIO({
    env,
    configPath: params.configSource?.path,
    observe: false,
    pluginValidation: "skip",
    shellEnvFallback: "defer",
  });
  const configRead = await configIo.readConfigFileSnapshotForWrite();
  const assertConfigCurrent = () => {
    const expected = params.configSource;
    if (
      configRead.snapshot.readError ||
      (expected &&
        (expected.path !== configRead.snapshot.path ||
          expected.hash === null ||
          expected.hash !== configRead.snapshot.hash)) ||
      JSON.stringify(params.cfg.models?.providers) !== configSource
    ) {
      throw new Error("model config changed since Doctor planned its repairs");
    }
    assertBaseSnapshotStillCurrent(configRead.snapshot, configIo.configPath, fs, {
      hashes: configRead.writeOptions.includeFileHashesForWrite ?? {},
      targets: configRead.writeOptions.includeFileTargetsForWrite ?? {},
    });
  };
  const shouldRepair =
    params.prompter.shouldRepair ||
    (await params.prompter.confirmAutoFix({
      message: "Repair model credentials in agent SQLite now?",
      initialValue: true,
    }));
  if (!shouldRepair) {
    return { detected, migrated: 0, removed: 0, warnings };
  }

  try {
    assertConfigCurrent();
  } catch (error) {
    const warning = `Model config changed before credential repair: ${error instanceof Error ? error.message : String(error)}; rerun openclaw doctor --fix.`;
    warnings.push(warning);
    params.runtime.error(warning);
    return { detected, migrated: 0, removed: 0, warnings };
  }
  // Confirmation is not a snapshot lease. Reread catalogs and auth after it settles.
  let migrated = 0;
  let removed = 0;
  let cleaned = 0;
  const migrate = async (description: string, target: Parameters<typeof persistCredentials>[0]) => {
    try {
      const result = await persistCredentials(target);
      migrated += result.migrated;
      removed += result.removed;
      return true;
    } catch (error) {
      warnings.push(
        `Could not migrate ${description}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };
  const currentMainStore = loadPersistedSharedAuthProfileStore(env) ?? emptyStore();
  const currentChildStores = agentDirs
    .filter((dir) => dir !== mainAgentDir)
    .map((dir) => loadPersistedAuthProfileStore(dir) ?? emptyStore());
  await migrate("configured model credentials", {
    stateDir,
    blockedStores: currentChildStores,
    credentials: collectCredentials(
      params.cfg.models?.providers,
      currentMainStore,
      currentChildStores,
      params.cfg,
    ),
    invalidProfiles: findProviderSecretRefProfiles(currentMainStore, params.cfg),
    assertCurrent: assertConfigCurrent,
  });
  for (const agentDir of agentDirs) {
    const catalog = collectAgentCatalogs(agentDir, warnings);
    const readEffectiveStore = () =>
      mergeAuthProfileStores(
        loadPersistedSharedAuthProfileStore(env) ?? emptyStore(),
        agentDir === mainAgentDir
          ? emptyStore()
          : (loadPersistedAuthProfileStore(agentDir) ?? emptyStore()),
      );
    const effectiveStore = readEffectiveStore();
    const description = `model credentials for ${shortenHomePath(agentDir)}`;
    const succeeded = await migrate(description, {
      stateDir,
      ...(agentDir === mainAgentDir ? {} : { agentDir }),
      credentials: catalog.providers.flatMap((providers) =>
        collectCredentials(providers, effectiveStore, [], params.cfg),
      ),
      invalidProfiles:
        agentDir === mainAgentDir
          ? []
          : findProviderSecretRefProfiles(catalog.localStore, params.cfg),
      assertCurrent: () => {
        assertConfigCurrent();
        catalog.assertCurrent();
      },
    });
    if (!succeeded) {
      continue;
    }
    try {
      const verifiedStore = readEffectiveStore();
      const credentials = cleanupCredentials(catalog, params.cfg, verifiedStore, warnings);
      cleaned += repairPersistedPluginModelCatalogs({
        agentDir,
        catalogs: catalog.generated,
        credentials,
        onDeferredCredentialCleanup: (pluginId) => {
          warnings.push(
            `Retained credentials for plugin "${pluginId}" until its legacy catalog migration completes; resolve the migration warning and rerun openclaw doctor --fix.`,
          );
        },
        assertCurrent: () => {
          assertConfigCurrent();
          catalog.assertRootCurrent();
          if (!isDeepStrictEqual(readEffectiveStore(), verifiedStore)) {
            throw new Error("canonical model credentials changed; rerun openclaw doctor --fix");
          }
        },
      }).length;
    } catch (error) {
      warnings.push(
        `Could not clean generated ${description}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const warning of warnings.slice(reportedWarningCount)) {
    params.runtime.error(warning);
  }

  if (migrated > 0) {
    note(
      `Copied and verified ${migrated} model credential${migrated === 1 ? "" : "s"} in agent SQLite. Authored catalog values remain unchanged.`,
      "Doctor changes",
    );
  }
  if (cleaned > 0) {
    note(
      `Cleaned verified credentials from ${cleaned} generated model catalog${cleaned === 1 ? "" : "s"}.`,
      "Doctor changes",
    );
  }
  if (removed > 0) {
    note(
      `Removed ${removed} unresolved model credential marker${removed === 1 ? "" : "s"} from agent SQLite.`,
      "Doctor changes",
    );
  }
  return { detected, migrated, removed, warnings };
}
