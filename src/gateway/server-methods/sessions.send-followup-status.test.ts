import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { expectSubagentFollowupReactivation } from "./subagent-followup.test-helpers.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const loadSessionEntryMock = vi.fn();
const loadGatewaySessionEntryReadOnlyMock = vi.fn();
const resolveDeletedAgentIdFromSessionKeyMock = vi.fn();
const getLatestSubagentRunByChildSessionKeyMock = vi.fn();
const getLatestLiveSubagentRunByChildSessionKeyMock = vi.fn();
const replaceSubagentRunAfterSteerMock = vi.fn();
const terminateAcceptedCollectorRunMock = vi.fn();
const chatSendMock = vi.fn();

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: (...args: unknown[]) => loadSessionEntryMock(...args),
  loadGatewaySessionEntryReadOnly: (...args: unknown[]) =>
    loadGatewaySessionEntryReadOnlyMock(...args),
  resolveDeletedAgentIdFromSessionKey: (...args: unknown[]) =>
    resolveDeletedAgentIdFromSessionKeyMock(...args),
}));
vi.mock("../../agents/subagents/registry/subagent-registry-read.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../agents/subagents/registry/subagent-registry-read.js")
  >("../../agents/subagents/registry/subagent-registry-read.js");
  return {
    ...actual,
    getLatestSubagentRunByChildSessionKey: (...args: unknown[]) =>
      getLatestSubagentRunByChildSessionKeyMock(...args),
    getLatestLiveSubagentRunByChildSessionKey: (
      ...args: Parameters<typeof actual.getLatestLiveSubagentRunByChildSessionKey>
    ) => {
      const run = getLatestLiveSubagentRunByChildSessionKeyMock(...args);
      return run && run.childSessionKey === args[0].trim() && (!args[1] || args[1](run))
        ? run
        : null;
    },
  };
});

vi.mock("../../agents/subagents/registry/subagent-registry.js", () => ({
  replaceSubagentRunAfterSteerCore: (...args: unknown[]) =>
    replaceSubagentRunAfterSteerMock(...args),
}));
vi.mock("../../agents/subagents/spawn/subagent-spawn-cleanup.js", () => ({
  terminateAcceptedCollectorRun: (...args: unknown[]) => terminateAcceptedCollectorRunMock(...args),
}));
vi.mock("./chat-send-external-entry.js", () => ({
  handleDirectExternalChatSend: (...args: unknown[]) => chatSendMock(...args),
}));

import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import { flushPendingSessionsChangedEvents } from "./session-change-event.js";
import { sessionMessagingHandlers } from "./sessions-messaging.js";

function createRequestContext(overrides: Record<string, unknown> = {}): GatewayRequestContext {
  return {
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState: { runs: new Map() },
    dedupe: new Map(),
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    getRuntimeConfig: () => ({}),
    ...overrides,
  } as unknown as GatewayRequestContext;
}

async function send(
  params: Record<string, unknown>,
  method: "sessions.send" | "sessions.steer" = "sessions.send",
  context = createRequestContext(),
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
  loadSessionEntryMock.mockReturnValue({ cfg, canonicalKey, storePath, entry: { sessionId } });
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
  getLatestSubagentRunByChildSessionKeyMock.mockResolvedValue(run);
  getLatestLiveSubagentRunByChildSessionKeyMock.mockReturnValue(run);
  return run;
}

describe("sessions.send completed subagent follow-up status", () => {
  afterEach(() => flushPendingSessionsChangedEvents());
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    loadGatewaySessionEntryReadOnlyMock.mockReset();
    resolveDeletedAgentIdFromSessionKeyMock.mockReset().mockReturnValue(null);
    getLatestSubagentRunByChildSessionKeyMock.mockReset();
    getLatestLiveSubagentRunByChildSessionKeyMock.mockReset();
    replaceSubagentRunAfterSteerMock.mockReset();
    terminateAcceptedCollectorRunMock.mockReset();
    chatSendMock.mockReset().mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "run-new", status: "started" }, undefined, undefined);
    });
  });

  it("rejects keys belonging to a deleted agent", async () => {
    const key = "agent:deleted-agent:main";
    loadSession(key, "sess-orphan");
    resolveDeletedAgentIdFromSessionKeyMock.mockReturnValue("deleted-agent");
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
    replaceSubagentRunAfterSteerMock.mockReturnValue(true);
    const broadcastToConnIds = vi.fn();
    const projection = createSessionRowProjectionFixture({
      cfg: {},
      agentId: "main",
      storePath,
      store: {
        [childSessionKey]: {
          sessionId: "sess-followup",
          updatedAt: 123,
          status: "running",
          startedAt: 123,
          runtimeMs: 10,
        },
      },
    });
    onTestFinished(() => projection.dispose());
    const context = createRequestContext({
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      ...bindSessionRowProjection({}, () => projection),
    });
    const respond = await send(
      { key: childSessionKey, message: "follow-up", idempotencyKey: "run-new" },
      "sessions.send",
      context,
    );
    await flushPendingSessionsChangedEvents(context);
    expect(respond).toHaveBeenCalledWith(
      true,
      { runId: "run-new", status: "started" },
      undefined,
      undefined,
    );
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("messageSeq");
    expectSubagentFollowupReactivation({
      replaceSubagentRunAfterSteerMock,
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
    replaceSubagentRunAfterSteerMock.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    terminateAcceptedCollectorRunMock.mockResolvedValueOnce(undefined);
    await expect(send({ key: childSessionKey, message: "follow-up" })).rejects.toThrow(
      "database unavailable",
    );
    expect(terminateAcceptedCollectorRunMock).toHaveBeenCalledWith({
      childSessionKey,
      gatewayRunId: "run-new",
      sessionCleanup: "preserve",
    });
  });

  it("sessions.steer replaying a cached idempotency key leaves the active run alone", async () => {
    const sessionKey = "agent:main:main";
    loadSession(sessionKey, "sess-unrelated-run");
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, { runId: "steer-retry", status: "completed" }, undefined, { cached: true });
    });
    const respond = await send(
      { key: sessionKey, message: "replacement turn", idempotencyKey: "steer-retry" },
      "sessions.steer",
      createRequestContext({
        dedupe: new Map([
          ["chat:steer-retry", { ts: 1, ok: true, payload: { runId: "steer-retry" } }],
        ]),
      }),
    );
    expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("interruptedActiveRun");
    expect(respond.mock.calls[0]?.[3]).toMatchObject({ cached: true });
  });

  it("steers the selected global agent with committed receipt and interrupt facts", async () => {
    const cfg = { agents: { entries: { main: {}, work: {} } } };
    loadSession("global", "sess-work-global", "/tmp/work/sessions.json", cfg);
    const payload = {
      runId: "run-work",
      status: "started",
      messageSeq: 4,
      interruptedActiveRun: true,
    };
    chatSendMock.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
      respond(true, payload);
    });
    const respond = await send(
      {
        key: "global",
        agentId: "work",
        message: "@Bob follow-up",
        mentions: [{ profileId: "bob", start: 0, end: 4 }],
        idempotencyKey: "run-work",
      },
      "sessions.steer",
      createRequestContext({ getRuntimeConfig: () => cfg }),
    );
    expect(loadSessionEntryMock).toHaveBeenCalledWith("global", { agentId: "work" });
    expect(chatSendMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        params: expect.objectContaining({
          sessionKey: "global",
          agentId: "work",
          message: "@Bob follow-up",
          mentions: [{ profileId: "bob", start: 0, end: 4 }],
          idempotencyKey: "run-work",
          queueMode: "interrupt",
        }),
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, payload, undefined, undefined);
  });
});
