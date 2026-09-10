import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { listCandidateAuthProfileStores } from "../../agents/auth-profiles/candidate-stores.js";
import { normalizeAuthProfileCredential } from "../../agents/auth-profiles/credential-normalize.js";
import { shouldUseMainOwnerForLocalOAuthCredential } from "../../agents/auth-profiles/ownership.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../../agents/auth-profiles/path-resolve.js";
import {
  loadPersistedAuthProfileStoreAtDatabasePath,
  parseLegacyCredentialEntry,
} from "../../agents/auth-profiles/persisted.js";
import { resolveSharedMainAuthAgentDir } from "../../agents/auth-profiles/shared-main-dir.js";
import { resolveAuthProfileDatabasePath } from "../../agents/auth-profiles/sqlite.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { normalizeProviderId } from "../../agents/model-ref-shared.js";
import { withPluginModelCatalogWriteLocks } from "../../agents/plugin-model-catalog-lock.js";
import { readPersistedPluginModelCatalogGeneration } from "../../agents/plugin-model-catalog-logout.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type ModelsAuthCatalogAdmission = {
  assertCurrent: () => void;
  withPersistence: <T>(persist: () => Promise<T>) => Promise<T>;
  captureProfile: (profile: {
    profileId: string;
    provider: string;
    mode: AuthProfileCredential["type"];
    credential?: AuthProfileCredential;
    sharedStoreWrite?: boolean;
  }) => () => void;
};

function authChangedDuringSignIn(): Error {
  return new Error("Authentication changed during sign-in. Start the sign-in again.");
}

/** Capture before credential acquisition; logout retires only work already in flight. */
export async function prepareModelsAuthCatalogAdmission(params: {
  cfg: OpenClawConfig;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<ModelsAuthCatalogAdmission> {
  const env = { ...(params.env ?? process.env) };
  const candidates = await listCandidateAuthProfileStores({ cfg: params.cfg, env });
  const agentDirs = [
    ...new Set(
      [...candidates.map((candidate) => candidate.agentDir), params.agentDir].map((agentDir) =>
        path.resolve(agentDir),
      ),
    ),
  ];
  const generations = new Map(
    agentDirs.map((agentDir) => [agentDir, readPersistedPluginModelCatalogGeneration(agentDir)]),
  );
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    for (const [agentDir, generation] of generations) {
      if (readPersistedPluginModelCatalogGeneration(agentDir) !== generation) {
        throw authChangedDuringSignIn();
      }
    }
  };

  return {
    assertCurrent,
    withPersistence: async (persist) =>
      await withPluginModelCatalogWriteLocks(agentDirs, async () => {
        assertCurrent();
        const result = await persist();
        assertCurrent();
        return result;
      }),
    captureProfile: (profile) => {
      assertCurrent();
      const localOwner = {
        databasePath: resolveAuthProfileDatabasePath(params.agentDir),
        kind: "agent" as const,
      };
      // Fresh main login may have initialized the shared store during persistence.
      // Pin its committed physical owner now, not an effective read-through view.
      const sharedOwner = {
        databasePath: resolveSharedAuthStorePath(env),
        kind:
          resolveSharedAuthStoreOwnership(env).location === "state-db"
            ? ("shared-state" as const)
            : ("agent" as const),
      };
      let owner =
        profile.sharedStoreWrite &&
        path.resolve(params.agentDir) === path.resolve(resolveSharedMainAuthAgentDir(env))
          ? sharedOwner
          : localOwner;
      const readProfile = () =>
        loadPersistedAuthProfileStoreAtDatabasePath(owner.databasePath, owner.kind)?.profiles[
          profile.profileId
        ];
      let credential = readProfile();
      let inheritedOAuth = false;
      // Imports can reuse inherited credentials, and the auth owner deduplicates
      // newly saved OAuth credentials against the same shared account.
      if (!credential && (!profile.sharedStoreWrite || profile.credential?.type === "oauth")) {
        owner = sharedOwner;
        credential = readProfile();
        inheritedOAuth = Boolean(
          credential &&
          profile.credential &&
          shouldUseMainOwnerForLocalOAuthCredential({
            profileId: profile.profileId,
            local: profile.credential,
            main: credential,
          }),
        );
      }
      if (
        !credential ||
        normalizeProviderId(credential.provider) !== normalizeProviderId(profile.provider) ||
        credential.type !== profile.mode ||
        (profile.credential &&
          !inheritedOAuth &&
          !isDeepStrictEqual(
            credential,
            parseLegacyCredentialEntry(normalizeAuthProfileCredential(profile.credential)),
          ))
      ) {
        throw authChangedDuringSignIn();
      }
      const persistedCredential = credential;
      return () => {
        assertCurrent();
        if (!isDeepStrictEqual(readProfile(), persistedCredential)) {
          throw authChangedDuringSignIn();
        }
      };
    },
  };
}
