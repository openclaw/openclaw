import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  recordAgentRunModel,
  registerAgentRunContext,
  releaseAgentRunContext,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
  sweepStaleRunContexts,
} from "./agent-run-registry.js";

beforeEach(resetAgentRunRegistryForTest);
afterEach(() => {
  resetAgentRunRegistryForTest();
  vi.restoreAllMocks();
});

it("publishes affected session identities for registration, moves, models, and release", () => {
  const changed = vi.fn();
  const stop = sessionChanges.subscribe(changed);
  const before = { sessionKey: "agent:main:before", agentId: "main" };
  const after = { sessionKey: "agent:other:after", agentId: "other" };
  try {
    registerAgentRunContext("moving", before);
    expect(changed.mock.calls).toEqual([[{ ...before, scope: "runtime" }]]);
    changed.mockClear();

    registerAgentRunContext("moving", after);
    expect(changed.mock.calls).toEqual(
      expect.arrayContaining([[{ ...before, scope: "runtime" }], [{ ...after, scope: "runtime" }]]),
    );
    expect(changed).toHaveBeenCalledTimes(2);
    changed.mockClear();

    recordAgentRunModel("moving", { provider: "openai", model: "test-model" });
    expect(changed.mock.calls).toEqual([[{ ...after, scope: "runtime" }]]);
    changed.mockClear();
    recordAgentRunModel("moving", { provider: "openai", model: "test-model" });
    expect(changed).not.toHaveBeenCalled();

    const claim = claimAgentRunContext("moving", after, { trackOwner: true, ownsContext: true });
    changed.mockClear();
    releaseAgentRunContext("moving", claim);
    expect(changed.mock.calls).toEqual([[{ ...after, scope: "runtime" }]]);
    changed.mockClear();
    clearAgentRunContext("missing");
    expect(changed).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it("invalidates the run projection on lifecycle rotation and orphan cleanup", () => {
  const changed = vi.fn();
  const stop = sessionChanges.subscribe(changed);
  try {
    rotateAgentRunRegistryLifecycleGeneration();
    expect(changed.mock.calls).toEqual([[{ all: true, scope: "agent-runs" }]]);
    registerAgentRunContext("orphan", { sessionKey: "orphan", registeredAt: 1 });
    changed.mockClear();
    expect(sweepStaleRunContexts(1)).toBe(1);
    expect(changed.mock.calls).toEqual([[{ all: true, scope: "agent-runs" }]]);
    changed.mockClear();
    registerAgentRunContext("session-id-only", { agentId: "worker", sessionId: "shared-id" });
    expect(changed.mock.calls).toEqual([[{ all: true, scope: "agent-runs" }]]);
  } finally {
    stop();
  }
});
