import { normalizeAgentId } from "../routing/session-key.js";

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
