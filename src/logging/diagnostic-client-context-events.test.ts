import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDiagnosticRunClientContext,
  normalizeDiagnosticClientContext,
  resetDiagnosticRunClientContextForTest,
  setDiagnosticRunClientContext,
} from "../infra/diagnostic-client-context.js";
import {
  onDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "../infra/diagnostic-events.js";
import { resetDiagnosticSessionStateForTest } from "./diagnostic-session-state.js";
import {
  logMessageQueued,
  logSessionStateChange,
  resetDiagnosticStateForTest,
} from "./diagnostic.js";

const UPSTREAM = normalizeDiagnosticClientContext({
  schemaVersion: "agentweave.context.v1",
  agentId: "Conductor",
});

describe("runId-keyed clientContext seed store", () => {
  beforeEach(() => {
    resetDiagnosticRunClientContextForTest();
  });

  afterEach(() => {
    resetDiagnosticRunClientContextForTest();
  });

  it("resolves a seeded bag by the same runId", () => {
    setDiagnosticRunClientContext("run-a", UPSTREAM);
    expect(getDiagnosticRunClientContext("run-a")).toEqual(UPSTREAM);
    expect(getDiagnosticRunClientContext("run-b")).toBeUndefined();
  });

  it("keeps concurrent same-session runs isolated by runId", () => {
    // Two runs share a session id/key but get distinct runIds. The session id
    // is reusable; the runId is not — so seeding run B must not clobber run A,
    // the exact race the session-scoped slot used to lose.
    const runA = normalizeDiagnosticClientContext({ agentId: "RunA" });
    const runB = normalizeDiagnosticClientContext({ agentId: "RunB" });
    setDiagnosticRunClientContext("run-a", runA);
    setDiagnosticRunClientContext("run-b", runB);

    expect(getDiagnosticRunClientContext("run-a")).toEqual(runA);
    expect(getDiagnosticRunClientContext("run-b")).toEqual(runB);
  });

  it("clears a run's bag when reseeded with undefined", () => {
    setDiagnosticRunClientContext("run-a", UPSTREAM);
    setDiagnosticRunClientContext("run-a", undefined);
    expect(getDiagnosticRunClientContext("run-a")).toBeUndefined();
  });

  it("never seeds when the bag normalizes to undefined (out of bounds)", () => {
    const oversized = normalizeDiagnosticClientContext({ blob: "x".repeat(9000) });
    expect(oversized).toBeUndefined();
    setDiagnosticRunClientContext("run-a", oversized);
    expect(getDiagnosticRunClientContext("run-a")).toBeUndefined();
  });
});

type Capture = {
  /** Events seen by a normal (public) subscriber — never get privateData. */
  publicEvents: DiagnosticEventPayload[];
  /** clientContext delivered per lifecycle event on the trusted channel. */
  trusted: Array<{ type: string; clientContext: unknown }>;
};

function capture(run: () => void): Capture {
  const publicEvents: DiagnosticEventPayload[] = [];
  const trusted: Capture["trusted"] = [];
  const stopPublic = onDiagnosticEvent((event) => {
    publicEvents.push(event);
  });
  const stopTrusted = onTrustedInternalDiagnosticEvent(
    (event, _metadata, privateData: DiagnosticEventPrivateData) => {
      trusted.push({ type: event.type, clientContext: privateData.clientContext });
    },
  );
  try {
    run();
  } finally {
    stopTrusted();
    stopPublic();
  }
  return { publicEvents, trusted };
}

describe("lifecycle events no longer carry clientContext", () => {
  beforeEach(() => {
    setDiagnosticsEnabledForProcess(true);
    resetDiagnosticStateForTest();
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    resetDiagnosticRunClientContextForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticRunClientContextForTest();
    setDiagnosticsEnabledForProcess(false);
  });

  // Regression: clientContext used to ride session.state / message.queued via a
  // session-scoped slot. It now rides the model.call event's privateData keyed
  // by runId, so the lifecycle events must carry no clientContext on either the
  // public payload or the trusted privateData channel — even with a run seeded.
  it("emits session.state / message.queued without clientContext, seeded or not", () => {
    const { publicEvents, trusted } = capture(() => {
      setDiagnosticRunClientContext("run-a", UPSTREAM);
      logSessionStateChange({
        sessionId: "s1",
        sessionKey: "agent:main:paperclip-conductor",
        state: "processing",
      });
      logMessageQueued({ sessionId: "s1", source: "pi-embedded-runner" });
    });

    for (const entry of trusted) {
      expect(entry.clientContext).toBeUndefined();
    }
    for (const event of publicEvents) {
      expect((event as Record<string, unknown>).clientContext).toBeUndefined();
    }
    expect(JSON.stringify(publicEvents)).not.toContain("Conductor");
    expect(JSON.stringify(trusted)).not.toContain("Conductor");
  });
});
