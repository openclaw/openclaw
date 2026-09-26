import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadRequesterSessionEntry } from "../agents/subagents/announce/subagent-announce-delivery.js";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { registerHarnessTaskProgress } from "../tasks/task-registry-harness-progress.js";
import { createAgentHarnessTaskRuntime } from "./agent-harness-task-runtime.js";

vi.mock("../agents/subagents/announce/subagent-announce-delivery.js", () => ({
  loadRequesterSessionEntry: vi.fn(),
  deliverSubagentAnnouncement: vi.fn(),
  isInternalAnnounceRequesterSession: vi.fn(),
}));
vi.mock("../tasks/task-registry-harness-progress.js", () => ({
  registerHarnessTaskProgress: vi.fn((params) => ({
    notify: vi.fn(),
    dispose: vi.fn(() => params.onStopped()),
  })),
}));
vi.mock("../tasks/runtime-internal.js", () => ({ listTaskRecords: () => [] }));
vi.mock("../tasks/detached-task-runtime.js", () => ({
  createRunningTaskRun: vi.fn(),
  finalizeTaskRunByRunId: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
  setDetachedTaskDeliveryStatusByRunId: vi.fn(),
}));

const sessionKey = "agent:main:synthetic";
const sessionId = "original";
const lifecycleRevision = "revision-original";
const agentId = "main";
const stop: Array<() => void> = [];
beforeEach(() => {
  resetAgentRunRegistryForTest();
  vi.clearAllMocks();
});
afterEach(() => {
  stop.splice(0).forEach((dispose) => dispose());
  resetAgentRunRegistryForTest();
});

function register(
  scope = createAgentHarnessTaskRuntimeScope({
    requesterSessionKey: sessionKey,
    requesterSessionId: sessionId,
    requesterLifecycleRevision: lifecycleRevision,
    requesterAgentId: agentId,
    requesterOrigin: { channel: "discord", to: "channel:synthetic" },
  }),
) {
  const runtime = createAgentHarnessTaskRuntime({
    runtime: "subagent",
    taskKind: "synthetic-native",
    scope,
  });
  const onStopped = vi.fn();
  const owner = runtime.registerProgressOwner!({
    runIds: [],
    agentId,
    isCurrent: () => true,
    onStopped,
  });
  if (owner) {
    stop.push(owner.dispose);
  }
  return {
    owner,
    onStopped,
    admitted: vi.mocked(registerHarnessTaskProgress).mock.calls.at(-1)?.[0],
  };
}

it("registers progress without reading the requester session entry", () => {
  const { owner, admitted } = register();
  expect(owner).toBeDefined();
  expect(admitted).toBeDefined();
  expect(loadRequesterSessionEntry).not.toHaveBeenCalled();
});

it("permanently retires post-yield progress on a requester run using another native thread or client", () => {
  registerAgentRunContext("old-run", { sessionKey, sessionId, agentId });
  const { owner, admitted, onStopped } = register();
  expect(admitted?.isCurrent()).toBe(true);
  clearAgentRunContext("old-run");
  expect(admitted?.isCurrent()).toBe(true);
  registerAgentRunContext("new-run", { sessionKey, sessionId, agentId });
  clearAgentRunContext("new-run");
  expect(admitted?.isCurrent()).toBe(false);
  expect(owner?.dispose).toHaveBeenCalledOnce();
  expect(onStopped).toHaveBeenCalledOnce();
});

it("retires on a new execution claim of the same requester run id", () => {
  registerAgentRunContext("parent-run", { sessionKey, sessionId, agentId });
  const { admitted, onStopped } = register();
  const original = admitted?.isCurrent();
  expect(original).toBe(true);
  claimAgentRunContext("parent-run", { sessionKey, sessionId, agentId });
  expect(admitted?.isCurrent()).toBe(false);
  expect(onStopped).toHaveBeenCalledOnce();
});

it("ignores unrelated requester runs", () => {
  const { admitted, onStopped } = register();
  registerAgentRunContext("other-run", { sessionKey: "agent:main:other", agentId });
  expect(admitted?.isCurrent()).toBe(true);
  expect(onStopped).not.toHaveBeenCalled();
});

it("retires when requester entry facts identify a replacement session", () => {
  const { admitted, onStopped } = register();
  sessionChanges.emit({
    sessionKey,
    agentId,
    facts: {
      kind: "entry",
      previousSessionId: sessionId,
      sessionId: "replaced",
      lifecycleRevision: "revision-replaced",
      category: null,
      clearMembers: false,
    },
  });
  expect(admitted?.isCurrent()).toBe(false);
  expect(onStopped).toHaveBeenCalledOnce();
});

