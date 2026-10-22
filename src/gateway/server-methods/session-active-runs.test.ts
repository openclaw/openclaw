// Tests gateway active-run matching by logical session key and backing id.
import { afterEach, expect, it, vi } from "vitest";
import type { EmbeddedAgentQueueHandle } from "../../agents/embedded-agent-runner/run-state.js";
import { abortEmbeddedAgentRun } from "../../agents/embedded-agent-runner/runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
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
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createReplyOperation as createControllerOperation,
  getSessionControllerOperation,
  markReplyOperationExecutionStarted,
} from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  releaseSessionControllerClaim,
  retireSessionControllerInput,
  submitSessionControllerTask,
} from "../../sessions/session-controller.mailbox.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { isSessionRunActive } from "../../sessions/session-controller.queries.js";
import type {
  RpcSourceAdapter,
  RpcSourceIdentity,
} from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import { createRpcSourceForTest, claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import {
  createVisibleActiveSessionRunProjector,
  hasRegisteredChatRunForSessionKey,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";

type ActiveRunParams = Parameters<typeof resolveVisibleActiveSessionRunState>[0];
const cleanups: (() => void | Promise<void>)[] = [];
const storePath = "/synthetic/active-projection/sessions";

function setActiveEmbeddedRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey: string,
) {
  return registerTestEmbeddedRun(
    sessionId,
    handle,
    sessionKey,
    undefined,
    undefined,
    undefined,
    undefined,
    { storeScope: storePath },
  );
}

function createReplyOperation(params: Parameters<typeof createControllerOperation>[0]) {
  return createControllerOperation({
    ...params,
    target: captureSessionTarget({
      storeScope: storePath,
      sessionKey: params.sessionKey,
      incarnation: params.sessionId,
      agentId: params.agentId,
    }),
  });
}

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
    state: () => resolveState(sessionKey, { sessionId }),
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
      cleanups.push(async () => {
        operation.complete();
        await operation.ownerSettlement;
      });
      return operation;
    },
    wait() {
      const release = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
      cleanups.push(() => release?.());
      return release;
    },
  };
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
  const registration = registerChatAbortController({
    target: captureSessionTarget({
      storeScope: storePath,
      sessionKey,
      incarnation: sessionId,
      agentId: "main",
    }),
    runId,
    sessionId,
    sessionKey,
    agentId: "main",
    timeoutMs: 60_000,
    kind: "agent",
  });
  cleanups.push(registration.cleanup);
  registration.initializeTiming();
  return {
    ...registration,
    state: () => resolveState(sessionKey, { sessionId, agentId }),
  };
}

async function activeSources(
  entries: Array<
    [
      string,
      Partial<RpcSourceAdapter> &
        Partial<RpcSourceIdentity> & {
          projectSessionActive?: boolean;
          storeScope?: string;
          queued?: boolean;
        },
    ]
  >,
) {
  const refs = await Promise.all(
    entries.map(async ([runId, metadata]) => {
      const { sessionKey, sessionId, agentId, storeScope, queued, ...adapter } = metadata;
      const ref = createRpcSourceForTest(adapter, {
        runId,
        storeScope: storeScope ?? storePath,
        sessionKey,
        sessionId: sessionId ?? `fixture-${runId}`,
        agentId,
        accepted: true,
      });
      if (!queued) {
        cleanups.push(await claimRpcSourceForTest(ref));
      }
      return [runId, ref] as const;
    }),
  );
  return new Map(refs);
}

function resolveState(
  sessionKey: string,
  options: Omit<ActiveRunParams, "requestedKey" | "canonicalKey"> = {},
) {
  return resolveVisibleActiveSessionRunState({
    storePath,
    requestedKey: sessionKey,
    canonicalKey: sessionKey,
    ...options,
  });
}

it("projects an accepted source before its exact controller claim starts", async () => {
  const { sessionKey, sessionId, runId } = makeRun("queued");
  rpcSourceTesting.clear();
  const registration = registerChatRun(sessionKey, sessionId, runId, "main");
  const { state } = registration;

  expect(state()).toEqual({ active: true, runIds: [runId], status: "queued" });
  if (!registration.entry) {
    throw new Error("Missing RPC source");
  }
  cleanups.push(await claimRpcSourceForTest(registration.entry));
  expect(registration.markExecutionStarted()).toBe(true);
  expect(state()).toEqual({ active: true, runIds: [runId] });
  expect(registration.markExecutionStarted()).toBe(false);
});

