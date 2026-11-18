import { afterEach, assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import * as runs from "./agent-run-registry.js";

const changed = vi.fn();
const projectionChange = { all: true, scope: "agent-runs" } as const;
beforeEach(() => {
  runs.resetAgentRunRegistryForTest();
  changed.mockClear();
  onTestFinished(sessionChanges.subscribe(changed));
});
afterEach(runs.resetAgentRunRegistryForTest);
function expectChanges(...events: SessionRowChange[]) {
  expect(changed.mock.calls).toEqual(events.map((event) => [event]));
  changed.mockClear();
}

it("publishes affected session identities for registration, moves, models, and release", () => {
  const before = { sessionKey: "agent:main:before", agentId: "main" };
  const after = { sessionKey: "agent:other:after", agentId: "other" };
  runs.registerAgentRunContext("moving", before);
  expectChanges({ ...before, scope: "runtime" });
  runs.registerAgentRunContext("moving", { ...before, sessionId: "admitted-session" });
  expectChanges({ ...before, scope: "runtime" });
  runs.registerAgentRunContext("moving", after);
  expectChanges({ ...before, scope: "runtime" }, { ...after, scope: "runtime" });
  runs.recordAgentRunModel("moving", { provider: "openai", model: "test-model" });
  expectChanges({ ...after, scope: "runtime" });
  runs.recordAgentRunModel("moving", { provider: "openai", model: "test-model" });
  expectChanges();
  const claim = runs.claimAgentRunContext("moving", after, { trackOwner: true, ownsContext: true });
  changed.mockClear();
  runs.releaseAgentRunContext("moving", claim);
  expectChanges({ ...after, scope: "runtime" });
  runs.clearAgentRunContext("missing");
  expectChanges();
});

it("invalidates the run projection on lifecycle rotation and orphan cleanup", () => {
  runs.rotateAgentRunRegistryLifecycleGeneration();
  expectChanges(projectionChange);
  runs.registerAgentRunContext("orphan", { sessionKey: "orphan", registeredAt: 1 });
  changed.mockClear();
  expect(runs.sweepStaleRunContexts(1)).toBe(1);
  expectChanges(projectionChange);
});

it("retains both session identities when an ID-only run moves, then releases only its current identity", () => {
  const before = { agentId: "worker", sessionId: "before" };
  const after = { agentId: "worker", sessionId: "after" };
  const notification = (runtimeSession: typeof before) => ({ ...projectionChange, runtimeSession });
  runs.registerAgentRunContext("session-id-only", before);
  expectChanges(notification(before));
  runs.registerAgentRunContext("session-id-only", after);
  expectChanges(notification(before), notification(after));
  runs.clearAgentRunContext("session-id-only");
  expectChanges(notification(after));
});

it("retains model request numbering across run metadata updates and resets fresh registrations", () => {
  const stale = { value: 99 };
  runs.registerAgentRunContext("retry", { sessionKey: "session", modelCallSequence: stale });
  const sequence = runs.getAgentRunContext("retry")?.modelCallSequence;
  expect(sequence).toEqual({ value: 0 });
  expect(sequence).not.toBe(stale);
  assert(sequence, "registered run must own its model request sequence");
  sequence.value += 1;
  runs.registerAgentRunContext("retry", { sessionKey: "session", modelCallSequence: { value: 0 } });
  runs.claimAgentRunContext("retry", { sessionKey: "session" });
  expect(runs.getAgentRunContext("retry")?.modelCallSequence).toBe(sequence);
  expect(sequence.value).toBe(1);

  runs.clearAgentRunContext("retry");
  runs.registerAgentRunContext("retry", { sessionKey: "session", modelCallSequence: sequence });
  expect(runs.getAgentRunContext("retry")?.modelCallSequence).toEqual({ value: 0 });
  expect(runs.getAgentRunContext("retry")?.modelCallSequence).not.toBe(sequence);

  const lifecycleGeneration = runs.rotateAgentRunRegistryLifecycleGeneration();
  runs.claimAgentRunContext("retry", { lifecycleGeneration, modelCallSequence: sequence });
  expect(runs.getAgentRunContext("retry")?.modelCallSequence).toEqual({ value: 0 });
  expect(runs.getAgentRunContext("retry")?.modelCallSequence).not.toBe(sequence);
});
