// Tests gateway active-run matching by logical session key and backing id.
import { expect, it } from "vitest";
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

function visibleState(
  sessionKey: string,
  options: Omit<ActiveRunParams, "context" | "requestedKey" | "canonicalKey"> = {},
) {
  const { projectedAgentRunIndex, ...scope } = options;
  return createVisibleActiveSessionRunProjector(
    {},
    projectedAgentRunIndex,
  )({
    requestedKey: sessionKey,
    canonicalKey: sessionKey,
    ...scope,
  });
}

it("projects ordinary startup as active before execution starts", () => {
  const sessionKey = "agent:main:queued";
  const sessionId = "queued-session";
  const runId = "queued-run";
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
  const state = () =>
    resolveVisibleActiveSessionRunState({
      context: { chatAbortControllers } as never,
      requestedKey: sessionKey,
      canonicalKey: sessionKey,
      sessionId,
      agentId: "main",
    });

  expect(state()).toEqual({ active: true, runIds: [runId] });
  expect(registration.markExecutionStarted()).toBe(true);
  expect(state()).toEqual({ active: true, runIds: [runId] });
  expect(registration.markExecutionStarted()).toBe(false);
  registration.cleanup();
});

it("projects direct subagent activity only for its own current-lifecycle session", async () => {
  const parentKey = "agent:main:main";
  const childKey = "agent:main:subagent:attachment-fix";
  await resetSubagentRegistryForTests({ persist: false });
  await addSubagentRunForTests({
    runId: "run-attachment-fix",
    childSessionKey: childKey,
    controllerSessionKey: parentKey,
    requesterSessionKey: parentKey,
    requesterDisplayKey: "main",
    task: "Fix parent activity indicator",
    cleanup: "keep",
    createdAt: 1,
    startedAt: 2,
  });
  registerAgentRunContext("run-attachment-fix", { sessionKey: childKey, agentId: "main" });
  expect(
    resolveVisibleActiveSessionRunState({
      context: {},
      requestedKey: childKey,
      canonicalKey: childKey,
      agentId: "main",
    }),
  ).toEqual({ active: false, runIds: [] });
  const claim = claimAgentRunContext(
    "run-attachment-fix",
    { sessionKey: childKey, agentId: "main" },
    { trackOwner: true, ownsContext: true },
  );

  try {
    expect(claim).toBeDefined();
    expect(visibleState(childKey, { agentId: "main" })).toEqual({
      active: true,
      runIds: ["run-attachment-fix"],
    });
    const releaseCapacityWait = registerAgentRunCapacityWait(
      "run-attachment-fix",
      getAgentRunLifecycleGeneration(),
    );
    try {
      expect(visibleState(childKey, { agentId: "main" })).toMatchObject({
        active: true,
        status: "queued",
      });
    } finally {
      releaseCapacityWait?.();
    }
    expect(visibleState(parentKey, { agentId: "main" })).toEqual({ active: false, runIds: [] });
    rotateAgentEventLifecycleGeneration();
    expect(visibleState(childKey, { agentId: "main" })).toEqual({ active: false, runIds: [] });
  } finally {
    releaseAgentRunContext("run-attachment-fix", claim);
    clearAgentRunContext("run-attachment-fix");
    await resetSubagentRegistryForTests({ persist: false });
  }
});

it("keeps terminal persistence visible only to chat history", () => {
  const terminal = {
    sessionKey: "agent:main:main",
    sessionId: "session-main",
    projectSessionActive: false,
    projectSessionTerminalPending: true,
  };
  const context = { chatAbortControllers: new Map([["run-terminal", terminal]]) } as never;
  const params = {
    context,
    requestedKey: terminal.sessionKey,
    canonicalKey: terminal.sessionKey,
    sessionId: terminal.sessionId,
    agentId: "main",
  };

  expect(resolveVisibleActiveSessionRunState(params)).toEqual({ active: false, runIds: [] });
  expect(
    resolveVisibleActiveSessionRunState({ ...params, includeTerminalPersistence: true }),
  ).toEqual({ active: true });

  terminal.projectSessionTerminalPending = false;
  expect(
    resolveVisibleActiveSessionRunState({ ...params, includeTerminalPersistence: true }),
  ).toEqual({ active: false, runIds: [] });
});

