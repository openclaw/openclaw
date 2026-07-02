import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeDiagnosticClientContext } from "../infra/diagnostic-client-context.js";
import {
  onDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "../infra/diagnostic-events.js";
import {
  resetRunClientContextForTest,
  setRunClientContext,
} from "../infra/diagnostic-run-attribution.js";
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
const OTHER = normalizeDiagnosticClientContext({
  schemaVersion: "agentweave.context.v1",
  agentId: "Soloist",
});

const SESSION = { sessionKey: "agent:main:paperclip-conductor", sessionId: "s1" };

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
  // The grant-backed trusted channel (exposed to diagnostics exporters via
  // `ctx.internalDiagnostics.onEvent`) is the only path that receives privateData.
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

describe("clientContext propagation onto diagnostic events", () => {
  beforeEach(() => {
    setDiagnosticsEnabledForProcess(true);
    resetDiagnosticStateForTest();
    resetDiagnosticSessionStateForTest();
    resetRunClientContextForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetRunClientContextForTest();
    setDiagnosticsEnabledForProcess(false);
  });

  it("delivers a run's clientContext as privateData on session.state, never on the public payload", () => {
    const { publicEvents, trusted } = capture(() => {
      // The gateway binds context to the run's id at admission; the run's
      // lifecycle events then carry it by passing that runId.
      setRunClientContext("run-1", UPSTREAM);
      logSessionStateChange({ ...SESSION, state: "processing", runId: "run-1" });
    });

    // Trusted observer gets the bag.
    expect(trusted).toEqual([{ type: "session.state", clientContext: UPSTREAM }]);
    // Public observer still sees the lifecycle event, but with no clientContext.
    const publicState = publicEvents.find((event) => event.type === "session.state");
    expect(publicState).toBeDefined();
    expect((publicState as Record<string, unknown>).clientContext).toBeUndefined();
    expect(JSON.stringify(publicEvents)).not.toContain("Conductor");
  });

  it("lets a run's later message.queued inherit its clientContext on the trusted channel", () => {
    const { trusted } = capture(() => {
      setRunClientContext("run-1", UPSTREAM);
      logSessionStateChange({ ...SESSION, state: "processing", runId: "run-1" });
      logMessageQueued({ sessionId: "s1", source: "embedded-agent-runner", runId: "run-1" });
    });

    expect(trusted).toEqual([
      { type: "session.state", clientContext: UPSTREAM },
      { type: "message.queued", clientContext: UPSTREAM },
    ]);
  });

  it("isolates two differently attributed runs on the same session", () => {
    // The race the run-scoping closes: two accepted requests on one session with
    // different upstream identities. Each run's events must carry only its own
    // context — a later admission cannot overwrite an in-flight run's value
    // because the contexts live under distinct runIds, not a shared session slot.
    const { trusted } = capture(() => {
      setRunClientContext("run-A", UPSTREAM);
      setRunClientContext("run-B", OTHER);
      // Interleave the two runs' lifecycle events on the same session.
      logSessionStateChange({ ...SESSION, state: "processing", runId: "run-A" });
      logMessageQueued({ sessionId: "s1", source: "embedded-agent-runner", runId: "run-B" });
      logMessageQueued({ sessionId: "s1", source: "embedded-agent-runner", runId: "run-A" });
      logSessionStateChange({ ...SESSION, state: "processing", runId: "run-B" });
    });

    expect(trusted).toEqual([
      { type: "session.state", clientContext: UPSTREAM },
      { type: "message.queued", clientContext: OTHER },
      { type: "message.queued", clientContext: UPSTREAM },
      { type: "session.state", clientContext: OTHER },
    ]);
  });

  it("omits clientContext for a run whose context was rejected as out of bounds", () => {
    // An oversized / invalid bag normalizes to undefined (whole-bag drop), so the
    // run is seeded with no context.
    const oversized = normalizeDiagnosticClientContext({ blob: "x".repeat(9000) });
    expect(oversized).toBeUndefined();

    const { trusted } = capture(() => {
      setRunClientContext("run-1", oversized);
      logSessionStateChange({ ...SESSION, state: "processing", runId: "run-1" });
    });

    const stateEntry = trusted.find((entry) => entry.type === "session.state");
    expect(stateEntry).toBeDefined();
    expect(stateEntry?.clientContext).toBeUndefined();
  });

  it("drops a run's clientContext when it completes (session idle), bounding it to the run", () => {
    const { trusted } = capture(() => {
      setRunClientContext("run-1", UPSTREAM);
      logSessionStateChange({ ...SESSION, state: "processing", runId: "run-1" });
      // Run completes: the idle event still carries the completing run's context...
      logSessionStateChange({ ...SESSION, state: "idle", reason: "run_completed", runId: "run-1" });
      // ...but a later event for the same runId on the reused session must not
      // inherit it — the registry entry was dropped on idle.
      logMessageQueued({ sessionId: "s1", source: "dispatch", runId: "run-1" });
    });

    // processing + idle both attribute to the completing run.
    const stateEntries = trusted.filter((entry) => entry.type === "session.state");
    expect(stateEntries.map((entry) => entry.clientContext)).toEqual([UPSTREAM, UPSTREAM]);
    // The trailing message.queued saw cleared context (bounded to the run).
    const queued = trusted.find((entry) => entry.type === "message.queued");
    expect(queued?.clientContext).toBeUndefined();
  });

  it("omits clientContext for runs without an upstream context", () => {
    const { publicEvents, trusted } = capture(() => {
      logSessionStateChange({
        sessionId: "s2",
        sessionKey: "agent:main:main",
        state: "processing",
        runId: "run-unseeded",
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
