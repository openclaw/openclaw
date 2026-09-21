import { normalizeAgentId } from "../../routing/session-key.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import { resolveSqliteAgentId } from "./session-accessor.sqlite-scope.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

/** Read exact keys from the configured store, including keys shaped like incognito sessions. */
export async function readSessionEntriesFromStoreInWorker(input: {
  agentId: string;
  storePath: string;
  sessionKeys: readonly string[];
  lifecycleSessionKey?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = cloneEnvWithPlatformSemantics(input.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const agentId = normalizeAgentId(input.agentId);
  const storePath = input.storePath;
  const read = {
    env,
    sessionKeys: [...new Set(input.sessionKeys)],
    lifecycleSessionKey: input.lifecycleSessionKey,
  };
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const captured = captureSessionStoreReadCandidate(target.path);
  if (target.agentId && captured.path === captured.physicalPath) {
    resolveSqliteAgentId({ scopedAgentId: agentId, storeAgentId: target.agentId });
    const result = await withSessionHistoryWorkerDatabase(
      { agentId: target.agentId, path: captured.physicalPath, env },
      (owner) => owner.readExactEntries(read),
    );
    assertSessionStoreReadCandidate(target.path, [captured]);
    return result;
  }
  const candidates = captureSessionStoreReadCandidates(storePath);
  const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
  return await withSessionHistoryWorkerReadCandidates(candidates, async (discovery) => {
    const request = { agentId, storePath, env, candidates };
    let resolved = await discovery.readStoreTarget({
      ...request,
      registeredDatabases: { status: "deferred" },
    });
    let assertRegistryCurrent: (() => void) | undefined;
    if (resolved.kind === "session-target-registry-required") {
      const registry = await registryRead.read();
      assertRegistryCurrent = registry.assertCurrent;
      registry.assertCurrent();
      discovery.assertCurrent();
      resolved = await discovery.readStoreTarget({
        ...request,
        registeredDatabases:
          registry.result.status === "available"
            ? registry.result.entries
            : { status: "unavailable" },
      });
      if (resolved.kind === "session-target-registry-required") {
        throw new Error("Session store target requested registry rows twice");
      }
    }
    assertRegistryCurrent?.();
    discovery.assertCurrent();
    const result = await withSessionHistoryWorkerDatabase({ ...resolved.database, env }, (owner) =>
      owner.readExactEntries(read),
    );
    assertRegistryCurrent?.();
    discovery.assertCurrent();
    assertSessionStoreReadCandidate(resolved.sourcePath, candidates);
    return result;
  });
}
