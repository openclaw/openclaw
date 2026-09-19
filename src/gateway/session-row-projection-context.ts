import { isDeepStrictEqual } from "node:util";
import { getSubagentRegistryPublicationRevision } from "../agents/subagents/registry/subagent-registry-publication.js";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import { buildProjectedAgentRunIndex } from "../infra/agent-run-registry.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import * as records from "./session-row-projection-record.js";
import { buildSessionSwarmSummary } from "./session-swarm-summary.js";
import type { SessionChildLink } from "./session-utils-core.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { refreshSessionRowProfiles } from "./session-utils-row.js";

/** Registry and display facts have their own lifecycle, independent of stored row acquisition. */
export function createSessionRowProjectionContext() {
  let preparedEpoch = -1;
  let registryRevision: number | undefined = getSubagentRegistryPublicationRevision();
  let profileRevision = 0;
  let subagentRevision = 0;
  let parentRevision = 0;
  let placementRevision = 0;
  let modelFactsDirty = false;
  let current = buildSessionListRowMetadataContext({ now: Date.now() });
  const subagentInputs = current.subagentRuns.inputs;
  function prepare(epoch: number) {
    if (preparedEpoch === epoch) {
      return;
    }
    const now = Date.now(),
      revision = getSubagentRegistryPublicationRevision();
    if (registryRevision !== revision) {
      subagentRevision++;
    }
    const subagentRuns =
      registryRevision === revision
        ? current.subagentRuns.atTime(now)
        : buildSubagentSessionListReadIndex(now);
    current = modelFactsDirty
      ? buildSessionListRowMetadataContext({
          now,
          subagentRuns,
          userProfileIdentityById: current.userProfileIdentityById,
        })
      : {
          ...current,
          subagentRuns,
          subagentRunsByChildSessionKey: subagentRuns.runsByChildSessionKey,
        };
    modelFactsDirty = false;
    current.projectedAgentRuns = buildProjectedAgentRunIndex();
    Object.assign(subagentInputs, current.subagentRuns.inputs);
    registryRevision = revision;
    preparedEpoch = epoch;
  }
  return {
    get current() {
      return current;
    },
    subagentInputs,
    placementRevision: () => placementRevision,
    get materializedRevisions() {
      return { profileRevision, subagentRevision };
    },
    /** True means the publication changes only these derived facts. */
    invalidate(change: SessionRowChange): boolean {
      if (!("all" in change)) {
        modelFactsDirty = true;
        return false;
      }
      switch (change.scope) {
        case "profiles":
          current.userProfileIdentityById.clear();
          profileRevision++;
          return true;
        case "subagent-runs":
          registryRevision = undefined;
          return true;
        case "worker-environments":
        case "worker-placements":
          placementRevision++;
          return true;
        case "agent-runs":
        case "sessions":
          // Registries are presented live; stored writes publish their own exact keys.
          return true;
        case "stores":
        case "config":
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
    ) {
      const previous = current.subagentRunsByChildSessionKey;
      prepare(epoch);
      if (parentRevision === subagentRevision) {
        return;
      }
      for (const key of new Set([
        ...previous.keys(),
        ...current.subagentRunsByChildSessionKey.keys(),
      ])) {
        for (const row of matching({ key })) {
          if (!row.storedEntry) {
            continue;
          }
          const parents = records.readSessionRowParents(row, row.storedEntry, cfg, current);
          if (!isDeepStrictEqual(row.parents, parents)) {
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