it("matches session-id-only gateway runs during archive admission", () => {
  const context = {
    chatAbortControllers: new Map([
      [
        "run-1",
        {
          sessionId: "session-1",
          controlUiVisible: true,
          projectSessionActive: true,
        },
      ],
    ]),
  } as never;

  expect(
    resolveVisibleActiveSessionRunState({
      context,
      requestedKey: "agent:main:child",
      canonicalKey: "agent:main:child",
      sessionId: "session-1",
      defaultAgentId: "main",
    }).active,
  ).toBe(true);
});

it("finds a visible active run for a fully qualified session key", () => {
  const sessionKey = "agent:main:main";
  const context = {
    chatAbortControllers: new Map([
      [
        "replacement-run",
        {
          sessionKey,
          controlUiVisible: true,
          projectSessionActive: true,
        },
      ],
    ]),
  } as never;

  expect(
    hasTrackedActiveSessionRun({
      context,
      requestedKey: sessionKey,
      canonicalKey: sessionKey,
    }),
  ).toBe(true);
});

it("returns deterministic visible run ids for the selected session", () => {
  const context = {
    chatAbortControllers: new Map([
      ["run-z", { sessionKey: "main" }],
      ["run-hidden", { sessionKey: "main", controlUiVisible: false }],
      ["run-other", { sessionKey: "other" }],
      ["run-a", { sessionKey: "main" }],
    ]),
  } as never;

  expect(
    resolveVisibleActiveSessionRunState({
      context,
      requestedKey: "main",
      canonicalKey: "main",
      agentId: "main",
      defaultAgentId: "main",
    }),
  ).toEqual({ active: true, runIds: ["run-a", "run-z"] });
});

it("projects reply lifecycle state without hiding independent embedded work", () => {
  const sessionKey = "agent:main:reply-settling";
  const sessionId = "reply-settling-session";
  const project = createVisibleActiveSessionRunProjector({});
  const state = () => project({ requestedKey: sessionKey, canonicalKey: sessionKey, sessionId });
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  const replacementHandle: EmbeddedAgentQueueHandle = {
    abort: () => undefined,
    isAborted: () => false,
    isCompacting: () => false,
    isStreaming: () => true,
    queueMessage: async () => undefined,
  };
  try {
    expect(state()).toEqual({ active: true });

    operation.markWaitingForGlobalLane();
    expect(state()).toEqual({ active: true });
    operation.markGlobalLaneWaitEnded();

    operation.setPhase("running");
    operation.markWaitingForGlobalLane();
    expect(state()).toEqual({ active: true });
    operation.markGlobalLaneWaitEnded();
    markReplyOperationExecutionStarted(operation);
    expect(state()).toEqual({ active: true });
    operation.markWaitingForGlobalLane();
    expect(state()).toEqual({ active: true });
    operation.markGlobalLaneWaitEnded();
    expect(operation.abortByUser()).toBe(true);
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
    expect(state()).toEqual({ active: false, runIds: [] });

    setActiveEmbeddedRun(sessionId, replacementHandle, sessionKey);
    expect(state()).toEqual({ active: true });
  } finally {
    clearActiveEmbeddedRun(sessionId, replacementHandle, sessionKey);
    operation.complete();
  }
});

