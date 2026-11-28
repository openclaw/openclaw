// Shared with the Control UI, which names the agent it wants before Add.
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";

const AGENT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export function templateAgentCopyNumber(baseId: string, agentId: string): number {
  const prefix = `${normalizeAgentId(baseId)}-`;
  if (!agentId.startsWith(prefix)) {
    return 1;
  }
  const suffix = agentId.slice(prefix.length);
  const index = Number(suffix);
  return /^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(index) && index >= 2 ? index : 1;
}

export function selectNextTemplateAgentId(
  baseId: string,
  existingAgentIds: Iterable<string>,
): string {
  const normalizedBase = normalizeAgentId(baseId);
  let highest = 0;
  for (const existingId of existingAgentIds) {
    const normalized = normalizeAgentId(existingId);
    if (normalized === normalizedBase) {
      highest = Math.max(highest, 1);
    } else {
      const copy = templateAgentCopyNumber(normalizedBase, normalized);
      if (copy > 1) {
        highest = Math.max(highest, copy);
      }
    }
  }
  if (highest === 0) {
    return normalizedBase;
  }
  const next = `${normalizedBase}-${highest + 1}`;
  if (!Number.isSafeInteger(highest + 1) || next.length > 64) {
    throw new Error(`No portable agent ID remains for ${JSON.stringify(normalizedBase)}.`);
  }
  return next;
}

/** Why Add cannot create an agent under this ID; `openclaw agents add` rejects the same IDs. */
export function templateAgentIdProblem(
  agentId: string,
): { code: string; message: string } | undefined {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    return {
      code: "invalid_agent_id",
      message: `Final agent id ${JSON.stringify(agentId)} is not a valid portable agent id.`,
    };
  }
  if (isReservedSystemAgentId(agentId)) {
    return {
      code: "reserved_agent_id",
      message: `Agent id ${JSON.stringify(agentId)} is reserved for a system agent; choose another agent id.`,
    };
  }
  return undefined;
}
