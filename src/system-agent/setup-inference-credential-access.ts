import { isDeepStrictEqual } from "node:util";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import {
  getRuntimeAuthProfileStoreCredentialMutationToken,
  type RuntimeAuthProfileStoreMutationOwner,
  type RuntimeAuthProfileStoreMutationToken,
} from "../agents/auth-profiles/mutation-lineage.js";
import { buildPersistedAuthProfileSecretsStore } from "../agents/auth-profiles/persisted.js";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  withSetupCredentialAccess,
  type SetupRuntimeCredential,
} from "../agents/auth-profiles/setup-access.js";
import {
  loadAuthProfileStoreWithoutExternalProfilesAsync,
  resolvePersistedAuthProfileOwnerAgentDirAsync,
} from "../agents/auth-profiles/store-runtime.js";
import { publishAuthProfileStoreUpdate } from "../agents/auth-profiles/store-update-publication.js";
import { runAuthProfileStoreUpdate } from "../agents/auth-profiles/store-update.js";
import { getScopedAuthProfileEnv } from "../agents/auth-profiles/store.js";
import type {
  AuthProfileCredential,
  PreparedAuthProfileStoreOwner,
} from "../agents/auth-profiles/types.js";
import { parseSecretRef } from "../config/types.secrets.js";
import { isMissingSecretRefResolutionError } from "../secrets/resolve-errors.js";
import {
  SetupInferenceOwnerDriftError,
  throwIfSetupInferenceCancelled,
  type ActivateSetupInferenceResult,
  type StageContext,
  type StagedCandidate,
} from "./setup-inference-core.js";
export type SetupCredentialActivationReceipt = {
  rollback: () => Promise<void>;
  assertCurrent: () => void;
};

/** Prepares one selected account without publishing a candidate runtime. */
export async function withPreparedSetupCredentialAccess(
  ctx: StageContext,
  staged: StagedCandidate,
  profileId: string,
  verify: (runtimeCredential?: SetupRuntimeCredential) => Promise<ActivateSetupInferenceResult>,
  failure: (
    result: Extract<ActivateSetupInferenceResult, { ok: false }>,
  ) => ActivateSetupInferenceResult,
): Promise<ActivateSetupInferenceResult> {
  const { params } = ctx;
  const access = { profileId, agentDir: ctx.agentDir, signal: params.signal };
  return await withSetupCredentialAccess(access, async () => {
    const credentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
    const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(ctx.agentDir);
    const credential = store.profiles[profileId];
    const refInput =
      credential?.type === "api_key"
        ? (credential.keyRef ?? credential.key)
        : credential?.type === "token"
          ? (credential.tokenRef ?? credential.token)
          : undefined;
    const ref = parseSecretRef(refInput, staged.config.secrets?.defaults);
    if (!credential || !ref) {
      return await verify();
    }
    // Prepare the selected account with the existing secrets owner, but do not
    // publish a candidate config or replace the live Gateway's auth snapshot.
    const source = structuredClone(credential);
    const { prepareSecretsRuntimeSnapshot } = await import("../secrets/runtime.js");
    const assertOriginalGeneration = (revision: number) => {
      if (credentialsRevision !== revision) {
        throw new SetupInferenceOwnerDriftError(
          "The saved credential changed during preparation. Retry this sign-in in Model Setup.",
        );
      }
    };
    assertOriginalGeneration(getRuntimeAuthProfileStoreCredentialsRevision());
    let prepared: Awaited<ReturnType<typeof prepareSecretsRuntimeSnapshot>>;
    try {
      prepared = await prepareSecretsRuntimeSnapshot({
        config: staged.config,
        agentDirs: [ctx.agentDir],
        includeConfigRefs: false,
        loadAuthStore: () => ({ version: 1, profiles: { [profileId]: structuredClone(source) } }),
      });
    } catch (error) {
      if (!isMissingSecretRefResolutionError({ ref, error })) {
        throw error;
      }
      throwIfSetupInferenceCancelled(params);
      assertOriginalGeneration(getRuntimeAuthProfileStoreCredentialsRevision());
      return failure({
        ok: false,
        status: "unknown",
        error:
          "The saved credential could not be resolved. Restore its secret and retry this sign-in in Model Setup.",
      });
    }
    throwIfSetupInferenceCancelled(params);
    assertOriginalGeneration(getRuntimeAuthProfileStoreCredentialsRevision());
    assertOriginalGeneration(prepared.authStoreCredentialsRevision);
    const materialized = prepared.authStores[0]?.store.profiles[profileId];
    if (!materialized) {
      return failure({
        ok: false,
        status: "auth",
        error: "The saved credential could not be prepared. Retry this sign-in in Model Setup.",
      });
    }
    const runtimeCredential = { source, materialized, credentialsRevision };
    return await withSetupCredentialAccess({ ...access, runtimeCredential }, () =>
      verify(runtimeCredential),
    );
  });
}

