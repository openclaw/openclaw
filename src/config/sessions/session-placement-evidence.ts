import { expectDefined } from "@openclaw/normalization-core";
import { isIncognitoSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { matchesAgentDatabaseReadCandidatePath } from "../../state/openclaw-agent-db-resources.js";
import {
  readOpenIncognitoAgentDatabaseGeneration,
  resolveIncognitoOpenClawAgentSqlitePath,
  retainOpenClawAgentDatabaseReadCandidates,
} from "../../state/openclaw-agent-db.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  readSessionIdentityEvidenceBatch,
  type SessionIdentityEvidenceIdentity,
  type SessionIdentityEvidenceResult,
} from "./session-accessor.sqlite-entry-availability.js";
import { captureCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { captureIncognitoSessionTopology } from "./session-incognito-binding.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import {
  captureSessionStoreReadCandidate,
  isSessionStoreReadCandidateCurrent,
} from "./session-store-read-candidates.js";
import { prepareSessionStoreTargetInventory } from "./session-store-target-inventory.js";
import { prepareSessionStoreTargetInventoryRead } from "./session-store-target-runtime.js";
import { withSessionHistoryWorkerDatabases } from "./session-transcript-worker-runtime.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

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
  const topology = captureIncognitoSessionTopology();
  const capturedEnv = cloneEnvWithPlatformSemantics(topology?.env ?? process.env);
  const env = { ...capturedEnv, OPENCLAW_STATE_DIR: resolveStateDir(capturedEnv) };
  const probes = input.map((probe) => ({ ...probe }));
  const results: SessionIdentityEvidenceResult[] = probes.map(() => ({ status: "absent" }));
  const incognito = probes.flatMap((probe, index) =>
    isIncognitoSessionKey(probe.sessionKey) ? [{ probe, index }] : [],
  );
  if (topology && incognito.length) {
    const actors = topology.entries.filter((target) =>
      incognito.some(({ probe }) => probe.agentId === target.agentId),
    );
    const checks: Array<() => void> = [];
    const assertCurrent = () => {
      topology.assertCurrent();
      checks.forEach((check) => check());
    };
    const read = async (offset: number): Promise<SessionIdentityEvidenceResult[]> => {
      assertCurrent();
      const target = actors[offset];
      if (!target) {
        const disk = probes.flatMap((probe, index) =>
          !isIncognitoSessionKey(probe.sessionKey) ? [{ probe, index }] : [],
        );
        const evidence = await readPlacementSessionIdentityEvidence(
          cfg,
          disk.map(({ probe }) => probe),
        );
        disk.forEach(({ index }, indexInDisk) => {
          results[index] = evidence[indexInDisk]!;
        });
        assertCurrent();
        return results;
      }
      const actor = await captureOpenClawAgentDatabaseExecution({
        kind: "ephemeral",
        agentId: target.agentId,
        env: topology.env,
        existingOnly: true,
        authority: { assertCurrent: topology.assertCurrent },
      });
      if (!actor || actor.identity.incarnation !== target.identity.incarnation) {
        await actor?.release();
        throw new Error("Incognito placement owner changed during acquisition");
      }
      try {
        return await actor.sessions.withSharedState(async () => {
          const selected = incognito.filter(({ probe }) => probe.agentId === target.agentId);
          const found = await actor.sessions.readIdentities(
            { assertCurrent: topology.assertCurrent },
            { identities: selected.map(({ probe }) => probe) },
          );
          checks.push(found.snapshot.assertCurrent);
          selected.forEach(({ index }, selectedIndex) => {
            results[index] = found.evidence[selectedIndex]!;
          });
          return read(offset + 1);
        });
      } finally {
        await actor.release();
      }
    };
    return read(0).then((result) => {
      topology.assertCurrent();
      return result;
    });
  }
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
  const prepareDisk = () => {
    const { candidates, ...prepared } = prepareSessionStoreTargetInventory(
      cfg,
      disk.map(({ probe }) => probe.agentId),
      env,
    );
    const inventoryRead = prepareSessionStoreTargetInventoryRead({ ...prepared, candidates });
    const nativeReaders = retainOpenClawAgentDatabaseReadCandidates(
      candidates.flatMap((candidate) => [
        candidate,
        { ...candidate, path: candidate.physicalPath },
      ]),
      env,
    );
    return { candidates, prepared, inventoryRead, nativeReaders };
  };
  let diskPreparation: ReturnType<typeof prepareDisk>;
  try {
    diskPreparation = prepareDisk();
  } catch {
    for (const { index } of disk) {
      results[index] = { status: "unknown", reason: "read-failed" };
    }
    readIncognito();
    return results;
  }
  const { candidates, prepared, inventoryRead, nativeReaders } = diskPreparation;
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
  const unsubscribe = sessionChanges.subscribe((change) => {
    if ("all" in change || !change.storePath) {
      changed = true;
      return;
    }
    const pathname = resolveUnsuffixedSqliteTargetFromSessionStorePath(change.storePath).path;
    changed ||= candidates.some(
      (candidate) =>
        matchesAgentDatabaseReadCandidatePath(candidate, pathname) ||
        matchesAgentDatabaseReadCandidatePath(
          { ...candidate, path: candidate.physicalPath },
          pathname,
        ),
    );
  });
  try {
    await inventoryRead.withRead(async (inventory, assertDiscoveryCurrent) => {
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
            sessionKey: normalizeStoreSessionKey(probe.sessionKey),
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
            assertDiscoveryCurrent();
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
    inventoryRead.assertRegistryCurrent();
    for (const candidate of candidates) {
      if (!isSessionStoreReadCandidateCurrent(candidate)) {
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
