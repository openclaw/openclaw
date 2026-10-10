import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
// Sessions tool tests cover list/send helpers and session delivery target resolution.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  getOwnedSessionTranscriptWriterFence,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createSessionsChannelTestRegistry } from "./sessions-channel-fixture.test-support.js";
import {
  registerSessionsSendFixedOwnerTests,
  registerSessionsSendMaterializationTests,
} from "./sessions-send-materialization.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-exact-session-send-");

const callGatewayMock = vi.fn();
const inProcessCreationMock = vi.fn(
  async (..._args: [unknown, unknown, unknown]): Promise<unknown> => ({}),
);
const recordParticipantMock = vi.fn();
// Default false mirrors running outside a gateway process; the trusted-creation
// regression test flips it on and restores it.
let inProcessGatewayContextAvailable = false;

vi.mock("../../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/call.js")>();
  return {
    ...actual,
    callGateway: (opts: unknown) => callGatewayMock(opts),
  };
});
// mock-isolation: Keep transport inside this fixture; real loopback and admission have Gateway integration coverage.
vi.mock("./in-process-gateway.js", () => ({
  bindAgentToolGatewayRequest: () => callGatewayMock,
  callAgentToolGatewayRequest: (opts: unknown) => callGatewayMock(opts),
  callInProcessGatewayToolWithCreation: (method: unknown, params: unknown, creation: unknown) =>
    inProcessCreationMock(method, params, creation),
  hasInProcessGatewayToolContext: () => inProcessGatewayContextAvailable,
  getInProcessGatewayToolContext: () => undefined,
  hasGatewayToolRoutingContext: () => false,
  runWithGatewayToolCleanupContext: <T>(run: () => T): T => run(),
  runWithGatewayToolContinuationContext: async <T>(run: () => Promise<T>): Promise<T> => run(),
}));

type SessionsToolTestConfig = {
  agents?: OpenClawConfig["agents"];
  session: {
    scope: "per-sender";
    mainKey: string;
    store?: string;
  };
  tools: {
    agentToAgent: { enabled: boolean };
    sessions?: { visibility: "self" | "tree" | "agent" | "all" };
  };
};

const loadConfigMock = vi.fn<() => SessionsToolTestConfig>(() => ({
  session: { scope: "per-sender", mainKey: "main" },
  tools: { agentToAgent: { enabled: false } },
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => loadConfigMock() as never,
  };
});
vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: vi.fn(),
}));
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: (...args: unknown[]) => recordParticipantMock(...args),
}));

let createSessionsListTool: typeof import("./sessions-list-tool.js").createSessionsListTool;
let createSessionsSendTool: typeof import("./sessions-send-tool.js").createSessionsSendTool;
let resolveSessionsSendReplyTarget: (typeof import("./sessions-delivery-target.js"))["resolveSessionsSendReplyTarget"];
let setActivePluginRegistry: (typeof import("../../plugins/runtime.js"))["setActivePluginRegistry"];
const MAIN_AGENT_SESSION_KEY = "agent:main:main";
const MAIN_AGENT_CHANNEL = "whatsapp";
const PEER_ONLY_ROUTING_CONFIG: Pick<OpenClawConfig, "agents" | "bindings"> = {
  agents: { ownership: "explicit", entries: { main: {}, other: {} } },
  bindings: [
    {
      type: "route",
      agentId: "main",
      match: { channel: "feishu", peer: { kind: "group", id: "peer-1" } },
    },
    {
      type: "route",
      agentId: "main",
      match: { channel: "slack", peer: { kind: "channel", id: "peer-1" } },
    },
    {
      type: "route",
      agentId: "main",
      match: { channel: "feishu", peer: { kind: "direct", id: "peer-2" } },
    },
    {
      type: "route",
      agentId: "other",
      match: { channel: "discord", peer: { kind: "group", id: "ops" } },
    },
  ],
};
const requireRecord = createRequireRecord("record", "expected-label");

function requireDetails(result: { details?: unknown }, label = "result details") {
  return requireRecord(result.details, label);
}