it("retires on a same-id requester lifecycle replacement", () => {
  const { admitted, onStopped } = register();
  sessionChanges.emit({
    sessionKey,
    agentId,
    facts: {
      kind: "entry",
      previousSessionId: sessionId,
      sessionId,
      lifecycleRevision: "revision-replaced",
      category: null,
      clearMembers: false,
    },
  });
  expect(admitted?.isCurrent()).toBe(false);
  expect(onStopped).toHaveBeenCalledOnce();
});

it("retires when requester facts are invalidated or removed", () => {
  for (const change of [
    { sessionKey, agentId, factsInvalidated: true as const },
    { sessionKey, agentId, facts: { kind: "removed" as const } },
  ]) {
    const { admitted, onStopped } = register();
    sessionChanges.emit(change);
    expect(admitted?.isCurrent()).toBe(false);
    expect(onStopped).toHaveBeenCalledOnce();
  }
});

it("falls back to in-memory lifecycle checks for other requester-key facts", () => {
  const { admitted, onStopped } = register();
  sessionChanges.emit({
    sessionKey,
    agentId,
    facts: {
      kind: "entry",
      previousSessionId: sessionId,
      sessionId,
      lifecycleRevision,
      category: null,
      clearMembers: false,
    },
  });
  expect(admitted?.isCurrent()).toBe(true);
  expect(onStopped).not.toHaveBeenCalled();
  registerAgentRunContext("hidden-requester", {
    sessionKey,
    sessionId,
    agentId,
    isControlUiVisible: false,
  });
  expect(admitted?.isCurrent()).toBe(false);
  expect(onStopped).toHaveBeenCalledOnce();
});

it("retires for broad all-session facts but ignores a different agent scope", () => {
  const broad = register();
  sessionChanges.emit({ all: true, scope: "stores" });
  expect(broad.admitted?.isCurrent()).toBe(false);
  expect(broad.onStopped).toHaveBeenCalledOnce();

  const unscoped = register();
  sessionChanges.emit({ all: true, scope: { storePath: "/shared/store.sqlite" } });
  expect(unscoped.admitted?.isCurrent()).toBe(false);
  expect(unscoped.onStopped).toHaveBeenCalledOnce();

  const other = register();
  sessionChanges.emit({ all: true, scope: { agentId: "other" } });
  expect(other.admitted?.isCurrent()).toBe(true);
  expect(other.onStopped).not.toHaveBeenCalled();

  // Unrelated broad publications must not retire a live requester card.
  sessionChanges.emit({ all: true, scope: "worker-environments" });
  sessionChanges.emit({ all: true, scope: "agent-runs" });
  expect(other.admitted?.isCurrent()).toBe(true);
  expect(other.onStopped).not.toHaveBeenCalled();
});

it("ignores unrelated requester facts and maintenance that cannot project requester lifecycle", () => {
  const { admitted, onStopped } = register();
  sessionChanges.emit({ sessionKey: "agent:main:other", agentId, facts: { kind: "removed" } });
  registerAgentRunContext("maintenance", {
    sessionKey,
    sessionId,
    agentId,
    projectSessionActive: false,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
  });
  expect(admitted?.isCurrent()).toBe(true);
  expect(onStopped).not.toHaveBeenCalled();
});

it("rejects progress registration for a foreign agent", () => {
  const runtime = createAgentHarnessTaskRuntime({
    runtime: "subagent",
    taskKind: "synthetic-native",
    scope: createAgentHarnessTaskRuntimeScope({
      requesterSessionKey: sessionKey,
      requesterSessionId: sessionId,
      requesterLifecycleRevision: lifecycleRevision,
      requesterAgentId: agentId,
    }),
  });
  expect(
    runtime.registerProgressOwner!({
      runIds: [],
      agentId: "foreign",
      isCurrent: () => true,
      onStopped: vi.fn(),
    }),
  ).toBeUndefined();
  expect(registerHarnessTaskProgress).not.toHaveBeenCalled();
});

it("fails closed when the host-issued scope lacks requester identity", () => {
  const runtime = createAgentHarnessTaskRuntime({
    runtime: "subagent",
    taskKind: "synthetic-native",
    scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: sessionKey }),
  });
  expect(
    runtime.registerProgressOwner?.({ runIds: [], isCurrent: () => true, onStopped: vi.fn() }),
  ).toBeUndefined();
  expect(registerHarnessTaskProgress).not.toHaveBeenCalled();
  expect(loadRequesterSessionEntry).not.toHaveBeenCalled();
});
