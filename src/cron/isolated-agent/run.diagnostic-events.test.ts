import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onDiagnosticEvent, resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.js";

vi.mock("../../agents/auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: vi.fn(() => false),
}));

import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "cron-diag-events",
      name: "Diag Events",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "isolated" as const,
      state: {},
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "run task" },
    },
    message: "run task",
    sessionKey: "cron:diag-events",
  };
}

type EventRecord = {
  type: string;
  sessionKey?: string;
  sessionId?: string;
  source?: string;
  state?: string;
  outcome?: string;
};

describe("runCronIsolatedAgentTurn diagnostic events", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("emits a paired queued/processing/idle/processed lifecycle for an isolated cron run", async () => {
    const events: EventRecord[] = [];
    const unsubscribe = onDiagnosticEvent((evt) => {
      const e = evt as EventRecord;
      if (
        e.type === "message.queued" ||
        e.type === "session.state" ||
        e.type === "message.processed"
      ) {
        events.push(e);
      }
    });

    try {
      const result = await runCronIsolatedAgentTurn(makeParams());
      expect(result.status).toBe("ok");
    } finally {
      unsubscribe();
    }

    const ofType = (type: string) => events.filter((e) => e.type === type);
    expect(ofType("message.queued")).toHaveLength(1);
    expect(ofType("message.queued")[0]?.source).toBe("cron-isolated");

    const stateEvents = ofType("session.state");
    expect(stateEvents.map((e) => e.state)).toEqual(["processing", "idle"]);

    const processed = ofType("message.processed");
    expect(processed).toHaveLength(1);
    expect(processed[0]?.outcome).toBe("completed");

    const queuedKey = ofType("message.queued")[0]?.sessionKey;
    expect(queuedKey).toBeTruthy();
    for (const e of events) {
      expect(e.sessionKey).toBe(queuedKey);
    }

    const orderedTypes = events.map((e) => e.type);
    expect(orderedTypes[0]).toBe("message.queued");
    expect(orderedTypes[orderedTypes.length - 1]).toBe("message.processed");
    expect(orderedTypes).toContain("session.state");
  });

  it("emits no lifecycle events when diagnostics.enabled is false", async () => {
    const events: EventRecord[] = [];
    const unsubscribe = onDiagnosticEvent((evt) => {
      const e = evt as EventRecord;
      if (
        e.type === "message.queued" ||
        e.type === "session.state" ||
        e.type === "message.processed"
      ) {
        events.push(e);
      }
    });

    try {
      const params = makeParams();
      params.cfg = { diagnostics: { enabled: false } } as never;
      const result = await runCronIsolatedAgentTurn(params);
      expect(result.status).toBe("ok");
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([]);
  });
});
