import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildProjectedAgentRunIndex,
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  deletedAgent: vi.fn(),
  latest: vi.fn(),
  live: vi.fn(),
  replace: vi.fn(),
  terminate: vi.fn(),
  send: vi.fn(),
}));
const started = { runId: "run-new", status: "started" };

// mock-isolation: Follow-up routing uses synthetic entries instead of real session stores.
vi.mock("../session-utils.js", () => ({
  prepareDeletedAgentSessionCheck: mocks.deletedAgent,
}));
// mock-isolation: Follow-up routing supplies synthetic entries without a database worker.
vi.mock("../session-utils-store-worker.js", () => ({
  loadGatewaySessionEntryReadOnlyInWorker: async (
    params: Parameters<
      typeof import("../session-utils-store-worker.js").loadGatewaySessionEntryReadOnlyInWorker
    >[0],
  ) => mocks.load(params.key, { agentId: params.agentId }),
}));
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../agents/subagents/registry/subagent-registry-read.js")
  >("../../agents/subagents/registry/subagent-registry-read.js");
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: mocks.latest,
    getLatestLiveSubagentRunByChildSessionKey: (
      ...args: Parameters<typeof actual.getLatestLiveSubagentRunByChildSessionKey>
    ) => {
      const run = mocks.live(...args);
      return run && run.childSessionKey === args[0].trim() && (!args[1] || args[1](run))
        ? run
        : null;
    },
  };
});

// mock-isolation: capture replacement without changing the shared subagent registry.
vi.mock("../../agents/subagents/registry/subagent-registry.js", () => ({
  replaceSubagentRunAfterSteerCore: mocks.replace,
}));
// mock-isolation: observe collector termination without starting cleanup work.
vi.mock("../../agents/subagents/spawn/subagent-spawn-cleanup.js", () => ({
  terminateAcceptedCollectorRun: mocks.terminate,
}));
// mock-isolation: supply send outcomes without executing external chat turns.
vi.mock("./chat-send-external-entry.js", () => ({
  handleDirectExternalChatSend: mocks.send,
}));

import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionMessagingHandlers } from "./sessions-messaging.js";

let context: GatewayRequestContext;