export async function activateSavedSetupCredential(params: {
  agentDir: string;
  profileId: string;
  credential: AuthProfileCredential;
  beforeWrite?: () => void;
  stateDir?: string;
}): Promise<SetupCredentialActivationReceipt | undefined> {
  if (!params.credential.setup) {
    return undefined;
  }
  const original = buildPersistedAuthProfileSecretsStore({
    version: AUTH_STORE_VERSION,
    profiles: { [params.profileId]: structuredClone(params.credential) },
  }).profiles[params.profileId];
  if (!original) {
    throw new Error("The saved sign-in cannot be activated through a shared auth profile.");
  }
  const activated = structuredClone(original);
  delete activated.setup;
  const agentDir = params.stateDir
    ? params.agentDir
    : await resolvePersistedAuthProfileOwnerAgentDirAsync(params);
  let owner: PreparedAuthProfileStoreOwner | undefined;
  const replaceCredential = async (
    expected: AuthProfileCredential,
    next: AuthProfileCredential,
    rollback = false,
  ) => {
    await runAuthProfileStoreUpdate({
      agentDir,
      envOnly: false,
      options: owner
        ? { env: owner.env }
        : {
            stateDir: params.stateDir,
            env: params.stateDir ? undefined : getScopedAuthProfileEnv(),
          },
      assertCurrent: rollback ? undefined : params.beforeWrite,
      update(prepared, currentOwner) {
        if (
          (owner &&
            (currentOwner.databasePath !== owner.databasePath ||
              currentOwner.sharedDatabasePath !== owner.sharedDatabasePath)) ||
          !isDeepStrictEqual(prepared.store.profiles[params.profileId], expected)
        ) {
          throw new SetupInferenceOwnerDriftError(
            rollback
              ? "A newer credential update superseded this activation. Review Model Setup."
              : "The saved sign-in changed before activation. Test it again in Model Setup.",
          );
        }
        prepared.store.profiles[params.profileId] = structuredClone(next);
        return {
          save: true,
          store: prepared.store,
          externalProfiles: [],
          options: { filterExternalAuthProfiles: false, syncExternalCli: false },
        };
      },
      async publish(committed, currentOwner, assertCurrent, nativeCommits, committedIsCurrent) {
        if (!committed) {
          throw new Error("The saved sign-in update did not commit. Retry it in Model Setup.");
        }
        owner = currentOwner;
        await publishAuthProfileStoreUpdate(
          currentOwner,
          committed,
          assertCurrent,
          nativeCommits,
          committedIsCurrent,
        );
      },
    });
  };
  const readMutationToken = () => {
    if (!owner) {
      throw new Error("The saved sign-in update has no committed owner.");
    }
    const credentialOwner: RuntimeAuthProfileStoreMutationOwner = {
      kind: "resolved",
      databasePath: owner.databasePath,
      sharedDatabasePath: owner.sharedDatabasePath,
    };
    return getRuntimeAuthProfileStoreCredentialMutationToken(agentDir, params.profileId, {
      owner: credentialOwner,
    });
  };
  let mutationToken: RuntimeAuthProfileStoreMutationToken;
  const rollback = async () => {
    // Restore this credential only; unrelated profile and usage writes remain current.
    await replaceCredential(activated, original, true);
    mutationToken = readMutationToken();
  };
  try {
    await replaceCredential(original, activated);
  } catch (error) {
    if (owner) {
      await rollback();
    }
    throw error;
  }
  mutationToken = readMutationToken();
  return {
    rollback,
    assertCurrent: () => {
      const currentToken = readMutationToken();
      if (
        !mutationToken.known ||
        !currentToken.known ||
        mutationToken.revision !== currentToken.revision
      ) {
        throw new SetupInferenceOwnerDriftError(
          "The credential changed before activation completed. Review Model Setup.",
        );
      }
    },
  };
}

export async function activatePreparedSetupCredential(
  ctx: StageContext,
  profileId: string,
  credential: AuthProfileCredential,
  runtimeCredential: SetupRuntimeCredential | undefined,
  revalidate: () => Promise<void>,
  assertCurrent: () => void,
): Promise<SetupCredentialActivationReceipt | undefined> {
  const { params } = ctx;
  return await withSetupCredentialAccess(
    { profileId, agentDir: ctx.agentDir, signal: params.signal, runtimeCredential },
    async () => {
      await revalidate();
      return await activateSavedSetupCredential({
        agentDir: ctx.agentDir,
        profileId,
        credential,
        beforeWrite: () => {
          assertCurrent();
          throwIfSetupInferenceCancelled(params);
          if (
            runtimeCredential &&
            runtimeCredential.credentialsRevision !==
              getRuntimeAuthProfileStoreCredentialsRevision()
          ) {
            throw new SetupInferenceOwnerDriftError(
              "The saved credential changed before activation. Test this sign-in again.",
            );
          }
        },
      });
    },
  );
}