it("projects direct subagent activity only for its own current-lifecycle session", async () => {
  const parentKey = "agent:main:main";
  const childKey = "agent:main:subagent:attachment-fix";
  const runId = "run-attachment-fix";
  const identity = { sessionKey: childKey, agentId: "main" };
  const state = (key = childKey) => resolveState(key, { agentId: "main" });
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
  const physicalPaths = vi.fn((locator: string) => [locator]);
  const project = createVisibleActiveSessionRunProjector(
    undefined,
    undefined,
    undefined,
    physicalPaths,
  );
  expect(
    project({ storePath, requestedKey: childKey, canonicalKey: childKey, agentId: "main" }),
  ).toEqual({ active: false, runIds: [] });
  expect(physicalPaths).not.toHaveBeenCalled();
  registerAgentRunContext(runId, identity);
  cleanups.push(() => clearAgentRunContext(runId));
  expect(resolveState(childKey, { agentId: "main" })).toEqual({
    active: false,
    runIds: [],
  });
  const claim = claimAgentRunContext(runId, identity, { trackOwner: true, ownsContext: true });
  cleanups.push(() => releaseAgentRunContext(runId, claim));
  expect(claim).toBeDefined();
  expect(state()).toEqual({ active: true, runIds: [runId] });
  expect(
    project({ storePath, requestedKey: childKey, canonicalKey: childKey, agentId: "main" }),
  ).toEqual({ active: true, runIds: [runId] });
  const releaseCapacityWait = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
  cleanups.push(() => releaseCapacityWait?.());
  expect(state()).toMatchObject({ active: true, status: "queued" });
  releaseCapacityWait?.();
  expect(state(parentKey)).toEqual({ active: false, runIds: [] });
  rotateAgentEventLifecycleGeneration();
  expect(state()).toEqual({ active: false, runIds: [] });
  expect(
    project({ storePath, requestedKey: childKey, canonicalKey: childKey, agentId: "main" }),
  ).toEqual({ active: false, runIds: [] });
});

it("keeps terminal persistence visible only to chat history", async () => {
  const terminal = {
    sessionKey: "agent:main:main",
    sessionId: "session-main",
    projectSessionActive: false,
    projectSessionTerminalPending: true,
  };
  const terminalRef = createRpcSourceForTest(
    {
      projectSessionActive: terminal.projectSessionActive,
      projectSessionTerminalPending: terminal.projectSessionTerminalPending,
    },
    {
      sessionKey: terminal.sessionKey,
      storeScope: storePath,
      sessionId: terminal.sessionId,
      agentId: "main",
    },
  );
  rpcSourceTesting.reset([["run-terminal", terminalRef]]);
  cleanups.push(() => retireSessionControllerInput(terminalRef.input));
  const params = {
    storePath,
    requestedKey: terminal.sessionKey,
    canonicalKey: terminal.sessionKey,
    sessionId: terminal.sessionId,
    agentId: "main",
  };

  expect(resolveVisibleActiveSessionRunState(params)).toEqual({ active: false, runIds: [] });
  expect(
    resolveVisibleActiveSessionRunState({ ...params, includeTerminalPersistence: true }),
  ).toEqual({ active: true });

  terminalRef.adapter.projectSessionTerminalPending = false;
  terminalRef.adapter.projectSessionTerminalPersisted = true;
  expect(
    resolveVisibleActiveSessionRunState({ ...params, includeTerminalPersistence: true }),
  ).toEqual({ active: false, runIds: [] });
});

it.each(["rpc", "native"] as const)(
  "preserves logical SDK projection and exact core store scope for %s work",
  async (kind) => {
    const sessionKey = "agent:main:published-projection";
    const sessionId = "published-projection-session";
    const selection = { requestedKey: sessionKey, canonicalKey: sessionKey, sessionId };
    let operation: ReturnType<typeof createReplyOperation> | undefined;
    rpcSourceTesting.clear();
    if (kind === "rpc") {
      rpcSourceTesting.reset(
        await activeSources([["published-run", { sessionKey, sessionId, agentId: "main" }]]),
      );
    } else {
      operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      operation.attachBackend({ kind: "embedded", cancel: () => {} });
      operation.setPhase("running");
      markReplyOperationExecutionStarted(operation);
    }
    try {
      const project = createVisibleActiveSessionRunProjector();
      expect(project(selection)).toMatchObject({ active: true });
      expect(project({ ...selection, storePath })).toEqual(project(selection));
      expect(project({ ...selection, storePath: "/synthetic/unrelated/sessions" })).toEqual({
        active: false,
        runIds: [],
      });
    } finally {
      operation?.complete();
      rpcSourceTesting.clear();
    }
  },
);

