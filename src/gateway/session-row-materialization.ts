import { isDeepStrictEqual } from "node:util";
import {
  recordSessionRowMaterialization,
  recordSessionRowMaterializationDifference,
} from "../infra/gateway-work-metrics.js";
import type { MaterializedRow, Row } from "./session-row-projection-record.js";
import { reuseSessionRowChildLinks } from "./session-utils-projection.js";
import { materializeSessionRow, type readSessionRowInputs } from "./session-utils-row.js";

export function materializeSessionRowIfChanged(
  record: Row,
  input: ReturnType<typeof readSessionRowInputs>["inputs"],
  membership: Row["membership"],
  revisions: { profileRevision: number; subagentRevision: number },
) {
  if (sessionRowMaterializationMatches(record, input, membership, revisions)) {
    recordSessionRowMaterialization("skipped", false);
    return record.materialized;
  }
  const next = materializeSessionRow(input);
  const previous = record.materialized;
  const deepCompared =
    previous !== undefined &&
    membership === record.membership &&
    previous.source.entry === input.entry &&
    previous.source.cfg === input.cfg;
  const materialized = deepCompared && isDeepStrictEqual(previous, next) ? previous : next;
  if (
    recordSessionRowMaterialization(
      !previous ? "created" : materialized === previous ? "reused" : "rebuilt",
      deepCompared,
    ) &&
    previous
  ) {
    // SAFETY: materializeSessionRow owns this source shape; these are its enumerable field keys.
    const field = (Object.keys(next.source) as (keyof typeof next.source)[]).find(
      (key) => !isDeepStrictEqual(previous.source[key], next.source[key]),
    );
    recordSessionRowMaterializationDifference(field ?? "row-or-membership");
  }
  return materialized;
}

const equal = (left: unknown, right: unknown) =>
  Object.is(left, right) ||
  (typeof left === "object" && left !== null && isDeepStrictEqual(left, right));

/** Resolved inputs stay live; compare against the existing graph instead of retaining a second one. */
function sessionRowMaterializationMatches(
  record: Row,
  input: ReturnType<typeof readSessionRowInputs>["inputs"],
  membership: Row["membership"],
  revisions: { profileRevision: number; subagentRevision: number },
): record is MaterializedRow {
  if (
    !record.materialized ||
    record.membership !== membership ||
    // Native auth affects the model revision even when the displayed model is unchanged.
    !record.facts?.matchesRuntimeOwnership(input.preparedRuntimeOwnership) ||
    record.profileRevision !== revisions.profileRevision ||
    record.subagentRevision !== revisions.subagentRevision
  ) {
    return false;
  }
  const { row, source } = record.materialized;
  const thinking = input.thinkingProjection;
  return (
    source.cfg === input.cfg &&
    source.entry === input.entry &&
    row.key === input.key &&
    row.agentId === input.agentId &&
    source.lightweight === input.lightweight &&
    source.userProfileIdentityById === input.userProfileIdentityById &&
    source.identityProjection === input.identityProjection &&
    source.subagentRunInputs === input.subagentRunInputs &&
    equal(source.configuredAgentIds, input.configuredAgentIds) &&
    equal(source.selectedModel, input.selectedModel) &&
    equal(source.rowModelIdentity, input.rowModelIdentity) &&
    equal(source.thinkingProjection.acpMeta, thinking.acpMeta) &&
    equal(source.thinkingProjection.agentRuntime, thinking.agentRuntime) &&
    row.thinkingLevel === thinking.thinkingLevel &&
    equal(row.thinkingLevels, thinking.thinkingLevels) &&
    equal(row.thinkingOptions, thinking.thinkingOptions) &&
    row.thinkingDefault === thinking.thinkingDefault &&
    row.runtimeSelectionLocked === thinking.runtimeSelectionLocked &&
    equal(row.agentRuntime, input.agentRuntime) &&
    row.contextWindow === input.contextWindowProfile.contextWindow &&
    equal(row.contextWindows, input.contextWindowProfile.contextWindows) &&
    row.contextWindowDefault === input.contextWindowProfile.contextWindowDefault &&
    row.contextTokens === input.contextTokens &&
    row.effectiveFastMode === input.fastModeState.mode &&
    row.effectiveFastModeSource === input.fastModeState.source &&
    row.fastAutoOnSeconds === input.fastModeState.fastAutoOnSeconds &&
    row.permissionModePending === input.permissionModePending &&
    row.hasAutomation === input.hasAutomation &&
    equal(row.repository, input.repository) &&
    equal(row.swarm, input.includeSwarmSummary ? input.swarm : undefined) &&
    row.displayName === input.displayName &&
    row.derivedTitle === input.derivedTitle &&
    row.lastMessagePreview === input.lastMessagePreview &&
    source.lastMessagePreview === input.lastMessagePreview &&
    equal(row.lastAssistantMessage, input.lastAssistantMessage) &&
    equal(source.lastAssistantMessage, input.lastAssistantMessage) &&
    equal(
      row.pluginExtensions,
      input.pluginExtensions.length ? input.pluginExtensions : undefined,
    ) &&
    equal(source.usageByFallbackModel, input.usageByFallbackModel) &&
    source.freshSessionTotalTokens === input.freshSessionTotalTokens &&
    source.estimatedCostUsd === input.estimatedCostUsd &&
    (source.childLinks === input.childLinks ||
      (input.childLinks !== undefined &&
        reuseSessionRowChildLinks(input.childLinks, source.childLinks) === source.childLinks))
  );
}
