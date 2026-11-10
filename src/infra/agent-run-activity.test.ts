import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { observeAgentRunActivity } from "./agent-run-activity.js";
import {
  claimAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
  releaseAgentRunContext,
  resetAgentRunRegistryForTest,
  retainQueuedAgentRunContext,
  rotateAgentRunRegistryLifecycleGeneration,
} from "./agent-run-registry.js";

beforeEach(resetAgentRunRegistryForTest);
afterEach(resetAgentRunRegistryForTest);

it("reports existing execution ownership and waits for the last same-agent release", () => {
  const first = claimAgentRunContext("first", { agentId: "main" }, { trackOwner: true });
  const listener = vi.fn<(busy: boolean) => void>();
  const unsubscribe = observeAgentRunActivity("MAIN", listener);
  onTestFinished(unsubscribe);
  expect(listener.mock.calls).toEqual([[true]]);

  const other = claimAgentRunContext("other", { agentId: "other" }, { trackOwner: true });
  const second = claimAgentRunContext(
    "second",
    { sessionKey: "agent:main:chat:second" },
    { trackOwner: true },
  );
  releaseAgentRunContext("first", first);
  expect(listener.mock.calls).toEqual([[true]]);
  releaseAgentRunContext("second", second);
  expect(listener.mock.calls).toEqual([[true], [false]]);
  releaseAgentRunContext("other", other);
  expect(listener.mock.calls).toEqual([[true], [false]]);

  unsubscribe();
  claimAgentRunContext("unobserved", { agentId: "main" }, { trackOwner: true });
  expect(listener.mock.calls).toEqual([[true], [false]]);
});

it("counts queued leases but ignores retained display-only activity", () => {
  registerAgentRunContext("queued", {
    agentId: "main",
    sessionKey: "agent:main:chat:queued",
    projectSessionActive: true,
  });
  const listener = vi.fn<(busy: boolean) => void>();
  onTestFinished(observeAgentRunActivity("main", listener));
  expect(listener.mock.calls).toEqual([[false]]);

  const releaseFirst = retainQueuedAgentRunContext("queued", getAgentRunLifecycleGeneration());
  const releaseSecond = retainQueuedAgentRunContext("queued", getAgentRunLifecycleGeneration());
  expect(listener.mock.calls).toEqual([[false], [true]]);
  releaseFirst?.("abandoned");
  expect(listener.mock.calls).toEqual([[false], [true]]);
  releaseSecond?.("admitted");
  expect(listener.mock.calls).toEqual([[false], [true], [false]]);
});

it("becomes idle when the registry retires an execution lifecycle", () => {
  claimAgentRunContext("retired", { agentId: "main" }, { trackOwner: true });
  const listener = vi.fn<(busy: boolean) => void>();
  onTestFinished(observeAgentRunActivity("main", listener));
  rotateAgentRunRegistryLifecycleGeneration();
  expect(listener.mock.calls).toEqual([[true], [false]]);
});