it("does not project an aborted embedded handle retained for cleanup as active", () => {
  const sessionKey = "agent:main:handle-settling";
  const sessionId = "handle-settling-session";
  let aborted = false;
  const handle: EmbeddedAgentQueueHandle = {
    abort: () => {
      aborted = true;
    },
    isAborted: () => aborted,
    isCompacting: () => false,
    // Prompt completion closes steering before post-turn finalization. That
    // state alone must not make a normally finishing run disappear.
    isStopped: () => true,
    isStreaming: () => false,
    queueMessage: async () => undefined,
  };
  setActiveEmbeddedRun(sessionId, handle, sessionKey);
  try {
    expect(visibleState(sessionKey, { sessionId })).toEqual({ active: true });

    expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
    expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
    expect(visibleState(sessionKey, { sessionId })).toEqual({ active: false, runIds: [] });

    expect(
      resolveVisibleActiveSessionRunState({
        context: {
          chatAbortControllers: new Map([["new-run", { sessionId, sessionKey }]]),
        } as never,
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: ["new-run"] });
  } finally {
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
  }
});

it("counts settled but still registered chat runs for a session key", () => {
  const context = {
    chatAbortControllers: new Map([
      [
        "run-finalizing",
        {
          sessionKey: "agent:main:main",
          sessionId: "session-main",
          projectSessionActive: false,
          controlUiVisible: false,
        },
      ],
      ["run-global-work", { sessionKey: "global", agentId: "work" }],
    ]),
  } as never;

  expect(
    hasRegisteredChatRunForSessionKey({
      context,
      sessionKey: "agent:main:main",
      agentId: undefined,
    }),
  ).toBe(true);
  expect(
    hasRegisteredChatRunForSessionKey({
      context,
      sessionKey: "agent:other:other",
      agentId: undefined,
    }),
  ).toBe(false);
  expect(
    hasRegisteredChatRunForSessionKey({ context, sessionKey: "global", agentId: "work" }),
  ).toBe(true);
  expect(
    hasRegisteredChatRunForSessionKey({ context, sessionKey: "global", agentId: "other" }),
  ).toBe(false);
  expect(
    hasRegisteredChatRunForSessionKey({ context, sessionKey: "global", agentId: undefined }),
  ).toBe(false);
  expect(
    hasRegisteredChatRunForSessionKey({
      context: {},
      sessionKey: "agent:main:main",
      agentId: undefined,
    }),
  ).toBe(false);
});

it("matches colliding bare active runs by stable owner", () => {
  const context = {
    chatAbortControllers: new Map([
      ["run-ownerless", { sessionKey: "incident-42" }],
      ["run-research", { sessionKey: "incident-42", agentId: "research" }],
    ]),
  } as never;

  expect(
    resolveVisibleActiveSessionRunState({
      context,
      requestedKey: "incident-42",
      canonicalKey: "incident-42",
      agentId: "ops",
      defaultAgentId: "ops",
    }),
  ).toEqual({ active: true, runIds: ["run-ownerless"] });
  expect(
    resolveVisibleActiveSessionRunState({
      context,
      requestedKey: "incident-42",
      canonicalKey: "incident-42",
      agentId: "research",
      defaultAgentId: "ops",
    }),
  ).toEqual({ active: true, runIds: ["run-research"] });
});

it("keeps projected bare runs agent-scoped", () => {
  registerAgentRunContext("projected-ops", {
    projectSessionActive: true,
    sessionKey: "incident-42",
    sessionId: "shared-id",
    agentId: "ops",
  });
  try {
    const index = buildProjectedAgentRunIndex();
    expect(
      visibleState("incident-42", {
        sessionId: "shared-id",
        agentId: "research",
        projectedAgentRunIndex: index,
      }).active,
    ).toBe(false);
    expect(
      visibleState("incident-42", {
        sessionId: "shared-id",
        agentId: "ops",
        projectedAgentRunIndex: index,
      }).active,
    ).toBe(true);
  } finally {
    clearAgentRunContext("projected-ops");
  }
});

it("resolves projected ownerless bare runs through the stable default owner", () => {
  registerAgentRunContext("projected-ownerless", {
    projectSessionActive: true,
    sessionKey: "incident-42",
    sessionId: "ownerless-id",
  });
  try {
    const index = buildProjectedAgentRunIndex();
    expect(
      visibleState("incident-42", {
        sessionId: "ownerless-id",
        agentId: "ops",
        defaultAgentId: "ops",
        projectedAgentRunIndex: index,
      }).active,
    ).toBe(true);
    expect(
      visibleState("incident-42", {
        sessionId: "ownerless-id",
        agentId: "research",
        defaultAgentId: "ops",
        projectedAgentRunIndex: index,
      }).active,
    ).toBe(false);
  } finally {
    clearAgentRunContext("projected-ownerless");
  }
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
    try {
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
    } finally {
      operation.complete();
    }
  },
);

it("projects only recorded capacity waits as queued and preserves independent running owners", () => {
  const sessionKey = "agent:main:capacity-wait";
  const sessionId = "capacity-wait-session";
  const runId = "capacity-wait-run";
  registerAgentRunContext(runId, { sessionKey, sessionId, agentId: "main" });
  const chatAbortControllers = new Map();
  const registration = registerChatAbortController({
    chatAbortControllers,
    runId,
    sessionKey,
    sessionId,
    agentId: "main",
    timeoutMs: 60_000,
    kind: "agent",
  });
  const state = () =>
    resolveVisibleActiveSessionRunState({
      context: { chatAbortControllers },
      requestedKey: sessionKey,
      canonicalKey: sessionKey,
      sessionId,
    });
  const releaseWait = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
  try {
    expect(state()).toEqual({ active: true, status: "queued", runIds: [runId] });
    registration.markExecutionStarted();
    expect(state()).toEqual({ active: true, status: "queued", runIds: [runId] });
    registerAgentRunContext("capacity-independent", {
      sessionKey,
      sessionId,
      projectSessionActive: true,
    });
    expect(state()).toEqual({ active: true });
    clearAgentRunContext("capacity-independent");
    expect(state()).toEqual({ active: true, status: "queued", runIds: [runId] });
    releaseWait?.();
    expect(state()).toEqual({ active: true, runIds: [runId] });
  } finally {
    releaseWait?.();
    registration.cleanup();
    clearAgentRunContext(runId);
    clearAgentRunContext("capacity-independent");
  }
});

it.each([
  { isControlUiVisible: false },
  { projectSessionActive: false },
  { projectSessionLifecycle: false },
])("capacity evidence does not make a hidden maintenance run visible: %j", (visibility) => {
  const runId = "hidden-capacity";
  const sessionKey = "agent:main:hidden-capacity";
  registerAgentRunContext(runId, { sessionKey, ...visibility });
  const releaseWait = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
  try {
    expect(visibleState(sessionKey, {})).toEqual({ active: false, runIds: [] });
  } finally {
    releaseWait?.();
    clearAgentRunContext(runId);
  }
});

it("preserves the completed foreground row while hidden embedded maintenance remains operational", async () => {
  const sessionKey = "agent:main:hidden-maintenance-handle";
  const sessionId = "hidden-maintenance-session";
  const runId = "hidden-maintenance-run";
  let aborted = false;
  const handle: EmbeddedAgentQueueHandle = {
    runId,
    abort: () => {
      aborted = true;
    },
    isAborted: () => aborted,
    isCompacting: () => false,
    isStreaming: () => true,
    queueMessage: async () => undefined,
  };
  registerAgentRunContext(runId, {
    sessionKey,
    sessionId,
    projectSessionActive: false,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
    isControlUiVisible: false,
  });
  setActiveEmbeddedRun(sessionId, handle, sessionKey);
  const state = () =>
    visibleState(sessionKey, {
      sessionId,
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
    const sessionKey = `agent:main:hidden-with-${kind}`;
    const sessionId = `hidden-with-${kind}`;
    const runId = `hidden-${kind}`;
    const visibleRunId = `visible-${kind}`;
    const handle: EmbeddedAgentQueueHandle = {
      runId,
      abort: () => {},
      isCompacting: () => false,
      isStreaming: () => true,
      queueMessage: async () => undefined,
    };
    registerAgentRunContext(runId, { sessionKey, sessionId, projectSessionActive: false });
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    let reply: ReturnType<typeof createReplyOperation> | undefined;
    if (kind === "reply") {
      reply = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      reply.setPhase("running");
      markReplyOperationExecutionStarted(reply);
    } else {
      registerAgentRunContext(visibleRunId, { sessionKey, sessionId, projectSessionActive: true });
    }
    const state = () =>
      visibleState(sessionKey, {
        sessionId,
      });
    try {
      expect(state().active).toBe(true);
      reply?.complete();
      clearAgentRunContext(visibleRunId);
      expect(state()).toEqual({ active: false, runIds: [] });
      expect(resolveEmbeddedAgentRunProgressState(sessionId)).toBe("running");
    } finally {
      reply?.complete();
      clearAgentRunContext(visibleRunId);
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      clearAgentRunContext(runId);
    }
  },
);

it("keeps embedded activity independent of suppressed events", () => {
  const sessionKey = "agent:main:suppressed-events";
  const sessionId = "suppressed-events";
  const runId = "suppressed-events-run";
  const handle: EmbeddedAgentQueueHandle = {
    runId,
    abort: () => {},
    isCompacting: () => false,
    isStreaming: () => true,
    queueMessage: async () => undefined,
  };
  registerAgentRunContext(runId, {
    sessionKey,
    sessionId,
    projectSessionActive: true,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
    isControlUiVisible: false,
  });
  setActiveEmbeddedRun(sessionId, handle, sessionKey);
  try {
    clearAgentRunContext(runId);
    expect(visibleState(sessionKey, { sessionId })).toEqual({ active: true });
  } finally {
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    clearAgentRunContext(runId);
  }
});
