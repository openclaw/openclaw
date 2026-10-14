import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getSqliteDatabaseAdmissionIdentityForPath } from "../infra/sqlite-database-admission.js";
import {
  readDatabasePathIdentitySync,
  resolveDatabasePathKey,
} from "../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  assertAgentCreationClaimAliases,
  assertAgentCreationClaimCurrent,
  captureAgentCreationClaim,
} from "./agent-creation-claim.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import {
  captureOpenClawAgentDatabaseAliasPublication,
  getOpenClawAgentDatabaseValidationForTransfer,
} from "./openclaw-agent-db-validation-cache.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import type { OpenClawAgentDatabaseAdmissionExecution } from "./openclaw-agent-execution-admission-contract.js";
import { runOpenClawAgentWorkerWrite } from "./openclaw-agent-write-admission.js";

/** The existing executor owns cold admission; the native callback retains the SDK handle contract. */
export async function withWorkerAdmission<T>(
  options: OpenClawAgentDatabaseOptions,
  assertCurrent: (() => void) | undefined,
  signal: AbortSignal | undefined,
  run: (preparation: "native" | "worker") => Promise<T>,
  borrowedExecution?: OpenClawAgentDatabaseAdmissionExecution,
): Promise<T> {
  const pathname = resolveOpenClawAgentSqlitePath(options);
  assertAgentCreationClaimCurrent(options);
  assertAgentCreationClaimAliases(options);
  const creationClaim = captureAgentCreationClaim(options);
  const admittedIdentity = borrowedExecution
    ? getSqliteDatabaseAdmissionIdentityForPath(pathname)
    : undefined;
  const identity = admittedIdentity
    ? { ...admittedIdentity, canonicalPath: resolveDatabasePathKey(pathname) }
    : readDatabasePathIdentitySync(pathname);
  const agentId = normalizeAgentId(options.agentId);
  if (borrowedExecution) {
    borrowedExecution.assertCurrent();
    if (borrowedExecution.agentId !== agentId || borrowedExecution.path !== pathname) {
      throw new Error("Agent worker admission differs from its captured execution");
    }
  }
  let publishAlias =
    identity.canonicalPath !== pathname
      ? captureOpenClawAgentDatabaseAliasPublication({ agentId, path: pathname })
      : undefined;
  const completion = createDeferredCore();
  let revoked = false;
  let releaseExecution: (() => Promise<void>) | undefined;
  const assertAdmission = () => {
    if (revoked) {
      throw new Error("Agent database admission closed during worker preparation");
    }
    assertCurrent?.();
    borrowedExecution?.assertCurrent();
    creationClaim?.assertCurrent();
    signal?.throwIfAborted();
  };
  const resource = {
    agentId,
    path: pathname,
    revoke: () => {
      revoked = true;
    },
    close: () => completion.promise,
  };
  const unregister = registerOpenClawAgentDatabaseAsyncResource(resource, options);
  try {
    const owner = await import("./openclaw-agent-execution.js");
    assertAdmission();
    // Doctor/maintenance and deletion cleanup retain their local durable owner.
    if (!owner.supportsOpenClawAgentDatabaseExecution(options)) {
      return await run("native");
    }
    let execution: OpenClawAgentDatabaseAdmissionExecution;
    if (borrowedExecution) {
      execution = borrowedExecution;
    } else {
      const captured = owner.captureOpenClawAgentDatabaseExecution(
        options,
        identity.key.startsWith("file:")
          ? {
              expectedIdentity: {
                kind: "file",
                physicalIdentity: identity.key.slice("file:".length),
                nativeLocation: identity.canonicalPath,
                birthtime: identity.birthtime,
              },
            }
          : {},
      );
      execution = captured;
      releaseExecution = () => captured.release();
    }
    const source: Parameters<typeof execution.prepare>[0] = {
      assertCurrent: assertAdmission,
      createAdmission: (binding) => () => ({
        nativeLocations: binding.nativeLocations,
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          assertAdmission();
          if (
            publishAlias &&
            request.stage === "prepare" &&
            isRecord(request.facts) &&
            request.facts.kind === "agent-validation-start"
          ) {
            publishAlias = captureOpenClawAgentDatabaseAliasPublication({
              agentId,
              path: pathname,
            });
          }
          if (!grant()) {
            throw new Error("Agent database preparation lost its admission");
          }
        }, binding.attachment),
      }),
    };
    await runOpenClawAgentWorkerWrite(options, () =>
      execution.prepare(source, signal, { readmitSchema: true }),
    );
    assertAdmission();
    publishAlias?.(
      execution.captureGenerationClaim().identity,
      getOpenClawAgentDatabaseValidationForTransfer({ agentId, path: identity.canonicalPath }),
    );
    return await run("worker");
  } finally {
    try {
      await releaseExecution?.();
    } finally {
      unregister();
      completion.resolve();
    }
  }
}
