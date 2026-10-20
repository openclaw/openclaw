// Doctor cleanup for per-agent OAuth profiles shadowing fresher main-agent credentials.
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAgentDir, listAgentEntries } from "../../../agents/agent-scope.js";
import { hasUsableOAuthCredential } from "../../../agents/auth-profiles/credential-state.js";
import {
  isLegacyOAuthRef,
  LEGACY_OAUTH_REF_PROVIDER,
} from "../../../agents/auth-profiles/legacy-oauth-ref.js";
import {
  areOAuthCredentialsEquivalent,
  isSafeToAdoptMainStoreOAuthIdentity,
} from "../../../agents/auth-profiles/oauth-shared.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../../../agents/auth-profiles/persisted.js";
import { resolveSharedMainAuthAgentDir } from "../../../agents/auth-profiles/shared-main-dir.js";
import { updateAuthProfileStoreWithLock } from "../../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore, OAuthCredential } from "../../../agents/auth-profiles/types.js";
import { resolveStateDir } from "../../../config/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasErrnoCode } from "../../../infra/errno.js";
import { shortenHomePath } from "../../../utils.js";
import { resolveLegacyAuthProfilesPath as resolveAuthStorePath } from "../../doctor-auth-legacy-paths.js";

type StaleOAuthProfileShadow = {
  agentDir: string;
  authPath: string;
  profileId: string;
};

async function loadRawAuthProfileStore(authPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = JSON.parse(await fs.readFile(authPath, "utf8")) as unknown;
    if (!isRecord(raw)) {
      throw new Error("Expected an auth profile store object");
    }
    return raw;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw new Error(
      `Cannot read legacy auth profile store ${shortenHomePath(authPath)}; skipped OAuth shadow cleanup. Inspect or restore the file and rerun doctor.`,
      { cause: error },
    );
  }
}

function hasLegacyOAuthSidecarRef(raw: Record<string, unknown> | null, profileId: string): boolean {
  const profile = raw && isRecord(raw.profiles) ? raw.profiles[profileId] : undefined;
  // Sidecar-backed profiles need legacy migration, never shadow cleanup.
  return (
    isRecord(profile) &&
    profile.type === "oauth" &&
    profile.provider === LEGACY_OAUTH_REF_PROVIDER &&
    isLegacyOAuthRef(profile.oauthRef)
  );
}

async function collectCandidateAgentDirs(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const dirs = new Set<string>();
  for (const entry of listAgentEntries(cfg)) {
    const id = entry.id?.trim();
    if (id) {
      dirs.add(path.resolve(resolveAgentDir(cfg, id, env)));
    }
  }
  const agentsRoot = path.join(resolveStateDir(env), "agents");
  const entries = await fs.readdir(agentsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      dirs.add(path.resolve(agentsRoot, entry.name, "agent"));
    }
  }
  return [...dirs].toSorted((left, right) => left.localeCompare(right));
}

function shouldRemoveLocalOAuthShadow(params: {
  local: OAuthCredential;
  main: OAuthCredential | undefined;
  now: number;
}): boolean {
  const { local, main, now } = params;
  if (!main || isLegacyOAuthRef(local.oauthRef) || local.provider !== main.provider) {
    return false;
  }
  if (!isSafeToAdoptMainStoreOAuthIdentity(local, main)) {
    return false;
  }
  if (areOAuthCredentialsEquivalent(local, main)) {
    return true;
  }
  if (!hasUsableOAuthCredential(main, { now })) {
    return false;
  }
  if (!hasUsableOAuthCredential(local, { now })) {
    return true;
  }
  const localExpires = Number.isFinite(local.expires) ? local.expires : 0;
  const mainExpires = Number.isFinite(main.expires) ? main.expires : 0;
  return mainExpires >= localExpires;
}

