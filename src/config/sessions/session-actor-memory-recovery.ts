import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import { createHarnessCompletionInputPredicate } from "./session-harness-completion-input.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

/** Recovery consumes active history, including inputs omitted from model context. */
export function validateSessionActorMemoryRecoveryInput(
  state: SessionActorMemoryState,
  claim: HarnessCompletionRecovery,
): boolean {
  const entry = state.hot.entry;
  if (!entry || entry.restartRecoveryDeliveryRunId === claim.sourceRunId) {
    return true;
  }
  const source = state.hot.transcript.idempotency.find(
    ({ key }) => key === `${claim.sourceRunId}:user`,
  );
  if (!source) {
    return false;
  }
  const tree = scanSessionTranscriptTree(state.events.map((row) => row.event));
  if (tree.hasInvalidLeafControl) {
    return false;
  }
  const active = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  const start = active.findIndex((node) => state.events[node.index]?.rawSeq === source.rawSeq);
  const reset = active.findLastIndex((node) => asOptionalRecord(node.entry)?.type === "reset");
  // Reset-kept messages remain display history; compaction alone does not retire recovery.
  if (start < 0 || start <= reset) {
    return false;
  }
  const accepts = createHarnessCompletionInputPredicate({
    claim,
    entry,
    operationalRunId: entry.restartRecoveryDeliveryRunId,
  });
  let seen = false;
  for (const node of active.slice(start)) {
    const message = asOptionalRecord(asOptionalRecord(node.entry)?.message);
    if (message?.role !== "user") {
      continue;
    }
    seen = true;
    if (!accepts(message)) {
      return false;
    }
  }
  return seen;
}