function requireSessions(details: Record<string, unknown>) {
  const sessions = details.sessions;
  if (!Array.isArray(sessions)) {
    throw new Error("expected details.sessions");
  }
  return sessions.map((session, index) => requireRecord(session, `session ${index}`));
}

function requireGatewayRequest(index = 0) {
  return requireRecord(callGatewayMock.mock.calls[index]?.[0], `gateway request ${index}`);
}

beforeAll(async () => {
  ({ createSessionsListTool } = await import("./sessions-list-tool.js"));
  ({ createSessionsSendTool } = await import("./sessions-send-tool.js"));
  ({ resolveSessionsSendReplyTarget } = await import("./sessions-delivery-target.js"));
  ({ setActivePluginRegistry } = await import("../../plugins/runtime.js"));
});

const installRegistry = () =>
  setActivePluginRegistry(
    createSessionsChannelTestRegistry([
      {
        id: "discord",
        label: "Discord",
        chatTypes: ["direct", "channel", "thread"],
        resolveConversation: false,
      },
      {
        id: "feishu",
        label: "Feishu",
        chatTypes: ["direct", "group"],
        preferSessionLookupForAnnounceTarget: true,
      },
      {
        id: "whatsapp",
        label: "WhatsApp",
        chatTypes: ["direct", "group"],
        preferSessionLookupForAnnounceTarget: true,
      },
      {
        id: "slack",
        label: "Slack",
        chatTypes: ["direct", "channel", "thread"],
        preferSessionLookupForAnnounceTarget: true,
      },
    ]),
  );

function createMainSessionsListTool() {
  return createSessionsListTool({ agentSessionKey: MAIN_AGENT_SESSION_KEY });
}

async function executeMainSessionsList() {
  return createMainSessionsListTool().execute("call1", {});
}

function createMainSessionsSendTool() {
  return createSessionsSendTool({
    agentSessionKey: MAIN_AGENT_SESSION_KEY,
    agentChannel: MAIN_AGENT_CHANNEL,
  });
}

async function executeFireAndForgetA2AFrom(
  requesterSessionKey: string,
  options?: { expectReplyFlow?: boolean },
) {
  setActivePluginRegistry(createSessionConversationTestRegistry());
  const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
  vi.mocked(runSessionsSendA2AFlow).mockClear();
  const targetSessionKey = "agent:other:discord:group:ops";
  loadConfigMock.mockReturnValue({
    session: { scope: "per-sender", mainKey: "main" },
    tools: {
      agentToAgent: { enabled: true },
      sessions: { visibility: "all" },
    },
  });
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "sessions.list") {
      return {
        path: "/tmp/sessions.json",
        sessions: [{ key: targetSessionKey, kind: "group" }],
      };
    }
    if (request.method === "agent") {
      return { runId: "run-fire-and-forget", acceptedAt: 123 };
    }
    return {};
  });
  const tool = createSessionsSendTool({
    agentSessionKey: requesterSessionKey,
    agentChannel: "telegram",
  });

  const result = await tool.execute("call-fire-and-forget", {
    sessionKey: targetSessionKey,
    message: "ping",
    timeoutSeconds: 0,
  });

  expect(requireDetails(result).status).toBe("accepted");
  expect(recordParticipantMock).toHaveBeenCalledWith(
    expect.objectContaining({
      identity: { type: "agent", id: "main" },
      agentId: "other",
      sessionKey: targetSessionKey,
    }),
  );
  const flowParams = vi.mocked(runSessionsSendA2AFlow).mock.calls[0]?.[0];
  if (options?.expectReplyFlow === false) {
    expect(requireDetails(result)).toMatchObject({ delivery: { status: "skipped" } });
  } else if (!flowParams) {
    throw new Error("expected A2A flow");
  }
  return flowParams!;
}

beforeEach(async () => {
  for (const [agentId, sessionKey] of [
    ["main", MAIN_AGENT_SESSION_KEY],
    ["main", "agent:main:other"],
    ["other", "agent:other:discord:group:ops"],
  ] as const) {
    await upsertSessionEntryCore({ agentId, sessionKey }, { sessionId: sessionKey, updatedAt: 1 });
  }
  recordParticipantMock.mockClear();
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({
    session: { scope: "per-sender", mainKey: "main" },
    tools: { agentToAgent: { enabled: false } },
  });
  setActivePluginRegistry(createTestRegistry([]));
});

