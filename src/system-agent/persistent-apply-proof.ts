import fs from "node:fs";
import { getRuntimeAuthProfileStoreCredentialMutationToken } from "../agents/auth-profiles/mutation-lineage.js";
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import { assertBaseSnapshotStillCurrent } from "../config/io.write-safety.js";
import { ConfigMutationConflictError } from "../config/mutation-conflict.js";
import type { RuntimeEnv } from "../runtime.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import type { SystemAgentCommandDeps } from "./operations.js";
import type { SystemAgentVerifiedInferenceBinding } from "./verified-inference.js";

export type SystemAgentPersistentApplyProof = {
  expectedConfigRevision: string;
  assertConfigCurrent: () => void;
  assertOwnerCurrent: () => Promise<void>;
};

/** The CLI and chat entrypoints pin the same bound fallback and authored revision. */
export async function resolveSystemAgentPersistentApplyProof(params: {
  binding: SystemAgentVerifiedInferenceBinding;
  runtime: RuntimeEnv;
  deps?: SystemAgentCommandDeps;
}): Promise<SystemAgentPersistentApplyProof | null> {
  const before = await readConfigFileSnapshotForWrite({ observe: false });
  const { resolvePersistentApplyInference } = await import("./setup-inference.js");
  const route = await resolvePersistentApplyInference(params);
  if (!route) {
    return null;
  }
  const after = await readConfigFileSnapshotForWrite({ observe: false });
  if (
    !before.snapshot.valid ||
    !after.snapshot.valid ||
    !after.snapshot.hash ||
    before.snapshot.path !== after.snapshot.path ||
    before.snapshot.hash !== after.snapshot.hash
  ) {
    return null;
  }
  const profileId = params.binding.auth.authProfileId;
  const credentialToken = profileId
    ? getRuntimeAuthProfileStoreCredentialMutationToken(
        params.binding.execution.agentDir,
        profileId,
        {
          includeMain: true,
        },
      )
    : undefined;
  const assertConfigCurrent = () => {
    after.writeOptions.assertConfigPathForWrite?.();
    assertBaseSnapshotStillCurrent(after.snapshot, after.snapshot.path, fs, {
      hashes: after.writeOptions.includeFileHashesForWrite ?? {},
      targets: after.writeOptions.includeFileTargetsForWrite ?? {},
    });
    if (profileId && credentialToken) {
      const current = getRuntimeAuthProfileStoreCredentialMutationToken(
        params.binding.execution.agentDir,
        profileId,
        { includeMain: true },
      );
      if (
        !credentialToken.known ||
        !current.known ||
        current.revision !== credentialToken.revision
      ) {
        throw new ConfigMutationConflictError(
          "verified maintenance credential changed before write",
          {
            retryable: false,
          },
        );
      }
    }
  };
  return {
    expectedConfigRevision: after.snapshot.hash,
    assertConfigCurrent,
    assertOwnerCurrent: async () => {
      if (!(await resolvePersistentApplyInference(params))) {
        throw new SystemAgentInferenceUnavailableError("conversation");
      }
      assertConfigCurrent();
    },
  };
}
