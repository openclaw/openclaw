import { expectDefined } from "@openclaw/normalization-core";
import { isIncognitoSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import { matchesAgentDatabaseReadCandidatePath } from "../../state/openclaw-agent-db-resources.js";
import {
  readOpenIncognitoAgentDatabaseGeneration,
  resolveIncognitoOpenClawAgentSqlitePath,
  retainOpenClawAgentDatabaseReadCandidates,
} from "../../state/openclaw-agent-db.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  readSessionIdentityEvidenceBatch,
  type SessionIdentityEvidenceIdentity,
  type SessionIdentityEvidenceResult,
} from "./session-accessor.sqlite-entry-availability.js";
import { normalizeSqliteSessionKey } from "./session-accessor.sqlite-scope.js";
import { captureCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { captureSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabases } from "./session-transcript-worker-runtime.js";

export type PlacementSessionIdentityProbe = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
};

/** Whole evidence preparation keeps native incognito and disk-backed custody distinct. */
export async function readPlacementSessionIdentityEvidence(
  cfg: OpenClawConfig,
  input: readonly PlacementSessionIdentityProbe[],
): Promise<SessionIdentityEvidenceResult[]> {
  const capturedEnv = cloneEnvWithPlatformSemantics(process.env);
  const env = { ...capturedEnv, OPENCLAW_STATE_DIR: resolveStateDir(capturedEnv) };
  const probes = input.map((probe) => ({ ...probe }));
  const results: SessionIdentityEvidenceResult[] = probes.map(() => ({ status: "absent" }));
  const incognito = probes.flatMap((probe, index) =>
    isIncognitoSessionKey(probe.sessionKey) ? [{ probe, index }] : [],
  );
  const nativeProbes = incognito.map(({ probe }) => ({
    ...probe,
    env,
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: probe.agentId, env }),
  }));
  const readIncognito = () => {
    const native = readSessionIdentityEvidenceBatch(nativeProbes);
    for (const [offset, item] of incognito.entries()) {
      results[item.index] = expectDefined(native[offset], "incognito evidence");
    }
  };
  const incognitoGeneration = readOpenIncognitoAgentDatabaseGeneration();
  const disk = probes.flatMap((probe, index) =>
    !isIncognitoSessionKey(probe.sessionKey) ? [{ probe, index }] : [],
  );
  if (disk.length === 0) {
    readIncognito();
    return results;
  }
  const prepared = prepareSessionStoreTargetInventory(
    cfg,
    disk.map(({ probe }) => probe.agentId),
    env,
  );
  const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
  const nativeReaders = retainOpenClawAgentDatabaseReadCandidates(
    prepared.candidates.flatMap((candidate) => [
      candidate,
      { ...candidate, path: candidate.physicalPath },
    ]),
    env,
  );
  const continuations: Array<{
    path: string;
    owner: NonNullable<ReturnType<typeof captureCanonicalSessionReaderContinuation>>;
  }> = [];
  const releaseContinuations = () => {
    for (const { owner } of continuations.toReversed()) {
      owner.release();
    }
    nativeReaders.release();
  };
  try {
    for (const database of nativeReaders.databases) {
      const physicalPath = captureSessionStoreReadCandidate(database.path).physicalPath;
      const owner = captureCanonicalSessionReaderContinuation(database);
      if (owner) {
        continuations.push({ path: physicalPath, owner });
      }
    }
  } catch (error) {
    releaseContinuations();
    throw error;
  }
  let changed = false;
  let assertRegistryCurrent: (() => void) | undefined;
  const unsubscribe = sessionChanges.subscribe((change) => {
    if ("all" in change || !change.storePath) {
      changed = true;
      return;
    }
    const pathname = resolveUnsuffixedSqliteTargetFromSessionStorePath(change.storePath).path;
    changed ||= prepared.candidates.some(
      (candidate) =>
        matchesAgentDatabaseReadCandidatePath(candidate, pathname) ||
        matchesAgentDatabaseReadCandidatePath(
          { ...candidate, path: candidate.physicalPath },
          pathname,
        ),
    );
  });
  try {
    await withSessionHistoryWorkerReadCandidates(prepared.candidates, async (discovery) => {
      let inventory = await discovery.readTargetInventory({
        ...prepared,
        registeredDatabases: { status: "deferred" },
      });
      if (inventory.kind === "session-target-registry-required") {
        const registry = await registryRead.read();
        assertRegistryCurrent = registry.assertCurrent;
        registry.assertCurrent();
        discovery.assertCurrent();
        inventory = await discovery.readTargetInventory({
          ...prepared,
          registeredDatabases:
            registry.result.status === "available"
              ? registry.result.entries
              : { status: "unavailable" },
        });
        if (inventory.kind === "session-target-registry-required") {
          throw new Error("Session target discovery requested registry rows twice");
        }
      }
      assertRegistryCurrent?.();
      discovery.assertCurrent();
      const agents = new Map(inventory.agents.map((agent) => [agent.agentId, agent]));
      const groups = new Map<
        string,
        {
          database: { agentId: string; path: string };
          identities: SessionIdentityEvidenceIdentity[];
          indexes: number[];
        }
      >();
      for (const { probe, index } of disk) {
        const observed = agents.get(normalizeAgentId(probe.agentId));
        if (!observed || !observed.result.available) {
          results[index] =
            observed?.result.available === false && observed.result.reason === "database-missing"
              ? { status: "absent" }
              : { status: "unknown", reason: "read-failed" };
          continue;
        }
        for (const { database } of observed.reads) {
          const key = JSON.stringify(database);
          const group = groups.get(key) ?? { database, identities: [], indexes: [] };
          group.identities.push({
            sessionId: probe.sessionId,
            sessionKey: normalizeSqliteSessionKey(probe.sessionKey),
          });
          group.indexes.push(index);
          groups.set(key, group);
        }
      }
      const reads = [...groups.values()];
      return await withSessionHistoryWorkerDatabases(
        reads.map(({ database }) => ({ ...database, env })),
        async (owners) => {
          const assertCurrent = () => {
            assertRegistryCurrent?.();
            discovery.assertCurrent();
            for (const owner of owners) {
              owner.assertCurrent();
            }
          };
          assertCurrent();
          for (const [index, group] of reads.entries()) {
            let evidence: SessionIdentityEvidenceResult[];
            try {
              evidence = await expectDefined(
                owners[index],
                "retained evidence reader",
              ).readIdentityEvidence({
                identities: group.identities,
                env: prepared.env,
                continuation: continuations.find(
                  ({ path, owner }) =>
                    path === group.database.path &&
                    owner.receipt.agentId === group.database.agentId,
                )?.owner.receipt,
              });
            } catch (error) {
              assertCurrent();
              if (error instanceof AggregateError) {
                throw error;
              }
              evidence = group.identities.map(() => ({ status: "unknown", reason: "read-failed" }));
            }
            assertCurrent();
            for (const [offset, evidenceResult] of evidence.entries()) {
              const resultIndex = expectDefined(group.indexes[offset], "evidence subject");
              if (
                results[resultIndex]?.status !== "current" &&
                evidenceResult.status !== "absent"
              ) {
                results[resultIndex] = evidenceResult;
              }
            }
          }
          assertCurrent();
          return results;
        },
      );
    });
    assertRegistryCurrent?.();
    for (const candidate of prepared.candidates) {
      if (
        captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath !==
        candidate.physicalPath
      ) {
        throw new Error("Session store alias changed during discovery; retry the read.");
      }
    }
    for (const { owner } of continuations) {
      owner.assertCurrent();
    }
    if (changed) {
      for (const { index } of disk) {
        if (results[index]?.status === "absent") {
          results[index] = { status: "unknown", reason: "read-failed" };
        }
      }
    }
    if (incognitoGeneration !== readOpenIncognitoAgentDatabaseGeneration()) {
      for (const { index } of incognito) {
        results[index] = { status: "unknown", reason: "read-failed" };
      }
    } else {
      // Rows can change without replacing the process-held incognito connection.
      readIncognito();
    }
    return results;
  } finally {
    unsubscribe();
    releaseContinuations();
  }
}
