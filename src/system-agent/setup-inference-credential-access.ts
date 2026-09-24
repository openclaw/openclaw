import { isDeepStrictEqual } from "node:util";
import {
  getRuntimeAuthProfileStoreCredentialMutationToken,
  type RuntimeAuthProfileStoreMutationOwner,
  type RuntimeAuthProfileStoreMutationToken,
} from "../agents/auth-profiles/mutation-lineage.js";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  withSetupCredentialAccess,
  type SetupRuntimeCredential,
} from "../agents/auth-profiles/setup-access.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStoreIfPersistenceSnapshotMatches,
} from "../agents/auth-profiles/store-runtime.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  resolvePersistedAuthProfileOwnerAgentDir,
  restoreAuthProfileStorePersistenceSnapshot,
} from "../agents/auth-profiles/store.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { isMissingSecretRefResolutionError } from "../secrets/resolve-errors.js";
import {
  SetupInferenceOwnerDriftError,
  throwIfSetupInferenceCancelled,
  type ActivateSetupInferenceResult,
  type StageContext,
  type StagedCandidate,
} from "./setup-inference-core.js";
export type SetupCredentialActivationReceipt = { rollback: () => void; assertCurrent: () => void };

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
    const store = loadAuthProfileStoreWithoutExternalProfiles(ctx.agentDir);
    const credential = store.profiles[profileId];
    const refInput =
      credential?.type === "api_key"
        ? (credential.keyRef ?? credential.key)
        : credential?.type === "token"
          ? (credential.tokenRef ?? credential.token)
          : undefined;
    const ref = coerceSecretRef(refInput, staged.config.secrets?.defaults);
    if (!credential || !ref) {
      return await verify();
    }
    // Prepare the selected account with the existing secrets owner, but do not
    // publish a candidate config or replace the live Gateway's auth snapshot.
    const source = structuredClone(credential);
    const { prepareSecretsRuntimeSnapshot } = await import("../secrets/runtime.js");
    const assertOriginalGeneration = () => {
      if (credentialsRevision !== getRuntimeAuthProfileStoreCredentialsRevision()) {
        throw new SetupInferenceOwnerDriftError(
          "The saved credential changed during preparation. Retry this sign-in in Model Setup.",
        );
      }
    };
    assertOriginalGeneration();
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
      assertOriginalGeneration();
      return failure({
        ok: false,
        status: "unknown",
        error:
          "The saved credential could not be resolved. Restore its secret and retry this sign-in in Model Setup.",
      });
    }
    throwIfSetupInferenceCancelled(params);
    assertOriginalGeneration();
    if (prepared.authStoreCredentialsRevision !== credentialsRevision) {
      throw new SetupInferenceOwnerDriftError(
        "The saved credential changed during preparation. Retry this sign-in in Model Setup.",
      );
    }
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
  const agentDir = params.stateDir
    ? params.agentDir
    : resolvePersistedAuthProfileOwnerAgentDir(params);
  const before = captureAuthProfileStorePersistenceSnapshot(agentDir, {
    stateDir: params.stateDir,
  });
  const store = structuredClone(loadAuthProfileStoreWithoutExternalProfiles(agentDir));
  const current = store.profiles[params.profileId];
  if (!current || !isDeepStrictEqual(current, params.credential)) {
    throw new Error("The saved sign-in changed before activation. Test it again in Model Setup.");
  }
  delete current.setup;
  params.beforeWrite?.();
  const committed = saveAuthProfileStoreIfPersistenceSnapshotMatches({
    store,
    snapshot: before,
    agentDir,
    stateDir: params.stateDir,
  });
  const credentialOwner: RuntimeAuthProfileStoreMutationOwner = {
    kind: "resolved",
    databasePath: committed.owned.owner.databasePath,
    sharedDatabasePath: committed.owned.owner.sharedDatabasePath,
  };
  let mutationToken: RuntimeAuthProfileStoreMutationToken;
  const rollback = () => {
    restoreAuthProfileStorePersistenceSnapshot(before, committed.owned, agentDir, {
      stateDir: params.stateDir,
    });
    if (
      !isDeepStrictEqual(
        loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[params.profileId],
        params.credential,
      )
    ) {
      throw new SetupInferenceOwnerDriftError(
        "A newer credential update superseded this activation. Review Model Setup.",
      );
    }
    mutationToken = getRuntimeAuthProfileStoreCredentialMutationToken(agentDir, params.profileId, {
      owner: credentialOwner,
    });
  };
  try {
    if (!committed.publishRuntimeSnapshots()) {
      throw new Error("The saved sign-in could not be published. Retry it in Model Setup.");
    }
  } catch (error) {
    rollback();
    throw error;
  }
  mutationToken = getRuntimeAuthProfileStoreCredentialMutationToken(agentDir, params.profileId, {
    owner: credentialOwner,
  });
  return {
    rollback,
    assertCurrent: () => {
      const currentToken = getRuntimeAuthProfileStoreCredentialMutationToken(
        agentDir,
        params.profileId,
        { owner: credentialOwner },
      );
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