it("keeps prebuilt active-run indexes in parity with per-row scans", async () => {
  rpcSourceTesting.reset(
    await activeSources([
      ["run-main", { sessionKey: "agent:main:main", sessionId: "session-main" }],
      ["run-global", { sessionKey: "global", agentId: "work" }],
      ["run-hidden", { sessionKey: "agent:main:hidden", projectSessionActive: false }],
    ]),
  );
  registerAgentRunContext("projected-key", {
    projectSessionActive: true,
    sessionKey: "agent:main:projected",
  });
  registerAgentRunContext("projected-id", {
    projectSessionActive: true,
    agentId: "main",
    sessionId: "session-projected",
  });
  try {
    const project = createVisibleActiveSessionRunProjector();
    const cases = [
      { requestedKey: "agent:main:main", canonicalKey: "agent:main:main" },
      { requestedKey: "agent:main:projected", canonicalKey: "agent:main:projected" },
      {
        requestedKey: "agent:main:by-id",
        canonicalKey: "agent:main:by-id",
        sessionId: "session-projected",
      },
      {
        requestedKey: "global",
        canonicalKey: "global",
        agentId: "work",
        defaultAgentId: "main",
      },
      { requestedKey: "agent:main:missing", canonicalKey: "agent:main:missing" },
    ];
    for (const activeCase of cases) {
      expect(project({ storePath, ...activeCase })).toEqual(
        resolveVisibleActiveSessionRunState({ storePath, ...activeCase }),
      );
    }
  } finally {
    clearAgentRunContext("projected-key");
    clearAgentRunContext("projected-id");
  }
});

it.each(["session-1", " session-1 "])(
  "matches session-id-only gateway runs through the public projector (%j)",
  async (selectedSessionId) => {
    rpcSourceTesting.reset(
      await activeSources([
        [
          "run-1",
          {
            sessionId: "session-1",
            controlUiVisible: true,
            projectSessionActive: true,
          },
        ],
      ]),
    );

    const project = createVisibleActiveSessionRunProjector();
    expect(
      project({
        requestedKey: "agent:main:child",
        canonicalKey: "agent:main:child",
        sessionId: selectedSessionId,
        defaultAgentId: "main",
      }),
    ).toMatchObject({ active: true, runIds: ["run-1"] });
  },
);

it("returns deterministic protocol IDs for matching exact sources", async () => {
  rpcSourceTesting.reset(
    await activeSources([
      [
        "run-z",
        {
          sessionKey: "main",
          sessionId: "selected",
          storeScope: storePath,
        },
      ],
      [
        "run-a",
        {
          sessionKey: "main",
          sessionId: "selected",
          storeScope: storePath,
          queued: true,
        },
      ],
      [
        "run-hidden",
        { sessionKey: "main", sessionId: "selected", controlUiVisible: false, queued: true },
      ],
      ["run-other", { sessionKey: "other" }],
    ]),
  );

  expect(
    resolveVisibleActiveSessionRunState({
      storePath,
      requestedKey: "main",
      canonicalKey: "main",
      agentId: "main",
      defaultAgentId: "main",
    }),
  ).toEqual({ active: true, runIds: ["run-a", "run-z"] });
});

it("projects a lifecycle-owned worker run without widening event visibility", async () => {
  const run = makeRun("worker");
  run.register({
    isControlUiVisible: false,
    projectSessionActive: true,
  });
  expect(run.state()).toEqual({ active: true });
});

it("projects native lifecycle snapshots and admits the next backend after producer completion", async () => {
  const run = makeRun("reply-settling");
  const { sessionKey, sessionId } = run;
  const project = createVisibleActiveSessionRunProjector();
  const state = () =>
    project({ storePath, requestedKey: sessionKey, canonicalKey: sessionKey, sessionId });
  const expectSnapshot = (status: "queued" | "running" | "done", hasActiveRun = true) =>
    expect(
      buildGatewaySessionSnapshot({
        sessionRow: { key: sessionKey, sessionId, kind: "direct", updatedAt: 1, status: "done" },
        activeRunState: state(),
      }),
    ).toMatchObject({ status, hasActiveRun, session: { status, hasActiveRun } });
  const operation = run.reply();
  const expectLaneWaitVisible = () => {
    operation.markWaitingForGlobalLane();
    expectSnapshot("queued");
    operation.markGlobalLaneWaitEnded();
  };
  expectSnapshot("queued");

  expectLaneWaitVisible();

  operation.setPhase("running");
  expectLaneWaitVisible();
  markReplyOperationExecutionStarted(operation);
  expectSnapshot("running");
  expectLaneWaitVisible();
  expectSnapshot("running");
  expect(operation.abortByUser()).toBe(true);
  expect(isSessionRunActive(sessionId)).toBe(true);
  expect(run.state()).toEqual({ active: false, runIds: [] });

  operation.complete();
  await operation.ownerSettlement;
  expectSnapshot("done", false);
  run.embed({ runId: undefined, isAborted: () => false });
  expectSnapshot("running");
});