it("fails closed for cross-agent and resolution-derived bare keys", async () => {
  const bareKey = "b0d79b63-0f73-4bc9-a6b5-6d8e20f42c3c";
  const config = {
    agents: { ownership: "explicit" as const, entries: { main: {}, other: {} } },
    tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" as const } },
  };
  const send = async () =>
    requireDetails(
      await createSessionsSendTool({
        agentId: "main",
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        config,
      }).execute("authorization", {
        sessionKey: bareKey,
        message: "status?",
        timeoutSeconds: 0,
      }),
    );
  callGatewayMock
    .mockReset()
    .mockImplementation(async (request: { method?: string }) =>
      request.method === "sessions.resolve" ? { key: "incident-42", agentId: "other" } : {},
    );
  expect(await send()).toMatchObject({
    status: "forbidden",
    error: expect.stringContaining("Agent-to-agent messaging is disabled"),
  });
  callGatewayMock
    .mockReset()
    .mockImplementation(async (request: { method?: string; params?: Record<string, string> }) => {
      if (request.method !== "sessions.resolve") {
        return {};
      }
      if (request.params?.key) {
        throw new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: `No session found: ${request.params.key}`,
        });
      }
      return request.params?.sessionId ? { key: "incident-42" } : {};
    });
  expect(await send()).toMatchObject({
    status: "forbidden",
    error: expect.stringContaining("Upgrade the gateway"),
  });
});

registerSessionsSendFixedOwnerTests({
  createTool: (options) => createSessionsSendTool(options),
  callGatewayMock,
  requireDetails,
  sessionDirs,
});

describe("resolveSessionsSendReplyTarget", () => {
  beforeEach(async () => {
    callGatewayMock.mockClear();
    installRegistry();
  });

  it("derives non-WhatsApp delivery targets from the session key", async () => {
    const target = await resolveSessionsSendReplyTarget({
      sessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
      callGateway: callGatewayMock,
    });
    expect(target).toEqual({ channel: "discord", to: "group:dev" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("hydrates delivery from the canonical external projection", async () => {
    callGatewayMock.mockResolvedValueOnce({
      session: {
        key: "agent:main:feishu:direct:ou_user",
        deliveryContext: {
          channel: "feishu",
          to: "user:ou_user",
          accountId: "work",
          threadId: "thread-77",
        },
      },
    });

    const target = await resolveSessionsSendReplyTarget({
      sessionKey: "agent:main:feishu:direct:ou_user",
      displayKey: "agent:main:feishu:direct:ou_user",
      callGateway: callGatewayMock,
    });
    expect(target).toEqual({
      channel: "feishu",
      to: "user:ou_user",
      accountId: "work",
      threadId: "thread-77",
    });
  });

  it("preserves threaded Slack session keys when sessions.describe lacks stored thread metadata", async () => {
    callGatewayMock.mockResolvedValueOnce({
      session: {
        key: "agent:main:slack:channel:C123:thread:1710000000.000100",
        deliveryContext: {
          channel: "slack",
          to: "channel:C123",
          accountId: "workspace",
        },
      },
    });

    const target = await resolveSessionsSendReplyTarget({
      sessionKey: "agent:main:slack:channel:C123:thread:1710000000.000100",
      displayKey: "agent:main:slack:channel:C123:thread:1710000000.000100",
      callGateway: callGatewayMock,
    });
    expect(target).toEqual({
      channel: "slack",
      to: "channel:C123",
      accountId: "workspace",
      threadId: "1710000000.000100",
    });
  });
});

describe("sessions_list gating", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    callGatewayMock.mockImplementation(
      (request: { method?: string; params?: { spawnedBy?: string } }) => {
        if (request.method === "sessions.list" && request.params?.spawnedBy) {
          return Promise.resolve({ path: "/tmp/sessions.json", sessions: [] });
        }
        return Promise.resolve({
          path: "/tmp/sessions.json",
          sessions: [
            { key: "agent:main:main", kind: "direct" },
            { key: "agent:other:main", kind: "direct" },
          ],
        });
      },
    );
  });

  it("keeps requester-owned cross-agent rows with tree visibility without a spawned lookup", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "tree" },
      },
    });
    callGatewayMock.mockResolvedValueOnce({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:codex:acp:child-1",
          kind: "direct",
          spawnedBy: MAIN_AGENT_SESSION_KEY,
        },
      ],
    });

    const result = await createMainSessionsListTool().execute("call1", {});

    const details = requireDetails(result);
    expect(details.count).toBe(1);
    const session = requireSessions(details)[0];
    expect(session?.key).toBe("agent:codex:acp:child-1");
    expect(session?.parentSessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("keeps literal current keys for message previews", async () => {
    callGatewayMock.mockReset();
    callGatewayMock
      .mockResolvedValueOnce({
        path: "/tmp/sessions.json",
        sessions: [{ key: "current", kind: "direct" }],
      })
      .mockResolvedValueOnce({ messages: [{ role: "assistant", content: [] }] });

    await createMainSessionsListTool().execute("call1", { messageLimit: 1 });

    expect(callGatewayMock).toHaveBeenLastCalledWith({
      method: "chat.history",
      params: { sessionKey: "current", agentId: "main", limit: 1 },
    });
  });
});

