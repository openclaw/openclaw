import { emitAgentEvent } from "../infra/agent-events.js";
import { emitDiagnosticEvent, type DiagnosticEventInput } from "../infra/diagnostic-events.js";
import type { TurnFixture, TurnFixtureEntry } from "./turn-recorder.js";

export type ReplayResult = {
  entriesReplayed: number;
  agentEvents: number;
  diagnosticEvents: number;
  durationMs: number;
};

/**
 * Replays a recorded turn fixture by re-emitting all events in order.
 * Useful for regression testing: listeners attached before replay will
 * see the same event stream as the original turn.
 */
export function replayTurnFixture(fixture: TurnFixture): ReplayResult {
  const startedAt = Date.now();
  let agentEvents = 0;
  let diagnosticEvents = 0;

  for (const entry of fixture.entries) {
    replayEntry(entry);
    if (entry.kind === "agent") {
      agentEvents += 1;
    } else {
      diagnosticEvents += 1;
    }
  }

  return {
    entriesReplayed: fixture.entries.length,
    agentEvents,
    diagnosticEvents,
    durationMs: Date.now() - startedAt,
  };
}

function replayEntry(entry: TurnFixtureEntry): void {
  if (entry.kind === "agent") {
    const { seq: _, ts: __, ...rest } = entry.event;
    const replayEvent: Omit<typeof entry.event, "seq" | "ts"> = rest;
    emitAgentEvent(replayEvent);
  } else {
    const { seq: _, ts: __, ...rest } = entry.event;
    const replayEvent: DiagnosticEventInput = rest;
    emitDiagnosticEvent(replayEvent);
  }
}
