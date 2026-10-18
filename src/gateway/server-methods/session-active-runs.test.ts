import { afterEach, expect, it } from "vitest";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/run-state.js";
import {
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  resolveEmbeddedAgentRunProgressState,
  setActiveEmbeddedRun,
  waitForEmbeddedAgentRunEnd,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  createReplyOperation,
  markReplyOperationExecutionStarted,
} from "../../auto-reply/reply/reply-run-registry.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { registerAgentRunCapacityWait } from "../../infra/agent-run-capacity-wait.js";
import {
  buildProjectedAgentRunIndex,
  claimAgentRunContext,
  releaseAgentRunContext,
  getAgentRunLifecycleGeneration,
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { registerChatAbortController } from "../chat-abort.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import {
  createVisibleActiveSessionRunProjector,
  hasRegisteredChatRunForSessionKey,
  hasTrackedActiveSessionRun,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";

type ActiveRunParams = Parameters<typeof resolveVisibleActiveSessionRunState>[0];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

function makeRun(name: string) {
  const sessionKey = `agent:main:${name}`;
  const sessionId = `${name}-session`;
  const runId = `${name}-run`;
  return {
    sessionKey,
    sessionId,
    runId,
    state: () => visibleState(sessionKey, { sessionId }),
    register(overrides: Parameters<typeof registerAgentRunContext>[1] = {}) {
      registerAgentRunContext(runId, { sessionKey, sessionId, ...overrides });
      cleanups.push(() => clearAgentRunContext(runId));
    },
    embed(overrides: Partial<EmbeddedAgentQueueHandle> = {}) {
      const handle = embeddedHandle({ runId, ...overrides });
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      cleanups.push(() => clearActiveEmbeddedRun(sessionId, handle, sessionKey));
      return handle;
    },
    reply() {
      const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      cleanups.push(() => operation.complete());
      return operation;
    },
    wait() {
      const release = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
      cleanups.push(() => release?.());
      return release;
    },
  };
}

function chatContext<T>(runs: Record<string, T>) {
  return { chatAbortControllers: new Map(Object.entries(runs)) };
}

function resolveState(
  sessionKey: string,
  options: Omit<ActiveRunParams, "requestedKey" | "canonicalKey">,
) {
  return resolveVisibleActiveSessionRunState({
    requestedKey: sessionKey,
    canonicalKey: sessionKey,
    ...options,
  });
}

function embeddedHandle(
  overrides: Partial<EmbeddedAgentQueueHandle> = {},
): EmbeddedAgentQueueHandle {
  return {
    abort: () => {},
    isCompacting: () => false,
    isStreaming: () => true,
    queueMessage: async () => undefined,
    ...overrides,
  };
}

function registerChatRun(sessionKey: string, sessionId: string, runId: string, agentId?: string) {
  const chatAbortControllers = new Map();
  const registration = registerChatAbortController({
    chatAbortControllers,
    runId,
    sessionId,
    sessionKey,
    agentId: "main",
    timeoutMs: 60_000,
    kind: "agent",
  });
  cleanups.push(registration.cleanup);
  return {
    ...registration,
    state: () =>
      resolveState(sessionKey, { context: { chatAbortControllers }, sessionId, agentId }),
  };
}

function visibleState(
  sessionKey: string,
  options: Omit<ActiveRunParams, "context" | "requestedKey" | "canonicalKey"> = {},
) {
  const { projectedAgentRunIndex, ...scope } = options;
  const project = createVisibleActiveSessionRunProjector({}, projectedAgentRunIndex);
  return project({ requestedKey: sessionKey, canonicalKey: sessionKey, ...scope });
}

it("projects ordinary startup as active before execution starts", () => {
  const { sessionKey, sessionId, runId } = makeRun("queued");
  const registration = registerChatRun(sessionKey, sessionId, runId, "main");
  const { state } = registration;
  expect(state()).toEqual({ active: true, runIds: [runId] });
  expect(registration.markExecutionStarted()).toBe(true);
  expect(state()).toEqual({ active: true, runIds: [runId] });
  expect(registration.markExecutionStarted()).toBe(false);
});

it("projects direct subagent activity only for its own current-lifecycle session", async () => {
  const parentKey = "agent:main:main";
  const childKey = "agent:main:subagent:attachment-fix";
  const runId = "run-attachment-fix";
  const identity = { sessionKey: childKey, agentId: "main" };
  const state = (key = childKey) => visibleState(key, { agentId: "main" });
  await resetSubagentRegistryForTests({ persist: false });
  setRuntimeConfigSnapshot({});
  cleanups.push(clearRuntimeConfigSnapshot, async () => {
    await resetSubagentRegistryForTests({ persist: false });
  });
  await addSubagentRunForTests({
    runId,
    childSessionKey: childKey,
    controllerSessionKey: parentKey,
    requesterSessionKey: parentKey,
    requesterDisplayKey: "main",
    task: "Fix parent activity indicator",
    cleanup: "keep",
    createdAt: 1,
    startedAt: 2,
  });
  registerAgentRunContext(runId, identity);
  cleanups.push(() => clearAgentRunContext(runId));
  expect(resolveState(childKey, { context: {}, agentId: "main" })).toEqual({
    active: false,
    runIds: [],
  });
  const claim = claimAgentRunContext(runId, identity, { trackOwner: true, ownsContext: true });
  cleanups.push(() => releaseAgentRunContext(runId, claim));
  expect(claim).toBeDefined();
  expect(state()).toEqual({ active: true, runIds: [runId] });
  const releaseCapacityWait = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
  cleanups.push(() => releaseCapacityWait?.());
  expect(state()).toMatchObject({ active: true, status: "queued" });
  releaseCapacityWait?.();
  expect(state(parentKey)).toEqual({ active: false, runIds: [] });
  rotateAgentEventLifecycleGeneration();
  expect(state()).toEqual({ active: false, runIds: [] });
});

it("keeps terminal persistence visible only to chat history", () => {
  const terminal = {
    sessionKey: "agent:main:main",
    sessionId: "session-main",
    projectSessionActive: false,
    projectSessionTerminalPending: true,
  };
  const context = chatContext({ "run-terminal": terminal }) as never;
  const state = (includeTerminalPersistence = false) =>
    resolveState(terminal.sessionKey, {
      context,
      sessionId: terminal.sessionId,
      agentId: "main",
      includeTerminalPersistence,
    });
  expect(state()).toEqual({ active: false, runIds: [] });
  expect(state(true)).toEqual({ active: true });
  terminal.projectSessionTerminalPending = false;
  expect(state(true)).toEqual({ active: false, runIds: [] });
});

it("matches session-id-only gateway runs during archive admission", () => {
  const context = chatContext({
    "run-1": { sessionId: "session-1", controlUiVisible: true, projectSessionActive: true },
  }) as never;
  expect(
    resolveState("agent:main:child", {
      context,
      sessionId: "session-1",
      defaultAgentId: "main",
    }).active,
  ).toBe(true);
});

it("finds a visible active run for a fully qualified session key", () => {
  const sessionKey = "agent:main:main";
  const context = chatContext({
    "replacement-run": { sessionKey, controlUiVisible: true, projectSessionActive: true },
  }) as never;
  expect(
    hasTrackedActiveSessionRun({
      context,
      requestedKey: sessionKey,
      canonicalKey: sessionKey,
    }),
  ).toBe(true);
});

it("returns deterministic visible run ids for the selected session", () => {
  const context = chatContext({
    "run-z": { sessionKey: "main" },
    "run-hidden": { sessionKey: "main", controlUiVisible: false },
    "run-other": { sessionKey: "other" },
    "run-a": { sessionKey: "main" },
  }) as never;
  expect(
    resolveState("main", {
      context,
      agentId: "main",
      defaultAgentId: "main",
    }),
  ).toEqual({ active: true, runIds: ["run-a", "run-z"] });
});

it("projects reply lifecycle state without hiding independent embedded work", () => {
  const run = makeRun("reply-settling");
  const { sessionKey, sessionId } = run;
  const project = createVisibleActiveSessionRunProjector({});
  const state = () => project({ requestedKey: sessionKey, canonicalKey: sessionKey, sessionId });
  const operation = run.reply();
  const expectLaneWaitVisible = () => {
    operation.markWaitingForGlobalLane();
    expect(state()).toEqual({ active: true });
    operation.markGlobalLaneWaitEnded();
  };
  expect(state()).toEqual({ active: true });
  expectLaneWaitVisible();
  operation.setPhase("running");
  expectLaneWaitVisible();
  markReplyOperationExecutionStarted(operation);
  expect(state()).toEqual({ active: true });
  expectLaneWaitVisible();
  expect(operation.abortByUser()).toBe(true);
  expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
  expect(state()).toEqual({ active: false, runIds: [] });
  run.embed({ runId: undefined, isAborted: () => false });
  expect(state()).toEqual({ active: true });
});

it("does not project an aborted embedded handle retained for cleanup as active", () => {
  const run = makeRun("handle-settling");
  const { sessionKey, sessionId, state } = run;
  let aborted = false;
  run.embed({
    runId: undefined,
    abort: () => {
      aborted = true;
    },
    isAborted: () => aborted,
    // Closed steering must not hide normally finishing work.
    isStopped: () => true,
    isStreaming: () => false,
  });
  expect(state()).toEqual({ active: true });
  expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
  expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
  expect(state()).toEqual({ active: false, runIds: [] });
  expect(
    resolveState(sessionKey, {
      context: chatContext({ "new-run": { sessionId, sessionKey } }) as never,
      sessionId,
    }),
  ).toEqual({ active: true, runIds: ["new-run"] });
});

it("counts settled but still registered chat runs for a session key", () => {
  const context = chatContext({
    "run-finalizing": {
      sessionKey: "agent:main:main",
      sessionId: "session-main",
      projectSessionActive: false,
      controlUiVisible: false,
    },
    "run-global-work": { sessionKey: "global", agentId: "work" },
  }) as never;
  const registered = (sessionKey: string, agentId?: string) =>
    hasRegisteredChatRunForSessionKey({ context, sessionKey, agentId });
  expect(registered("agent:main:main")).toBe(true);
  expect(registered("agent:other:other")).toBe(false);
  expect(registered("global", "work")).toBe(true);
  expect(registered("global", "other")).toBe(false);
  expect(registered("global")).toBe(false);
  expect(
    hasRegisteredChatRunForSessionKey({
      context: {},
      sessionKey: "agent:main:main",
      agentId: undefined,
    }),
  ).toBe(false);
});

it("matches colliding bare active runs by stable owner", () => {
  const context = chatContext({
    "run-ownerless": { sessionKey: "incident-42" },
    "run-research": { sessionKey: "incident-42", agentId: "research" },
  }) as never;
  const state = (agentId: string) =>
    resolveState("incident-42", { context, agentId, defaultAgentId: "ops" });
  expect(state("ops")).toEqual({ active: true, runIds: ["run-ownerless"] });
  expect(state("research")).toEqual({ active: true, runIds: ["run-research"] });
});

it.each(["ops", undefined])("scopes projected bare runs with owner %s", (owner) => {
  const run = makeRun("projected");
  run.register({
    projectSessionActive: true,
    sessionKey: "incident-42",
    agentId: owner,
  });
  const index = buildProjectedAgentRunIndex();
  const state = (agentId: string) =>
    visibleState("incident-42", {
      sessionId: run.sessionId,
      agentId,
      defaultAgentId: owner ? undefined : "ops",
      projectedAgentRunIndex: index,
    }).active;
  expect(state("ops")).toBe(true);
  expect(state("research")).toBe(false);
});

it.each(["agent:main:command", "global"])(
  "keeps an adopted reply's global alias with its captured agent (source=%s)",
  async (sourceKey) => {
    const sessionId = "adopted-global-session";
    const operation = createReplyOperation({
      sessionKey: sourceKey,
      sessionId,
      agentId: "main",
      resetTriggered: false,
    });
    cleanups.push(() => operation.complete());
    const admission = await admitReplyTurn({
      sessionKey: "global",
      sessionId,
      agentId: "ops",
      kind: "visible",
      resetTriggered: false,
      adoptOperation: operation,
    });
    expect(admission.status).toBe("owned");
    for (const agentId of ["main", "ops"]) {
      expect(
        resolveVisibleActiveSessionRunState({
          context: {},
          requestedKey: `agent:${agentId}:main`,
          canonicalKey: "global",
          sessionId,
          agentId,
          defaultAgentId: "main",
        }).active,
      ).toBe(agentId === "ops");
    }
  },
);

it("projects only recorded capacity waits as queued and preserves independent running owners", () => {
  const run = makeRun("capacity-wait");
  const { sessionKey, sessionId, runId } = run;
  run.register({ agentId: "main" });
  const registration = registerChatRun(sessionKey, sessionId, runId);
  const { state } = registration;
  const releaseWait = run.wait();
  expect(state()).toEqual({ active: true, status: "queued", runIds: [runId] });
  registration.markExecutionStarted();
  expect(state()).toEqual({ active: true, status: "queued", runIds: [runId] });
  registerAgentRunContext("capacity-independent", {
    sessionKey,
    sessionId,
    projectSessionActive: true,
  });
  cleanups.push(() => clearAgentRunContext("capacity-independent"));
  expect(state()).toEqual({ active: true });
  clearAgentRunContext("capacity-independent");
  expect(state()).toEqual({ active: true, status: "queued", runIds: [runId] });
  releaseWait?.();
  expect(state()).toEqual({ active: true, runIds: [runId] });
});

it.each([
  { isControlUiVisible: false },
  { projectSessionActive: false },
  { projectSessionLifecycle: false },
])("capacity evidence does not make a hidden maintenance run visible: %j", (visibility) => {
  const run = makeRun("hidden-capacity");
  run.register(visibility);
  run.wait();
  expect(visibleState(run.sessionKey, {})).toEqual({ active: false, runIds: [] });
});

it("preserves the completed foreground row while hidden embedded maintenance remains operational", async () => {
  const run = makeRun("hidden-maintenance");
  const { sessionKey, sessionId, runId, state } = run;
  let aborted = false;
  run.register({
    projectSessionActive: false,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
    isControlUiVisible: false,
  });
  const handle = run.embed({
    abort: () => {
      aborted = true;
    },
    isAborted: () => aborted,
  });
  const snapshot = () =>
    buildGatewaySessionSnapshot({
      sessionRow: {
        key: sessionKey,
        kind: "direct",
        updatedAt: 20,
        sessionId,
        lastRunId: "completed-foreground",
        status: "done",
        runtimeMs: 273_418,
      },
      activeRunState: state(),
      includeSession: true,
    });
  let settled = false;
  const cleanup = waitForEmbeddedAgentRunEnd(sessionId, null).then((ended) => {
    settled = true;
    return ended;
  });
  try {
    expect.soft(snapshot()).toMatchObject({
      status: "done",
      hasActiveRun: false,
      lastRunId: "completed-foreground",
      runtimeMs: 273_418,
      session: { status: "done", hasActiveRun: false },
    });
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
    expect(resolveEmbeddedAgentRunProgressState(sessionId)).toBe("running");
    clearAgentRunContext(runId);
    expect.soft(state()).toEqual({ active: false, runIds: [] });
    expect(resolveEmbeddedAgentRunProgressState(sessionId)).toBe("running");
    expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
    expect(aborted).toBe(true);
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
    expect(resolveEmbeddedAgentRunProgressState(sessionId)).toBeUndefined();
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    clearAgentRunContext(runId);
    await expect(cleanup).resolves.toBe(true);
  }
});

it.each(["reply", "remote"] as const)(
  "keeps a visible %s owner independent of hidden embedded maintenance",
  (kind) => {
    const run = makeRun(`hidden-with-${kind}`);
    const { sessionKey, sessionId, state } = run;
    const visibleRunId = `visible-${kind}`;
    run.register({ projectSessionActive: false });
    run.embed();
    let reply: ReturnType<typeof createReplyOperation> | undefined;
    if (kind === "reply") {
      reply = run.reply();
      reply.setPhase("running");
      markReplyOperationExecutionStarted(reply);
    } else {
      registerAgentRunContext(visibleRunId, { sessionKey, sessionId, projectSessionActive: true });
      cleanups.push(() => clearAgentRunContext(visibleRunId));
    }
    expect(state().active).toBe(true);
    reply?.complete();
    clearAgentRunContext(visibleRunId);
    expect(state()).toEqual({ active: false, runIds: [] });
    expect(resolveEmbeddedAgentRunProgressState(sessionId)).toBe("running");
  },
);

it("keeps embedded activity independent of suppressed events", () => {
  const run = makeRun("suppressed-events");
  run.register({
    projectSessionActive: true,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
    isControlUiVisible: false,
  });
  run.embed();
  clearAgentRunContext(run.runId);
  expect(run.state()).toEqual({ active: true });
});
