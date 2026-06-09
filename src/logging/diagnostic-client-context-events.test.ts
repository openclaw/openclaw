import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeDiagnosticClientContext } from "../infra/diagnostic-client-context.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { resetDiagnosticSessionStateForTest } from "./diagnostic-session-state.js";
import {
  logMessageQueued,
  logSessionStateChange,
  resetDiagnosticStateForTest,
  setDiagnosticSessionClientContext,
} from "./diagnostic.js";

const UPSTREAM = normalizeDiagnosticClientContext({
  schemaVersion: "agentweave.context.v1",
  agentId: "Conductor",
});

function captureEvents(run: () => void): DiagnosticEventPayload[] {
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onDiagnosticEvent((event) => {
    events.push(event);
  });
  try {
    run();
  } finally {
    unsubscribe();
  }
  return events;
}

describe("clientContext propagation onto diagnostic events", () => {
  beforeEach(() => {
    setDiagnosticsEnabledForProcess(true);
    resetDiagnosticStateForTest();
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    setDiagnosticsEnabledForProcess(false);
  });

  it("carries seeded clientContext on session.state events", () => {
    const events = captureEvents(() => {
      setDiagnosticSessionClientContext(
        { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" },
        UPSTREAM,
      );
      logSessionStateChange({
        sessionId: "s1",
        sessionKey: "agent:main:paperclip-conductor",
        state: "processing",
      });
    });

    const stateEvent = events.find((event) => event.type === "session.state");
    expect(stateEvent).toBeDefined();
    expect((stateEvent as Record<string, unknown>).clientContext).toEqual(UPSTREAM);
  });

  it("lets a later message.queued inherit clientContext seeded on the session", () => {
    const events = captureEvents(() => {
      // The gateway handler seeds context keyed by sessionKey before the run
      // emits anything. setActiveEmbeddedRun then emits session.state (with
      // sessionKey), and the queue path emits message.queued by sessionId only
      // — both must inherit the seeded context from the shared session state.
      setDiagnosticSessionClientContext(
        { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" },
        UPSTREAM,
      );
      logSessionStateChange({
        sessionId: "s1",
        sessionKey: "agent:main:paperclip-conductor",
        state: "processing",
      });
      logMessageQueued({ sessionId: "s1", source: "pi-embedded-runner" });
    });

    const queuedEvent = events.find((event) => event.type === "message.queued");
    expect(queuedEvent).toBeDefined();
    expect((queuedEvent as Record<string, unknown>).sessionKey).toBe(
      "agent:main:paperclip-conductor",
    );
    expect((queuedEvent as Record<string, unknown>).clientContext).toEqual(UPSTREAM);
  });

  it("clears stale clientContext when a later same-session run supplies none", () => {
    const ref = { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" };
    const events = captureEvents(() => {
      // First run seeds upstream context.
      setDiagnosticSessionClientContext(ref, UPSTREAM);
      // Later run on the same (reused) diagnostic session has no context.
      setDiagnosticSessionClientContext(ref, undefined);
      logSessionStateChange({ ...ref, state: "processing" });
      logMessageQueued({ sessionId: "s1", source: "dispatch" });
    });

    for (const event of events) {
      expect((event as Record<string, unknown>).clientContext).toBeUndefined();
    }
  });

  it("clears stale clientContext when a later same-session run is out of bounds", () => {
    const ref = { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" };
    // An oversized / invalid bag normalizes to undefined (whole-bag drop).
    const oversized = normalizeDiagnosticClientContext({ blob: "x".repeat(9000) });
    expect(oversized).toBeUndefined();

    const events = captureEvents(() => {
      setDiagnosticSessionClientContext(ref, UPSTREAM);
      setDiagnosticSessionClientContext(ref, oversized);
      logSessionStateChange({ ...ref, state: "processing" });
    });

    const stateEvent = events.find((event) => event.type === "session.state");
    expect(stateEvent).toBeDefined();
    expect((stateEvent as Record<string, unknown>).clientContext).toBeUndefined();
  });

  it("omits clientContext for sessions without an upstream context", () => {
    const events = captureEvents(() => {
      logSessionStateChange({
        sessionId: "s2",
        sessionKey: "agent:main:main",
        state: "processing",
      });
      logMessageQueued({ sessionId: "s2", sessionKey: "agent:main:main", source: "dispatch" });
    });

    for (const event of events) {
      expect((event as Record<string, unknown>).clientContext).toBeUndefined();
    }
  });
});
