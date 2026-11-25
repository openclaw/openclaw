import assert from "node:assert/strict";
import type { SessionActivitySummaryBatchResult } from "./activity-summary-source.types.js";
import type {
  SessionActorCommandContext,
  SessionActorPhaseInputs,
} from "./session-actor-contract.js";

type Turn = Extract<SessionActorPhaseInputs["appendToolResult"], { turn: unknown }>["turn"];

export function transcriptTurnCommand(
  scope: Pick<Turn, "agentId" | "sessionKey"> & { sessionId: string },
  commandId: string,
  messages: Turn["options"]["messages"],
): Pick<SessionActorCommandContext, "commandId" | "phaseId"> & { turn: Turn } {
  return {
    commandId,
    phaseId: "turn",
    turn: {
      agentId: scope.agentId,
      sessionKey: scope.sessionKey,
      options: { expectedSessionId: scope.sessionId, sessionFile: "synthetic.jsonl", messages },
    },
  };
}

export function summaryFacts(source: SessionActivitySummaryBatchResult) {
  assert(source, "Expected an activity summary source");
  return {
    previous: source.previous,
    watermark: source.watermark,
    covered: source.covered,
    omitted: source.omitted,
    totalMessages: source.snapshot.totalMessages,
    activeLeafEntryId: source.snapshot.activeLeafEntryId,
    generation: source.snapshot.snapshot.generation,
    events: source.page.events.map(({ event }) => event),
    scannedMessages: source.page.scannedMessages,
  };
}