/** Find local OAuth profiles that safely inherit fresher main-agent credentials instead. */
export async function scanStaleOAuthProfileShadows(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<{ hits: StaleOAuthProfileShadow[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now();
  const mainAuthPath = path.resolve(resolveAuthStorePath(resolveSharedMainAuthAgentDir(env)));
  const mainStore = loadPersistedSharedAuthProfileStore(env);
  if (!mainStore) {
    return { hits: [], warnings: [] };
  }
  const hits: StaleOAuthProfileShadow[] = [];
  const warnings: string[] = [];
  for (const agentDir of await collectCandidateAgentDirs(params.cfg, env)) {
    const authPath = path.resolve(resolveAuthStorePath(agentDir));
    if (authPath === mainAuthPath) {
      continue;
    }
    const rawLocalStore = await loadRawAuthProfileStore(authPath).catch((error: unknown) => {
      warnings.push(String(error));
    });
    if (rawLocalStore === undefined) {
      continue;
    }
    const localStore = loadPersistedAuthProfileStore(agentDir);
    if (!localStore) {
      continue;
    }
    for (const [profileId, local] of Object.entries(localStore.profiles)) {
      if (local.type !== "oauth" || hasLegacyOAuthSidecarRef(rawLocalStore, profileId)) {
        continue;
      }
      const main = mainStore.profiles[profileId];
      if (
        shouldRemoveLocalOAuthShadow({
          local,
          main: main?.type === "oauth" ? main : undefined,
          now,
        })
      ) {
        hits.push({ agentDir, authPath, profileId });
      }
    }
  }
  return { hits, warnings };
}

function removeStaleProfilesFromStore(params: {
  store: AuthProfileStore;
  mainStore: AuthProfileStore;
  profileIds: Set<string>;
  now: number;
}): string[] {
  const removedProfileIds: string[] = [];
  const { profiles, usageStats, lastGood } = params.store;
  for (const profileId of params.profileIds) {
    const local = profiles[profileId];
    const main = params.mainStore.profiles[profileId];
    if (
      local?.type !== "oauth" ||
      !shouldRemoveLocalOAuthShadow({
        local,
        main: main?.type === "oauth" ? main : undefined,
        now: params.now,
      })
    ) {
      continue;
    }
    delete profiles[profileId];
    delete usageStats?.[profileId];
    if (lastGood) {
      for (const [provider, lastGoodProfileId] of Object.entries(lastGood)) {
        if (lastGoodProfileId === profileId) {
          delete lastGood[provider];
        }
      }
    }
    removedProfileIds.push(profileId);
  }
  if (removedProfileIds.length > 0) {
    params.store.usageStats =
      usageStats && Object.keys(usageStats).length > 0 ? usageStats : undefined;
    params.store.lastGood = lastGood && Object.keys(lastGood).length > 0 ? lastGood : undefined;
  }
  return removedProfileIds;
}

/** Format warnings for stale per-agent OAuth profile shadows. */
export function collectStaleOAuthProfileShadowWarnings(params: {
  hits: StaleOAuthProfileShadow[];
  doctorFixCommand: string;
}): string[] {
  return params.hits.map(
    (hit) =>
      `- ${shortenHomePath(hit.authPath)} has stale OAuth auth profile ${hit.profileId}; it shadows the fresher main-agent credential. Run "${params.doctorFixCommand}" to remove the local shadow and inherit main auth.`,
  );
}

/** Remove stale per-agent OAuth profile shadows after rechecking each locked store. */
export async function repairStaleOAuthProfileShadows(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now();
  const { hits, warnings } = await scanStaleOAuthProfileShadows({ ...params, env, now });
  const changes: string[] = [];
  const byAgentDir = new Map<string, Set<string>>();
  for (const hit of hits) {
    const profileIds = byAgentDir.get(hit.agentDir) ?? new Set<string>();
    profileIds.add(hit.profileId);
    byAgentDir.set(hit.agentDir, profileIds);
  }
  for (const [agentDir, profileIds] of byAgentDir) {
    const mainStore = loadPersistedSharedAuthProfileStore(env);
    if (!mainStore) {
      continue;
    }
    try {
      const rawStore = await loadRawAuthProfileStore(resolveAuthStorePath(agentDir));
      const removableIds = new Set(
        [...profileIds].filter((profileId) => !hasLegacyOAuthSidecarRef(rawStore, profileId)),
      );
      if (removableIds.size === 0 || !loadPersistedAuthProfileStore(agentDir)) {
        continue;
      }
      let removedProfileIds: string[] = [];
      await updateAuthProfileStoreWithLock({
        agentDir,
        updater: (store) => {
          removedProfileIds = removeStaleProfilesFromStore({
            store,
            mainStore,
            profileIds: removableIds,
            now,
          });
          return removedProfileIds.length > 0;
        },
      });
      if (removedProfileIds.length > 0) {
        changes.push(
          `Removed stale OAuth auth profile shadow ${removedProfileIds.length === 1 ? removedProfileIds[0] : `${removedProfileIds.length} profiles`} from ${shortenHomePath(resolveAuthStorePath(agentDir))}; this agent now inherits main auth.`,
        );
      }
    } catch (error) {
      warnings.push(
        `Failed to remove stale OAuth auth profile shadow from ${shortenHomePath(
          resolveAuthStorePath(agentDir),
        )}: ${String(error)}`,
      );
    }
  }
  return { changes, warnings };
}
