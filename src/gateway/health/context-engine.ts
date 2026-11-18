import { listContextEngineQuarantines } from "../../context-engine/registry.js";

/** Projects active context-engine quarantines into the public health shape. */
export async function buildContextEngineHealthSummary() {
  const quarantined = (await listContextEngineQuarantines()).map((entry) => {
    const summary = {
      engineId: entry.engineId,
      operation: entry.operation,
      reason: entry.reason,
      failedAt: entry.failedAt.getTime(),
    };
    return entry.owner ? Object.assign(summary, { owner: entry.owner }) : summary;
  });
  return quarantined.length > 0 ? { quarantined } : undefined;
}