describe("sessions_list channel derivation", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "all" },
      },
    });
  });

  it("falls back to origin.provider when the legacy top-level channel field is missing", async () => {
    callGatewayMock.mockResolvedValueOnce({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:discord:group:ops",
          kind: "group",
          origin: { provider: "discord" },
        },
      ],
    });
    const result = await executeMainSessionsList();

    const details = requireDetails(result);
    const session = requireSessions(details)[0];
    expect(session?.key).toBe("agent:main:discord:group:ops");
    expect(session?.channel).toBe("discord");
  });
});

describe("sessions_send gating", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("returns an error when neither sessionKey nor label is provided", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-missing-target", {
      message: "hi",
      timeoutSeconds: 5,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect(details.error).toBe("Either sessionKey or label is required");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([" \n\t "])("rejects blank message %j before forwarding", async (message) => {
    await expect(
      createMainSessionsSendTool().execute("blank-body", {
        sessionKey: MAIN_AGENT_SESSION_KEY,
        message,
        timeoutSeconds: 0,
      }),
    ).rejects.toThrow("message required");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each(["1sec"])("rejects invalid timeoutSeconds value %s", async (timeoutSeconds) => {
    const tool = createMainSessionsSendTool();

    await expect(
      tool.execute("call-invalid-timeout", {
        sessionKey: MAIN_AGENT_SESSION_KEY,
        message: "hi",
        timeoutSeconds,
      }),
    ).rejects.toThrow("timeoutSeconds must be a non-negative integer");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("returns an error when label resolution fails", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("No session found with label: nope"));
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-missing-label", {
      label: "nope",
      message: "hello",
      timeoutSeconds: 5,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "No session found with label",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
  });

  it("rejects an unrepresentable agent id before resolving a main session", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-invalid-agent", {
      agentId: "агент✨",
      message: "hello",
      timeoutSeconds: 5,
    });

    expect(requireDetails(result)).toMatchObject({
      status: "error",
      error: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("conceals missing explicit keys denied by session visibility", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("No session found: agent:main:missing"));
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      callGateway: callGatewayMock,
      config: {
        session: { scope: "per-sender", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: false },
          sessions: { visibility: "self" },
        },
      } as never,
    });

    const result = await tool.execute("call-hidden-missing-key", {
      sessionKey: "agent:main:missing",
      message: "hi",
      timeoutSeconds: 0,
    });

    expect(requireDetails(result).status).toBe("forbidden");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
  });

  it("prefers sessionKey over a redundant label", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-session-key-label", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      label: "stale-label",
      message: "    indented body",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details).toMatchObject({
      status: "accepted",
      sessionKey: MAIN_AGENT_SESSION_KEY,
    });
    expect(callGatewayMock.mock.calls).toContainEqual([
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          sessionKey: MAIN_AGENT_SESSION_KEY,
          message: expect.stringMatching(/\n {4}indented body$/u),
        }),
      }),
    ]);
    expect(callGatewayMock.mock.calls).not.toContainEqual([
      expect.objectContaining({
        method: "sessions.resolve",
        params: expect.objectContaining({ label: "stale-label" }),
      }),
    ]);
  });

  it.each([
    { targetKey: "agent:main:dashboard:child", timeoutSeconds: 0 },
    { targetKey: "agent:main:subagent:child", timeoutSeconds: 1 },
  ])(
    "keeps an exact-incarnation send scoped ($targetKey, wait $timeoutSeconds)",
    async ({ targetKey: targetSessionKey, timeoutSeconds }) => {
      const requesterSessionKey = MAIN_AGENT_SESSION_KEY;
      const dir = sessionDirs.make();
      const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
      vi.mocked(runSessionsSendA2AFlow).mockClear();
      const storePath = path.join(dir, "sessions.json");
      const targetSessionId = "child-incarnation";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: requesterSessionKey, storePath },
        { sessionId: "requester-incarnation", updatedAt: 1 },
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: targetSessionKey, storePath },
        {
          sessionId: targetSessionId,
          updatedAt: 1,
          parentSessionKey: requesterSessionKey,
          spawnedBy: requesterSessionKey,
        },
      );
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "sessions.list") {
          return {
            path: storePath,
            sessions: [{ key: targetSessionKey, kind: "direct" }],
          };
        }
        if (request.method === "agent") {
          return { runId: "run-exact-send", acceptedAt: 123 };
        }
        if (request.method === "agent.wait") {
          return { runId: "run-exact-send", status: "timeout" };
        }
        return {};
      });
      const tool = createSessionsSendTool({
        agentSessionKey: requesterSessionKey,
        expectedTargetSessionId: targetSessionId,
        completionOwner: "caller",
        idempotencyKey: "worker-session-send:stable-operation",
        callGateway: callGatewayMock,
        config: {
          ...PEER_ONLY_ROUTING_CONFIG,
          session: { scope: "per-sender", mainKey: "main", store: storePath },
          tools: {
            agentToAgent: { enabled: true },
            sessions: { visibility: "all" },
          },
        } as never,
      });

      const result = await tool.execute("call-exact-send", {
        sessionKey: targetSessionKey,
        message: "ping",
        timeoutSeconds,
        watch: true,
      });

      expect(requireDetails(result)).toMatchObject({
        status: "accepted",
        sessionKey: targetSessionKey,
        targetDisposition: "queued",
        delivery: { status: "skipped" },
        watched: false,
      });
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
      expect(
        callGatewayMock.mock.calls.filter(([request]) => request.method === "agent.wait"),
      ).toHaveLength(timeoutSeconds);
      expect(callGatewayMock).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "agent",
          params: expect.objectContaining({
            idempotencyKey: "worker-session-send:stable-operation",
            sessionKey: targetSessionKey,
            inputProvenance: expect.objectContaining({ sourceSessionKey: requesterSessionKey }),
          }),
        }),
      );
    },
  );

  it("does not disclose a resolved session key when sessionId access is denied", async () => {
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      callGateway: callGatewayMock,
      config: {
        session: { scope: "per-sender", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: false },
          sessions: { visibility: "tree" },
        },
      } as never,
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.resolve") {
        if (request.params?.key === "session-id-only") {
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "No session found: session-id-only",
          });
        }
        if (request.params?.spawnedBy === MAIN_AGENT_SESSION_KEY) {
          return {};
        }
        return { key: "agent:other:main" };
      }
      if (request.method === "sessions.list") {
        if (request.params?.spawnedBy === MAIN_AGENT_SESSION_KEY) {
          return {
            path: "/tmp/sessions.json",
            sessions: [],
          };
        }
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: "agent:other:main", kind: "direct" }],
        };
      }
      return {};
    });

    const result = await tool.execute("call-denied-session-id", {
      sessionKey: "session-id-only",
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("forbidden");
    expect(details.sessionKey).toBe("session-id-only");
  });

  it("classifies a failed spawned-lookup as lookup-failed for sandboxed sends", async () => {
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
      tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" } },
    });
    callGatewayMock.mockImplementation(async () => {
      // A retryable request-level failure preserves the PR's evidence semantics
      // (transient store read error) while exercising the retryable
      // classification path (review P1: classify before prescribing retry).
      throw new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "simulated transient store read error (evidence)",
        retryable: true,
      });
    });
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      agentChannel: MAIN_AGENT_CHANNEL,
      sandboxed: true,
    });

    const result = await tool.execute("call-lookup-failed", {
      sessionKey: "agent:main:subagent:worker-1",
      message: "hi",
      timeoutSeconds: 0,
    });

    // sessions_send hits the resolution preflight before the direct guard; the
    // failed lookup must surface the same retryable classification, not the
    // generic sandboxed-session denial.
    const details = requireDetails(result);
    expect(details.status).toBe("forbidden");
    expect(String(details.error)).toBe(
      "Session send denied because spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.",
    );
    expect(String(details.error)).not.toContain(
      "Session not visible from this sandboxed agent session",
    );
  });

  it("rejects label targets that resolve to canonical thread sessions", async () => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
    const threadSessionKey = "agent:main:discord:channel:123456:thread:987654";
    callGatewayMock.mockResolvedValueOnce({ key: threadSessionKey });
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-thread-label", {
      label: "active thread",
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe(threadSessionKey);
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "cannot target a thread session",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
    expect(requireGatewayRequest(1).method).toBe("sessions.resolve");
  });

  it("does not disclose a resolved thread session key from a sessionId target", async () => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
    const threadSessionKey = "agent:other:discord:channel:123456:thread:987654";
    callGatewayMock.mockResolvedValueOnce({ key: threadSessionKey });
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-thread-session-id", {
      sessionKey: "thread-session-id",
      message: "hi",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("error");
    expect(details.sessionKey).toBe("thread-session-id");
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "cannot target a thread session",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
  });

  it("rejects synchronous sends to the raw legacy direct-message caller", async () => {
    const requesterSessionKey = "agent:main:feishu:direct:peer-1";
    callGatewayMock.mockResolvedValueOnce({ key: requesterSessionKey });
    const tool = createSessionsSendTool({
      agentSessionKey: requesterSessionKey,
      agentChannel: "feishu",
    });

    const result = await tool.execute("call-legacy-direct-self-send", {
      sessionKey: "current",
      message: "use this as my reply",
    });

    expect(requireDetails(result)).toMatchObject({
      status: "error",
      error: "sessions_send cannot target the calling session; use your own reply instead",
      sessionKey: "current",
    });
    expect(callGatewayMock.mock.calls).not.toContainEqual([
      expect.objectContaining({ method: "agent" }),
    ]);
  });

  it("reports a terminal silent target without leaving an announcement pending", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    const targetSessionKey = "agent:main:other";
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      agentChannel: MAIN_AGENT_CHANNEL,
      config: {
        session: { scope: "per-sender", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: false },
          sessions: { visibility: "all" },
        },
      } as never,
    });
    const freshPrivateFinal = {
      role: "assistant",
      content: [{ type: "text", text: "private final that must stay private" }],
      timestamp: 21,
    };

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: targetSessionKey, kind: "direct" }],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-stale-send", acceptedAt: 123 };
      }
      if (request.method === "agent.wait") {
        return {
          runId: "run-stale-send",
          status: "ok",
          terminalReply: { disposition: "silent" },
        };
      }
      if (request.method === "chat.history") {
        return { messages: [freshPrivateFinal] };
      }
      return {};
    });

    const result = await tool.execute("call-stale-send", {
      sessionKey: targetSessionKey,
      message: "ping",
      timeoutSeconds: 1,
    });

    expect(callGatewayMock.mock.calls.some(([request]) => request.method === "chat.history")).toBe(
      false,
    );
    const details = requireDetails(result);
    expect(details.status).toBe("no_reply");
    expect(details.reply).toBeUndefined();
    expect(details.delivery).toBeUndefined();
    expect(details.message).toContain("pending delivery");
    expect(details.sessionKey).toBe(targetSessionKey);
    expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses source delivery without reading history (visible text: %s)",
    async (hasText) => {
      const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
      vi.mocked(runSessionsSendA2AFlow).mockClear();
      const targetSessionKey = "agent:main:other";
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        agentChannel: MAIN_AGENT_CHANNEL,
        config: {
          session: { scope: "per-sender", mainKey: "main" },
          tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" } },
        } as never,
      });

      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string };
        if (request.method === "sessions.list") {
          return {
            path: "/tmp/sessions.json",
            sessions: [{ key: targetSessionKey, kind: "direct" }],
          };
        }
        if (request.method === "chat.history") {
          return { messages: [] };
        }
        if (request.method === "agent") {
          return { runId: "run-source-reply", acceptedAt: 123 };
        }
        if (request.method === "agent.wait") {
          return {
            runId: "run-source-reply",
            status: "ok",
            terminalReply: hasText
              ? { disposition: "visible", text: "Already delivered to the source" }
              : { disposition: "empty" },
            terminalReceipt: {
              runId: "run-source-reply",
              sessionId: "target-session",
              turnId: "target-turn",
              requested: { provider: "provider", model: "model" },
              effective: { provider: "provider", model: "model", responseModel: "model" },
              successfulToolNames: ["message"],
              sourceReplyDelivered: true,
              rerouted: false,
              terminalDisposition: "visible",
            },
          };
        }
        return {};
      });

      const result = await tool.execute("call-source-reply", {
        sessionKey: targetSessionKey,
        message: "ping",
        timeoutSeconds: 1,
      });

      if (hasText) {
        expect(requireDetails(result)).toMatchObject({
          status: "ok",
          reply: "Already delivered to the source",
          sessionKey: targetSessionKey,
        });
        expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
      } else {
        expect(requireDetails(result)).toMatchObject({
          status: "no_reply",
          message:
            "The target delivered its final reply directly to its source conversation. Do not resend.",
        });
        expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
      }
      expect(
        callGatewayMock.mock.calls.some(([request]) => request.method === "chat.history"),
      ).toBe(false);
    },
  );

  it("detaches fire-and-forget A2A work from parent transcript ownership", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    let inheritedFence: ReturnType<typeof getOwnedSessionTranscriptWriterFence>;
    vi.mocked(runSessionsSendA2AFlow).mockImplementationOnce(async () => {
      inheritedFence = getOwnedSessionTranscriptWriterFence();
    });
    let parentTranscriptWriteCalls = 0;
    const parentTranscriptWrite = async <T>(run: () => Promise<T> | T): Promise<T> => {
      parentTranscriptWriteCalls += 1;
      return await run();
    };

    await withOwnedSessionTranscriptWrites(
      {
        sessionKey: MAIN_AGENT_SESSION_KEY,
        sessionTarget: {
          expectedWriterRunId: "disposed-parent-run",
          sessionKey: MAIN_AGENT_SESSION_KEY,
        },
        withTranscriptWrite: parentTranscriptWrite,
      },
      async () => {
        await executeFireAndForgetA2AFrom(MAIN_AGENT_SESSION_KEY);
      },
    );
    await vi.waitFor(() => expect(runSessionsSendA2AFlow).toHaveBeenCalledOnce());

    expect(inheritedFence).toBeUndefined();
    expect(parentTranscriptWriteCalls).toBe(0);
  });

  it("canonicalizes aliased requester keys for same-session A2A delivery", async () => {
    const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
    vi.mocked(runSessionsSendA2AFlow).mockClear();
    const tool = createSessionsSendTool({
      agentSessionKey: "main",
      agentChannel: MAIN_AGENT_CHANNEL,
      config: {
        session: { scope: "per-sender", mainKey: "main" },
        tools: { agentToAgent: { enabled: false } },
      } as never,
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: MAIN_AGENT_SESSION_KEY, kind: "direct" }],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-alias-fire-and-forget", acceptedAt: 123 };
      }
      return {};
    });

    const result = await tool.execute("call-aliased-fire-and-forget-same-session", {
      sessionKey: MAIN_AGENT_SESSION_KEY,
      message: "ping",
      timeoutSeconds: 0,
    });

    const details = requireDetails(result);
    expect(details.status).toBe("accepted");
    expect(details.sessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    const flowParams = vi.mocked(runSessionsSendA2AFlow).mock.calls[0]?.[0];
    expect(flowParams?.requesterSessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    expect(flowParams?.targetSessionKey).toBe(MAIN_AGENT_SESSION_KEY);
  });

  it.each([
    {
      label: "canonical cron run",
      requesterSessionKey: "agent:main:cron:job:run:abc",
      expected: false,
      expectedRequesterSessionKey: "agent:main:cron:job:run:abc",
    },
    {
      label: "normal requester",
      requesterSessionKey: "agent:main:telegram:direct:user",
      expected: true,
      expectedRequesterSessionKey: "agent:main:telegram:direct:user",
    },
  ] as const)(
    "starts requester delivery only when eligible for a $label",
    async ({ requesterSessionKey, expected, expectedRequesterSessionKey }) => {
      if (!expected) {
        const { runSessionsSendA2AFlow } = await import("./sessions-send-tool.a2a.js");
        await executeFireAndForgetA2AFrom(requesterSessionKey, { expectReplyFlow: false });
        expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
        return;
      }
      const flowParams = await executeFireAndForgetA2AFrom(requesterSessionKey);
      expect(flowParams.requesterSessionKey).toBe(expectedRequesterSessionKey);
    },
  );

  it("caps oversized timeoutSeconds before waiting for the target run", async () => {
    const targetSessionKey = "agent:main:other";
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      agentChannel: MAIN_AGENT_CHANNEL,
      config: {
        session: { scope: "per-sender", mainKey: "main" },
        tools: {
          agentToAgent: { enabled: false },
          sessions: { visibility: "all" },
        },
      } as never,
    });
    const waitTimeouts: unknown[] = [];

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; timeoutMs?: unknown };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: targetSessionKey, kind: "direct" }],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-huge-timeout", acceptedAt: 123 };
      }
      if (request.method === "agent.wait") {
        waitTimeouts.push(request.timeoutMs);
        return {
          runId: "run-huge-timeout",
          status: "ok",
          terminalReply: { disposition: "empty" },
        };
      }
      return {};
    });

    const result = await tool.execute("call-huge-timeout", {
      sessionKey: targetSessionKey,
      message: "ping",
      timeoutSeconds: Number.MAX_SAFE_INTEGER,
    });

    expect(requireDetails(result).status).toBe("no_reply");
    expect(waitTimeouts).toEqual([MAX_TIMER_TIMEOUT_MS]);
  });
});

registerSessionsSendMaterializationTests({
  createTool: (options) => createSessionsSendTool(options),
  agentChannel: MAIN_AGENT_CHANNEL,
  callGatewayMock,
  inProcessCreationMock,
  requireDetails,
  prepare: async () => {
    inProcessGatewayContextAvailable = true;
    const store = path.join(sessionDirs.make(), "sessions.json");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:dashboard:req-provenance", storePath: store },
      { sessionId: "materialization-requester", updatedAt: 1 },
    );
    inProcessCreationMock.mockClear().mockImplementation(async () => {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: MAIN_AGENT_SESSION_KEY, storePath: store },
        { sessionId: "materialized-main", updatedAt: 1 },
      );
      return {};
    });
    loadConfigMock.mockReturnValue({
      session: { scope: "per-sender", mainKey: "main", store },
      tools: {
        agentToAgent: { enabled: false },
        sessions: { visibility: "all" },
      },
    });
  },
  cleanup: () => {
    inProcessGatewayContextAvailable = false;
    inProcessCreationMock.mockClear();
  },
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
