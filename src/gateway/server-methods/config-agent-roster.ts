import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { readAgentRosterProperty } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { RespondFn } from "./types.js";

function listExplicitAgentRosterIds(config: OpenClawConfig): string[] {
  const roster = readAgentRosterProperty(config);
  if (roster?.kind === "entries" && isRecord(roster.value)) {
    return Object.keys(roster.value);
  }
  if (roster?.kind !== "list" || !Array.isArray(roster.value)) {
    return [];
  }
  return roster.value.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
  );
}

export function rejectDroppedAgentRosterEntries(params: {
  currentConfig: OpenClawConfig;
  submittedConfig: OpenClawConfig;
  respond: RespondFn;
}): boolean {
  const submittedIds = new Set(
    listExplicitAgentRosterIds(params.submittedConfig).map((agentId) => normalizeAgentId(agentId)),
  );
  const droppedIds = listExplicitAgentRosterIds(params.currentConfig)
    .filter((agentId) => !submittedIds.has(normalizeAgentId(agentId)))
    .toSorted();
  if (droppedIds.length === 0) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `config.set would remove existing agent entries: ${droppedIds.join(", ")}. ` +
        "Use the agents.delete RPC or `openclaw agents delete <id>` for intentional deletion.",
    ),
  );
  return true;
}

/** A keyed null is explicit deletion intent; omissions and parent removal are not. */
export function listPatchedAgentRosterRemovals(
  source: OpenClawConfig,
  patch: OpenClawConfig,
): string[] {
  return Object.entries(patch.agents?.entries ?? {})
    .filter(([id, entry]) => entry === null && Object.hasOwn(source.agents?.entries ?? {}, id))
    .map(([id]) => id);
}