it("preserves an independent running worker over a queued native snapshot", async () => {
  const sessionKey = "agent:main:worker-overlap";
  const sessionId = "worker-overlap-session";
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  const snapshot = () =>
    buildGatewaySessionSnapshot({
      sessionRow: { key: sessionKey, sessionId, kind: "direct", updatedAt: 1, status: "done" },
      activeRunState: resolveState(sessionKey, { sessionId }),
    });
  registerAgentRunContext("worker-overlap-run", {
    projectSessionActive: true,
    sessionId,
    sessionKey,
  });
  try {
    expect(snapshot()).toMatchObject({
      status: "running",
      hasActiveRun: true,
      session: { status: "running", hasActiveRun: true },
    });
    clearAgentRunContext("worker-overlap-run");
    expect(snapshot()).toMatchObject({
      status: "queued",
      hasActiveRun: true,
      session: { status: "queued", hasActiveRun: true },
    });
  } finally {
    operation.complete();
    clearAgentRunContext("worker-overlap-run");
  }
});

it("does not project an aborted embedded handle retained for cleanup as active", async () => {
  const run = makeRun("handle-settling");
  const { sessionKey, sessionId, state } = run;
  let aborted = false;
  const handle = run.embed({
    runId: undefined,
    abort: () => {
      aborted = true;
    },
    isAborted: () => aborted,
    // Prompt completion closes steering before post-turn finalization. That
    // state alone must not make a normally finishing run disappear.
    isStopped: () => true,
    isStreaming: () => false,
  });
  try {
    expect(state()).toEqual({ active: true });

    expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
    expect(isSessionRunActive(sessionId)).toBe(true);
    expect(state()).toEqual({ active: false, runIds: [] });

    const source = createRpcSourceForTest(
      {},
      { storeScope: storePath, sessionId, sessionKey, accepted: true },
    );
    rpcSourceTesting.reset([["new-run", source]]);
    let admitted = false;
    const successor = claimRpcSourceForTest(source).then((release) => {
      admitted = true;
      cleanups.push(release);
    });
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(
      resolveVisibleActiveSessionRunState({
        storePath,
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: ["new-run"], status: "queued" });
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    await successor;
    expect(
      resolveVisibleActiveSessionRunState({
        storePath,
        requestedKey: sessionKey,
        canonicalKey: sessionKey,
        sessionId,
      }),
    ).toEqual({ active: true, runIds: ["new-run"] });
  } finally {
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
  }
});

it("counts settled but still registered chat runs for a session key", async () => {
  rpcSourceTesting.reset(
    await activeSources([
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
  );

  expect(
    hasRegisteredChatRunForSessionKey({
      storePath,
      sessionKey: "agent:main:main",
      agentId: undefined,
    }),
  ).toBe(true);
  expect(
    hasRegisteredChatRunForSessionKey({
      storePath,
      sessionKey: "agent:other:other",
      agentId: undefined,
    }),
  ).toBe(false);
  expect(
    hasRegisteredChatRunForSessionKey({ storePath, sessionKey: "global", agentId: "work" }),
  ).toBe(true);
  expect(
    hasRegisteredChatRunForSessionKey({ storePath, sessionKey: "global", agentId: "other" }),
  ).toBe(false);
  expect(
    hasRegisteredChatRunForSessionKey({ storePath, sessionKey: "global", agentId: undefined }),
  ).toBe(false);
});

it("matches colliding bare active runs by captured owner", async () => {
  rpcSourceTesting.reset(
    await activeSources([
      ["run-ops", { sessionKey: "incident-42", agentId: "ops" }],
      ["run-research", { sessionKey: "incident-42", agentId: "research" }],
    ]),
  );

  expect(
    resolveVisibleActiveSessionRunState({
      storePath,
      requestedKey: "incident-42",
      canonicalKey: "incident-42",
      agentId: "ops",
      defaultAgentId: "ops",
    }),
  ).toEqual({ active: true, runIds: ["run-ops"] });
  expect(
    resolveVisibleActiveSessionRunState({
      storePath,
      requestedKey: "incident-42",
      canonicalKey: "incident-42",
      agentId: "research",
      defaultAgentId: "ops",
    }),
  ).toEqual({ active: true, runIds: ["run-research"] });
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
    resolveState("incident-42", {
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
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionId = "adopted-global-session";
      const adoptedStorePath = state.statePath("adopted-global.sqlite");
      const operation = createControllerOperation({
        sessionKey: sourceKey,
        sessionId,
        agentId: "main",
        resetTriggered: false,
        target: captureSessionTarget({
          storeScope: adoptedStorePath,
          sessionKey: sourceKey,
          incarnation: sessionId,
          agentId: "main",
        }),
      });
      const destination = await submitSessionControllerTask("global", {
        target: captureSessionTarget({
          storeScope: adoptedStorePath,
          sessionKey: "global",
          incarnation: sessionId,
          agentId: "ops",
        }),
        start: () => {},
      });
      try {
        const admission = await admitReplyTurn({
          mailboxClaim: destination,
          storePath: adoptedStorePath,
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
              storePath: adoptedStorePath,
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
        releaseSessionControllerClaim(destination);
        await destination.settlement.promise;
        await operation.ownerSettlement;
      }
    });
  },
);

it.each(["store", "Gateway"] as const)(
  "excludes another %s's source with the same logical session",
  async (dimension) => {
    const sessionKey = "agent:main:scoped-projection";
    const sessionId = "scoped-projection-session";
    const source = createRpcSourceForTest(
      {},
      {
        sessionKey,
        sessionId,
        agentId: "main",
        storeScope: dimension === "store" ? `${storePath}-other` : storePath,
      },
    );
    rpcSourceTesting.reset([["foreign-run", source]]);
    cleanups.push(await claimRpcSourceForTest(source));
    if (dimension === "Gateway") {
      const resolver = () => undefined;
      bindGatewayContextResolver(source.input, resolver);
      bindGatewayContextResolver(source.input.claim!.operation!, resolver);
    }
    expect(resolveState(sessionKey, { sessionId })).toEqual({ active: false, runIds: [] });
    expect(hasRegisteredChatRunForSessionKey({ storePath, sessionKey, agentId: "main" })).toBe(
      false,
    );
  },
);

it("projects only recorded capacity waits as queued and preserves independent running owners", async () => {
  const run = makeRun("capacity-wait");
  const { sessionKey, sessionId, runId } = run;
  run.register({ agentId: "main" });
  rpcSourceTesting.clear();
  const registration = registerChatRun(sessionKey, sessionId, runId);
  const { state } = registration;
  if (!registration.entry) {
    throw new Error("Missing RPC source");
  }
  cleanups.push(await claimRpcSourceForTest(registration.entry));
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
  expect(resolveState(run.sessionKey, {})).toEqual({ active: false, runIds: [] });
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
  const operation = getSessionControllerOperation(sessionKey);
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
    });
  let settled = false;
  const cleanup = waitForSessionRunEnd(sessionId, null).then((ended) => {
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
    expect(isSessionRunActive(sessionId)).toBe(true);
    expect(operation?.phase).toBe("running");
    expect(operation?.result).toBeNull();
    clearAgentRunContext(runId);
    expect.soft(state()).toEqual({ active: false, runIds: [] });
    expect(getSessionControllerOperation(sessionKey)).toBe(operation);
    expect(operation?.result).toBeNull();
    expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
    expect(aborted).toBe(true);
    expect(isSessionRunActive(sessionId)).toBe(true);
    expect(operation?.result).toMatchObject({ kind: "aborted" });
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    clearAgentRunContext(runId);
    await expect(cleanup).resolves.toBe(true);
  }
});

it.each(["reply", "remote"] as const)(
  "preserves visible %s activity without overlapping hidden controller ownership",
  async (kind) => {
    const run = makeRun(`hidden-with-${kind}`);
    const { sessionKey, sessionId, state } = run;
    const visibleRunId = `visible-${kind}`;
    run.register({ projectSessionActive: false });
    const handle = run.embed();
    const nativeOperation = getSessionControllerOperation(sessionKey);
    expect(nativeOperation?.result).toBeNull();
    let reply: ReturnType<typeof createReplyOperation> | undefined;
    if (kind === "reply") {
      expect(() => createReplyOperation({ sessionKey, sessionId, resetTriggered: false })).toThrow(
        "already active",
      );
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
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
    expect(nativeOperation?.result).toEqual(kind === "reply" ? { kind: "completed" } : null);
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
