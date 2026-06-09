import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeDiagnosticClientContext } from "../infra/diagnostic-client-context.js";
import {
  onDiagnosticEvent,
  onTrustedDiagnosticEvent,
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
  setDiagnosticSessionClientContext,
} from "./diagnostic.js";

const UPSTREAM = normalizeDiagnosticClientContext({
  schemaVersion: "agentweave.context.v1",
  agentId: "Conductor",
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
  const stopTrusted = onTrustedDiagnosticEvent((event, privateData: DiagnosticEventPrivateData) => {
    trusted.push({ type: event.type, clientContext: privateData.clientContext });
  });
  try {
    run();
  } finally {
    stopTrusted();
    stopPublic();
  }
  return { publicEvents, trusted };
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

  it("delivers seeded clientContext as privateData on session.state, never on the public payload", () => {
    const { publicEvents, trusted } = capture(() => {
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

    // Trusted observer gets the bag.
    expect(trusted).toEqual([{ type: "session.state", clientContext: UPSTREAM }]);
    // Public observer still sees the lifecycle event, but with no clientContext.
    const publicState = publicEvents.find((event) => event.type === "session.state");
    expect(publicState).toBeDefined();
    expect((publicState as Record<string, unknown>).clientContext).toBeUndefined();
    expect(JSON.stringify(publicEvents)).not.toContain("Conductor");
  });

  it("lets a later message.queued inherit seeded clientContext on the trusted channel", () => {
    const { trusted } = capture(() => {
      // The gateway handler seeds context keyed by sessionKey before the run
      // emits anything. setActiveEmbeddedRun then emits session.state (with
      // sessionKey), and the queue path emits message.queued by sessionId only
      // — both inherit the seeded context from the shared session state.
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

    expect(trusted).toEqual([
      { type: "session.state", clientContext: UPSTREAM },
      { type: "message.queued", clientContext: UPSTREAM },
    ]);
  });

  it("clears stale clientContext when a later same-session run supplies none", () => {
    const ref = { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" };
    const { trusted } = capture(() => {
      // First run seeds upstream context.
      setDiagnosticSessionClientContext(ref, UPSTREAM);
      // Later run on the same (reused) diagnostic session has no context.
      setDiagnosticSessionClientContext(ref, undefined);
      logSessionStateChange({ ...ref, state: "processing" });
      logMessageQueued({ sessionId: "s1", source: "dispatch" });
    });

    for (const entry of trusted) {
      expect(entry.clientContext).toBeUndefined();
    }
  });

  it("clears stale clientContext when a later same-session run is out of bounds", () => {
    const ref = { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" };
    // An oversized / invalid bag normalizes to undefined (whole-bag drop).
    const oversized = normalizeDiagnosticClientContext({ blob: "x".repeat(9000) });
    expect(oversized).toBeUndefined();

    const { trusted } = capture(() => {
      setDiagnosticSessionClientContext(ref, UPSTREAM);
      setDiagnosticSessionClientContext(ref, oversized);
      logSessionStateChange({ ...ref, state: "processing" });
    });

    const stateEntry = trusted.find((entry) => entry.type === "session.state");
    expect(stateEntry).toBeDefined();
    expect(stateEntry?.clientContext).toBeUndefined();
  });

  it("omits clientContext for sessions without an upstream context", () => {
    const { publicEvents, trusted } = capture(() => {
      logSessionStateChange({
        sessionId: "s2",
        sessionKey: "agent:main:main",
        state: "processing",
      });
      logMessageQueued({ sessionId: "s2", sessionKey: "agent:main:main", source: "dispatch" });
    });

    for (const entry of trusted) {
      expect(entry.clientContext).toBeUndefined();
    }
    for (const event of publicEvents) {
      expect((event as Record<string, unknown>).clientContext).toBeUndefined();
    }
  });
});
