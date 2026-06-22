/**
 * Tests agent creation event emission from gateway agent methods.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActiveSessionsForShutdownTracker } from "../active-sessions-shutdown-tracker.js";

const configMocks = vi.hoisted(() => ({
  storePath: "",
  workspaceDir: "",
  getRuntimeConfig: vi.fn(() => ({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        workspace: configMocks.workspaceDir || "/tmp/openclaw-agent-create-event",
      },
    },
    session: {
      mainKey: "main",
      store: configMocks.storePath,
    },
  })),
}));

const agentIngressMocks = vi.hoisted(() => ({
  agentCommandFromIngress: vi.fn(async () => ({ ok: true })),
}));

const taskRuntimeMocks = vi.hoisted(() => ({
  createRunningTaskRun: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: configMocks.getRuntimeConfig,
}));

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromIngress: agentIngressMocks.agentCommandFromIngress,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {},
}));

vi.mock("../../tasks/detached-task-runtime.js", () => ({
  createRunningTaskRun: taskRuntimeMocks.createRunningTaskRun,
}));

import { agentHandlers } from "./agent.js";

function firstMockCall<T extends readonly unknown[]>(mock: { mock: { calls: readonly T[] } }) {
  return mock.mock.calls[0];
}

describe("agent handler session create events", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-create-event-"));
    storePath = path.join(tempDir, "sessions.json");
    configMocks.storePath = storePath;
    configMocks.workspaceDir = tempDir;
    configMocks.getRuntimeConfig.mockClear();
    agentIngressMocks.agentCommandFromIngress.mockClear();
    agentIngressMocks.agentCommandFromIngress.mockResolvedValue({ ok: true });
    taskRuntimeMocks.createRunningTaskRun.mockReset().mockReturnValue({
      taskId: "task-created",
      runtime: "cli",
      status: "running",
    });
    await fs.writeFile(storePath, "{}\n", "utf8");
  });

  afterEach(async () => {
    clearActiveSessionsForShutdownTracker();
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("emits sessions.changed with reason create for new agent sessions", async () => {
    const broadcastToConnIds = vi.fn();
    const respond = vi.fn();

    await agentHandlers.agent({
      params: {
        message: "hi",
        sessionKey: "agent:main:subagent:create-test",
        idempotencyKey: "idem-agent-create-event",
      },
      respond,
      context: {
        dedupe: new Map(),
        deps: {} as never,
        logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
        chatAbortControllers: new Map(),
        addChatRun: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        getRuntimeConfig: configMocks.getRuntimeConfig,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        broadcastToConnIds,
      } as never,
      client: null,
      isWebchatConnect: () => false,
      req: { id: "req-agent-create-event" } as never,
    });

    const responseCall = firstMockCall(respond) as
      | [boolean, { status?: string; runId?: string }, unknown, { runId?: string }]
      | undefined;
    expect(responseCall?.[0]).toBe(true);
    expect(responseCall?.[1]?.status).toBe("accepted");
    expect(responseCall?.[1]?.runId).toBe("idem-agent-create-event");
    expect(responseCall?.[2]).toBeUndefined();
    expect(responseCall?.[3]?.runId).toBe("idem-agent-create-event");
    await vi.waitFor(
      () => {
        const call = firstMockCall(broadcastToConnIds) as
          | [
              string,
              { sessionKey?: string; reason?: string },
              Set<string>,
              { dropIfSlow?: boolean },
            ]
          | undefined;
        expect(call?.[0]).toBe("sessions.changed");
        expect(call?.[1]?.sessionKey).toBe("agent:main:subagent:create-test");
        expect(call?.[1]?.reason).toBe("create");
        expect(call?.[2]).toEqual(new Set(["conn-1"]));
        expect(call?.[3]).toEqual({ dropIfSlow: true });
      },
      { timeout: 2_000, interval: 5 },
    );
  });

  it("tracks Telegram topic agent turns with requester origin even when final delivery is off", async () => {
    const respond = vi.fn();

    await agentHandlers.agent({
      params: {
        message: "topic work",
        agentId: "main",
        sessionKey: "agent:main:telegram:group:-1001234567890:topic:42",
        channel: "telegram",
        to: "telegram:-1001234567890:topic:42",
        threadId: "42",
        deliver: false,
        idempotencyKey: "idem-topic-start-ack",
      },
      respond,
      context: {
        dedupe: new Map(),
        deps: {} as never,
        logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
        chatAbortControllers: new Map(),
        addChatRun: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        getRuntimeConfig: configMocks.getRuntimeConfig,
        getSessionEventSubscriberConnIds: () => new Set(),
        broadcastToConnIds: vi.fn(),
      } as never,
      client: null,
      isWebchatConnect: () => false,
      req: { id: "req-topic-start-ack" } as never,
    });

    await vi.waitFor(() => {
      expect(taskRuntimeMocks.createRunningTaskRun).toHaveBeenCalled();
    });
    expect(taskRuntimeMocks.createRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "cli",
        sourceId: "idem-topic-start-ack",
        ownerKey: "agent:main:telegram:group:-1001234567890:topic:42",
        requesterOrigin: {
          channel: "telegram",
          to: "telegram:-1001234567890:topic:42",
          threadId: "42",
        },
        deliveryStatus: "pending",
      }),
    );
  });
});
