import { createSessionActivityNoteState } from "../agents/session-activity-notes.js";
import type { SessionObserverState } from "./session-observer-model.js";

export function observerState(overrides: Partial<SessionObserverState> = {}): SessionObserverState {
  return {
    ...createSessionActivityNoteState(),
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    agentId: "main",
    utilityModelRef: "openai/gpt-test",
    startedAt: 0,
    lastActivityAt: 0,
    lastRunAt: 0,
    revision: 0,
    digestCount: 0,
    consecutiveFailures: 0,
    lastDigestNoteSequence: 0,
    inFlight: false,
    finalPending: false,
    ...overrides,
  };
}