async function send(
  params: Record<string, unknown>,
  method: "sessions.send" | "sessions.steer" = "sessions.send",
) {
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    sessionMessagingHandlers[method],
    method,
  )({
    req: { type: "req", id: method, method },
    params,
    respond,
    context,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

function loadSession(
  canonicalKey: string,
  sessionId: string,
  storePath = "/tmp/sessions.json",
  cfg: OpenClawConfig = {},
) {
  mocks.load.mockReturnValue({ cfg, canonicalKey, storePath, entry: { sessionId } });
}

function completedRun(childSessionKey: string) {
  const run = {
    runId: "run-old",
    childSessionKey,
    controllerSessionKey: "agent:main:main",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "initial task",
    cleanup: "keep" as const,
    createdAt: 1,
    execution: {
      status: "terminal" as const,
      startedAt: 2,
      endedAt: 3,
      outcome: { status: "ok" as const },
    },
  };
  mocks.latest.mockResolvedValue(run);
  mocks.live.mockReturnValue(run);
}

describe("sessions.send completed subagent follow-up status", () => {
  afterEach(() => flushPendingSessionsChangedEvents());
  beforeEach(() => {
    context = {
      chatRunState: { runs: new Map() },
      dedupe: new Map(),
      broadcastToConnIds: vi.fn(),
      getSessionEventSubscriberConnIds: () => new Set<string>(),
      getRuntimeConfig: () => ({}),
    } as unknown as GatewayRequestContext;
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.deletedAgent.mockReturnValue(null);
    mocks.send.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { ...started }, undefined, undefined);
    });
  });

  it("rejects keys belonging to a deleted agent", async () => {
    const key = "agent:deleted-agent:main";
    loadSession(key, "sess-orphan");
    mocks.deletedAgent.mockReturnValue("deleted-agent");
    const respond = await send({ key, message: "hi" });
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Agent "deleted-agent" no longer exists in configuration',
    });
  });

  it("reactivates completed subagent sessions before broadcasting sessions.changed", async () => {
    const state = await createOpenClawTestState({
      label: "session-send-followup",
      applyEnv: false,
    });
    onTestFinished(() => state.cleanup());
    const storePath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
    const childSessionKey = "agent:main:subagent:followup";
    loadSession(childSessionKey, "sess-followup", storePath);
    completedRun(childSessionKey);
    mocks.replace.mockReturnValue(true);
    mocks.send.mockImplementationOnce(async ({ respond }: { respond: RespondFn }) => {
      registerAgentRunContext("run-new", {
        agentId: "main",
        sessionKey: childSessionKey,
        sessionId: "sess-followup",
        projectSessionActive: true,
      });
      projection.state.rowContext.projectedAgentRuns = buildProjectedAgentRunIndex();
      respond(true, { ...started }, undefined, undefined);
    });
    onTestFinished(() => clearAgentRunContext("run-new"));
    const broadcastToConnIds = vi.fn();
    const projection = createSessionRowProjectionFixture({
      cfg: {},
      agentId: "main",
      storePath,
      store: {
        [childSessionKey]: {
          sessionId: "sess-followup",
          updatedAt: 123,
          startedAt: 123,
          runtimeMs: 10,
        },
      },
    });
    onTestFinished(() => projection.dispose());
    Object.assign(context, {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      ...bindSessionRowProjection({}, () => projection),
    });
    const respond = await send({
      key: childSessionKey,
      message: "follow-up",
      idempotencyKey: "run-new",
    });
    await flushPendingSessionsChangedEvents(context);
    expect(respond).toHaveBeenCalledWith(true, started, undefined, undefined);
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("messageSeq");
    expectSubagentFollowupReactivation({
      replaceSubagentRunAfterSteerMock: mocks.replace,
      broadcastToConnIds,
      childSessionKey,
      status: "running",
      task: "follow-up",
    });
  });

  it("terminates a started follow-up when its completed owner cannot be replaced", async () => {
    const childSessionKey = "agent:main:subagent:followup-rejected";
    loadSession(childSessionKey, "sess-followup-rejected");
    completedRun(childSessionKey);
    mocks.replace.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    mocks.terminate.mockResolvedValueOnce(undefined);
    await expect(send({ key: childSessionKey, message: "follow-up" })).rejects.toThrow(
      "database unavailable",
    );
    expect(mocks.terminate).toHaveBeenCalledWith({
      childSessionKey,
      gatewayRunId: "run-new",
      sessionCleanup: "preserve",
    });
  });

  it("sessions.steer replaying a cached idempotency key leaves the active run alone", async () => {
    const sessionKey = "agent:main:main";
    loadSession(sessionKey, "sess-unrelated-run");
    mocks.send.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "steer-retry", status: "completed" }, undefined, { cached: true });
    });
    context.dedupe.set("chat:steer-retry", {
      ts: 1,
      ok: true,
      payload: { runId: "steer-retry" },
    });
    const respond = await send(
      { key: sessionKey, message: "replacement turn", idempotencyKey: "steer-retry" },
      "sessions.steer",
    );
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("interruptedActiveRun");
    expect(respond.mock.calls[0]?.[3]).toMatchObject({ cached: true });
  });

  it("steers the selected global agent with committed receipt and interrupt facts", async () => {
    const cfg = { agents: { entries: { main: {}, work: {} } } };
    context.getRuntimeConfig = () => cfg;
    loadSession("global", "sess-work-global", "/tmp/work/sessions.json", cfg);
    const payload = {
      runId: "run-work",
      status: "started",
      messageSeq: 4,
      interruptedActiveRun: true,
    };
    mocks.send.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, payload);
    });
    const params = {
      agentId: "work",
      message: "@Bob follow-up",
      mentions: [{ profileId: "bob", start: 0, end: 4 }],
      idempotencyKey: "run-work",
    };
    const respond = await send({ key: "global", ...structuredClone(params) }, "sessions.steer");
    expect(mocks.load).toHaveBeenCalledWith("global", { agentId: "work" });
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        params: expect.objectContaining({
          sessionKey: "global",
          ...params,
          queueMode: "interrupt",
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, payload, undefined, undefined);
  });
});
