import { getSubagentRegistryPublicationRevision } from "../agents/subagents/registry/subagent-registry-publication.js";
import { createSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read-index.js";
import type { SubagentSessionListReadView } from "../agents/subagents/registry/subagent-registry-state.js";
import {
  buildProjectedAgentRunIndex,
  readAgentRunIndexVersion,
} from "../infra/agent-run-registry.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { createSessionIdentityProjection } from "./session-identity-projection.js";
import * as records from "./session-row-projection-record.js";
import { buildSessionSwarmSummary } from "./session-swarm-summary.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import type { SessionChildLink } from "./session-utils-core.js";
import {
  buildProjectedSubagentActivity,
  buildSessionListRowMetadataContext,
} from "./session-utils-projection.js";
import { refreshSessionRowProfiles } from "./session-utils-row.js";

/** Registry and display facts have their own lifecycle, independent of stored row acquisition. */
export function createSessionRowProjectionContext(subagents: SubagentSessionListReadView) {
  let preparedEpoch = -1;
  let registryRevision: number | undefined = getSubagentRegistryPublicationRevision();
  let registrySnapshot = subagents.snapshotIdentity();
  let agentRunRevision = readAgentRunIndexVersion();
  let profileRevision = 0;
  let subagentRevision = 0;
  let parentRevision = 0;
  let modelFactsDirty = false;
  const identityProjection = createSessionIdentityProjection();
  const initialNow = Date.now();
  const subagentIndex = createSubagentSessionListReadIndex(subagents, initialNow);
  let current = {
    ...buildSessionListRowMetadataContext({
      now: initialNow,
      subagentRuns: subagentIndex.read(initialNow),
    }),
    identityProjection,
  };
  const subagentInputs = current.subagentRuns.inputs;
  function prepare(epoch: number) {
    const snapshot = subagents.snapshotIdentity();
    const revision = getSubagentRegistryPublicationRevision();
    const runRevision = readAgentRunIndexVersion();
    if (
      preparedEpoch === epoch &&
      registrySnapshot === snapshot &&
      registryRevision === revision &&
      agentRunRevision === runRevision
    ) {
      return;
    }
    if (registrySnapshot !== snapshot) {
      registryRevision = undefined;
      registrySnapshot = snapshot;
    }
    const now = Date.now();
    const previousIndexRevision = subagentIndex.revision;
    const subagentRuns = subagentIndex.read(now);
    const subagentChanged = previousIndexRevision !== subagentIndex.revision;
    if (subagentChanged || registryRevision === undefined) {
      subagentRevision++;
    }
    // Keep maps local to this projection; independent builders still own fresh indexes.
    const projectedAgentRuns =
      agentRunRevision === runRevision ? current.projectedAgentRuns : buildProjectedAgentRunIndex();
    const projectedSubagentActivity =
      projectedAgentRuns === current.projectedAgentRuns && !subagentChanged
        ? current.projectedSubagentActivity
        : buildProjectedSubagentActivity(subagentRuns, projectedAgentRuns);
    current = modelFactsDirty
      ? {
          ...buildSessionListRowMetadataContext({
            now,
            subagentRuns,
            projectedAgentRuns,
            projectedSubagentActivity,
            userProfileIdentityById: current.userProfileIdentityById,
          }),
          identityProjection,
        }
      : {
          ...current,
          subagentRuns,
          projectedAgentRuns,
          projectedSubagentActivity,
          subagentRunsByChildSessionKey: subagentRuns.runsByChildSessionKey,
        };
    modelFactsDirty = false;
    Object.assign(subagentInputs, current.subagentRuns.inputs);
    registryRevision = revision;
    agentRunRevision = runRevision;
    preparedEpoch = epoch;
  }
  return {
    dispose: subagentIndex.dispose,
    readPrepared(epoch: number): SessionListRowContext | undefined {
      return preparedEpoch === epoch &&
        parentRevision === subagentRevision &&
        agentRunRevision === readAgentRunIndexVersion() &&
        registryRevision === getSubagentRegistryPublicationRevision() &&
        registrySnapshot === subagents.snapshotIdentity()
        ? current
        : undefined;
    },
    get current(): SessionListRowContext {
      return current;
    },
    subagentInputs,
    get materializedRevisions() {
      return { profileRevision, subagentRevision };
    },
    /** True means the publication changes only these derived facts. */
    invalidate(change: SessionRowChange): boolean {
      if (!("all" in change)) {
        if (change.scope === "runtime" && !change.facts && !change.factsInvalidated) {
          return true;
        }
        modelFactsDirty = true;
        return false;
      }
      switch (change.scope) {
        case "profiles":
          current.userProfileIdentityById.clear();
          identityProjection.invalidate();
          profileRevision++;
          return true;
        case "subagent-runs":
          return true;
        case "worker-environments":
        case "worker-placements":
          return true;
        case "agent-runs":
        case "sessions":
          // Registries are presented live; stored writes publish their own exact keys.
          return true;
        case "stores":
        case "config":
          identityProjection.invalidate();
          registryRevision = undefined;
      }
      modelFactsDirty = true;
      return false;
    },
    prepare(
      epoch: number,
      cfg: records.Inputs["cfg"],
      matching: (query: { key: string }) => records.Row[],
      put: (row: records.Row) => void,
      referenced: (reference: string) => records.Row | undefined,
    ) {
      const broad = registryRevision === undefined;
      prepare(epoch);
      if (parentRevision === subagentRevision) {
        return;
      }
      for (const key of broad
        ? current.subagentRunsByChildSessionKey.keys()
        : subagentIndex.changedChildren) {
        for (const row of matching({ key })) {
          if (!row.storedEntry) {
            continue;
          }
          const parents = records.readSessionRowParents(
            row,
            row.storedEntry,
            cfg,
            current,
            referenced,
          );
          if (!records.sameParents(row.parents, parents)) {
            put({ ...row, parents });
          }
        }
      }
      parentRevision = subagentRevision;
    },
    preparePresentation(
      row: records.MaterializedRow,
      readChildLinks: (row: records.Row) => SessionChildLink[],
    ) {
      if (row.profileRevision !== profileRevision) {
        refreshSessionRowProfiles(row.materialized);
        row.profileRevision = profileRevision;
      }
      if (row.subagentRevision !== subagentRevision) {
        row.materialized.source.childLinks = readChildLinks(row);
        row.materialized.row.swarm = buildSessionSwarmSummary(
          current.subagentRuns.swarmRunsByRequesterSessionKey.get(row.key) ?? [],
          row.key,
          row.agentId,
          { includeChildren: true },
        );
        row.subagentRevision = subagentRevision;
      }
    },
  };
}
