import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  getOwnedSessionTranscriptWriterFence,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
  drainSessionStateForTest,
  useSessionStoreTempDirs,
} from "../../test-utils/session-state-cleanup.js";
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
type A2AFlow = typeof import("./sessions-send-tool.a2a.js").runSessionsSendA2AFlow;
const runSessionsSendA2AFlow = vi.hoisted(() => vi.fn<A2AFlow>());
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

// mock-isolation: Exercise send orchestration without starting A2A agent turns.
vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow,
}));
// mock-isolation: Participant persistence is separate from this mocked Gateway boundary.
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: vi.fn(),
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
      agentId: "other",
      match: { channel: "discord", peer: { kind: "group", id: "ops" } },
    },
  ],
};
const requireRecord = createRequireRecord("record", "expected-label");

function requireDetails(result: { details?: unknown }, label = "result details") {
  return requireRecord(result.details, label);
}

function requireGatewayRequest(index = 0) {
  return requireRecord(callGatewayMock.mock.calls[index]?.[0], `gateway request ${index}`);
}

function sessionList(
  key: string,
  fields: Record<string, unknown> = {},
  storePath = "/tmp/sessions.json",
) {
  return { path: storePath, sessions: [{ key, kind: "direct", ...fields }] };
}

function gatewayParams(method: string) {
  return requireRecord(
    callGatewayMock.mock.calls.find(([request]) => request.method === method)?.[0]?.params,
    `${method} params`,
  );
}

type GatewayRequest = { method?: string; timeoutMs?: unknown };
type GatewayResponses = Record<string, (request: GatewayRequest) => unknown>;

function mockGatewayMethods(responses: GatewayResponses) {
  callGatewayMock.mockImplementation(
    async (request: GatewayRequest) => responses[request.method ?? ""]?.(request) ?? {},
  );
}

function mockTargetRun(sessionKey: string, runId: string, responses: GatewayResponses) {
  mockGatewayMethods({
    "sessions.list": () => sessionList(sessionKey),
    agent: () => ({ runId, acceptedAt: 123 }),
    ...responses,
  });
}

function seedMainSession(
  sessionKey: string,
  sessionId = sessionKey,
  storePath?: string,
  entry: Partial<SessionEntry> = {},
) {
  return upsertSessionEntryCore(
    { agentId: "main", sessionKey, storePath },
    { sessionId, updatedAt: 1, ...entry },
  );
}

function createAllSessionsConfig(
  sessions: NonNullable<NonNullable<OpenClawConfig["tools"]>["sessions"]> = {},
  agentToAgentEnabled = false,
): OpenClawConfig {
  return {
    session: { scope: "per-sender", mainKey: "main" },
    tools: {
      agentToAgent: { enabled: agentToAgentEnabled },
      sessions: { visibility: "all", ...sessions },
    },
  };
}

beforeAll(async () => {
  ({ createSessionsListTool } = await import("./sessions-list-tool.js"));
  const { createSessionsSendTool: createTool } = await import("./sessions-send-tool.js");
  createSessionsSendTool = (options) => {
    if (options?.config) {
      setRuntimeConfigSnapshot(options.config);
    }
    return createTool(options);
  };
  ({ resolveSessionsSendReplyTarget } = await import("./sessions-delivery-target.js"));
  ({ setActivePluginRegistry } = await import("../../plugins/runtime.js"));
});

const installRegistry = () =>
  setActivePluginRegistry(
    createSessionsChannelTestRegistry(
      (
        [
          ["discord", "Discord", ["direct", "channel", "thread"], false],
          ["feishu", "Feishu", ["direct", "group"], true],
          ["slack", "Slack", ["direct", "channel", "thread"], true],
        ] as const
      ).map(([id, label, chatTypes, resolveConversation]) => ({
        id,
        label,
        chatTypes: [...chatTypes],
        resolveConversation,
        preferSessionLookupForAnnounceTarget: resolveConversation,
      })),
    ),
  );

function createMainSessionsListTool() {
  return createSessionsListTool({ agentSessionKey: MAIN_AGENT_SESSION_KEY });
}

function createMainSessionsSendTool(options: Parameters<typeof createSessionsSendTool>[0] = {}) {
  return createSessionsSendTool({
    agentSessionKey: MAIN_AGENT_SESSION_KEY,
    agentChannel: MAIN_AGENT_CHANNEL,
    ...options,
  });
}

function executeSend(args: Record<string, unknown>, tool = createMainSessionsSendTool()) {
  return tool.execute("send", { message: "hi", ...args });
}

async function sendDetails(args: Record<string, unknown>, tool = createMainSessionsSendTool()) {
  return requireDetails(await executeSend(args, tool));
}

function resolveReplyTarget(sessionKey: string) {
  return resolveSessionsSendReplyTarget({
    sessionKey,
    displayKey: sessionKey,
    callGateway: callGatewayMock,
  });
}

async function executeFireAndForgetA2AFrom(
  requesterSessionKey: string,
  options?: { expectReplyFlow?: boolean },
) {
  setActivePluginRegistry(createSessionConversationTestRegistry());
  const targetSessionKey = "agent:other:discord:group:ops";
  setRuntimeConfigSnapshot(createAllSessionsConfig({}, true));
  mockGatewayMethods({
    "sessions.list": () => sessionList(targetSessionKey, { kind: "group" }),
    agent: () => ({ runId: "run-fire-and-forget", acceptedAt: 123 }),
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
  if (options?.expectReplyFlow === false) {
    expect(requireDetails(result)).toMatchObject({ delivery: { status: "skipped" } });
  }
}

beforeEach(async () => {
  callGatewayMock.mockReset();
  runSessionsSendA2AFlow.mockReset();
  setRuntimeConfigSnapshot({
    session: { scope: "per-sender", mainKey: "main" },
    tools: { agentToAgent: { enabled: false } },
  });
  for (const [agentId, sessionKey] of [
    ["main", MAIN_AGENT_SESSION_KEY],
    ["main", "agent:main:other"],
    ["other", "agent:other:discord:group:ops"],
  ] as const) {
    await upsertSessionEntryCore({ agentId, sessionKey }, { sessionId: sessionKey, updatedAt: 1 });
  }
  setActivePluginRegistry(createTestRegistry([]));
});

afterEach(async () => {
  await drainSessionStateForTest();
  clearRuntimeConfigSnapshot();
});

it.each([
  [false, "Agent-to-agent messaging is disabled"],
  [true, "Upgrade the gateway"],
] as const)(
  "fails closed for resolved bare keys (missing owner: %s)",
  async (missingOwner, error) => {
    const bareKey = "b0d79b63-0f73-4bc9-a6b5-6d8e20f42c3c";
    const tool = createSessionsSendTool({
      agentId: "main",
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      config: {
        agents: { ownership: "explicit", entries: { main: {}, other: {} } },
        tools: { agentToAgent: { enabled: false }, sessions: { visibility: "all" } },
      },
    });
    callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: Record<string, string> }) => {
        if (request.method !== "sessions.resolve") {
          return {};
        }
        if (!missingOwner) {
          return { key: "incident-42", agentId: "other" };
        }
        if (request.params?.key) {
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "No session found: " + request.params.key,
          });
        }
        return request.params?.sessionId ? { key: "incident-42" } : {};
      },
    );
    expect(
      await sendDetails({ sessionKey: bareKey, message: "status?", timeoutSeconds: 0 }, tool),
    ).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining(error),
    });
  },
);

registerSessionsSendFixedOwnerTests({
  createTool: (options) => createSessionsSendTool(options),
  callGatewayMock,
  requireDetails,
  sessionDirs,
});

describe("resolveSessionsSendReplyTarget", () => {
  beforeEach(async () => {
    installRegistry();
  });

  it("derives non-WhatsApp delivery targets from the session key", async () => {
    const target = await resolveReplyTarget("agent:main:discord:group:dev");
    expect(target).toEqual({ channel: "discord", to: "group:dev" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      behavior: "hydrates delivery from the canonical external projection",
      key: "agent:main:feishu:direct:ou_user",
      context: { channel: "feishu", to: "user:ou_user", accountId: "work", threadId: "thread-77" },
      threadId: "thread-77",
    },
    {
      behavior: "preserves Slack thread IDs absent from stored delivery metadata",
      key: "agent:main:slack:channel:C123:thread:1710000000.000100",
      context: { channel: "slack", to: "channel:C123", accountId: "workspace" },
      threadId: "1710000000.000100",
    },
  ])("$behavior", async ({ key, context, threadId }) => {
    callGatewayMock.mockResolvedValueOnce({ session: { key, deliveryContext: context } });
    expect(await resolveReplyTarget(key)).toEqual({ ...context, threadId });
  });
});

describe("sessions_list gating", () => {
  it("keeps requester-owned cross-agent rows with tree visibility without a spawned lookup", async () => {
    setRuntimeConfigSnapshot(createAllSessionsConfig({ visibility: "tree" }));
    callGatewayMock.mockResolvedValueOnce(
      sessionList("agent:codex:acp:child-1", { spawnedBy: MAIN_AGENT_SESSION_KEY }),
    );

    const result = await createMainSessionsListTool().execute("call1", {});

    expect(requireDetails(result)).toMatchObject({
      count: 1,
      sessions: [{ key: "agent:codex:acp:child-1", parentSessionKey: MAIN_AGENT_SESSION_KEY }],
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("keeps literal current keys for message previews", async () => {
    callGatewayMock.mockReset();
    callGatewayMock
      .mockResolvedValueOnce(sessionList("current"))
      .mockResolvedValueOnce({ messages: [{ role: "assistant", content: [] }] });

    await createMainSessionsListTool().execute("call1", { messageLimit: 1 });

    expect(callGatewayMock).toHaveBeenLastCalledWith({
      method: "chat.history",
      params: { sessionKey: "current", agentId: "main", limit: 1 },
    });
  });
});

describe("sessions_send gating", () => {
  it.each([
    { name: "missing target", params: {}, error: "Either sessionKey or label is required" },
    {
      name: "unrepresentable agent ID",
      params: { agentId: "агент✨" },
      error: 'Agent "агент✨" not found. Run openclaw agents list to see configured agents.',
    },
  ])("rejects $name before resolving", async ({ params, error }) => {
    expect(await sendDetails({ ...params, timeoutSeconds: 5 })).toMatchObject({
      status: "error",
      error,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  const novaHint = ' Did you mean agent id "nova-1" (Nova)?';
  const hintCases: Array<{
    case: string;
    names: string[];
    a2a: boolean;
    hint: string;
    send?: string[];
    visibility?: "self" | "agent";
  }> = [
    { case: "unique name", names: ["Nova"], a2a: true, hint: novaHint },
    { case: "non-Latin name", names: ["Ника"], a2a: true, hint: novaHint.replace("Nova", "Ника") },
    { case: "shared name", names: ["Nova", "nova"], a2a: true, hint: "" },
    { case: "A2A off", names: ["Nova"], a2a: false, hint: "" },
    { case: "send denied", names: ["Nova"], a2a: true, send: [], hint: "" },
    { case: "self visibility", names: ["Nova"], a2a: true, visibility: "self", hint: "" },
    {
      case: "send granted",
      names: ["Nova"],
      a2a: true,
      visibility: "agent",
      send: ["nova-1"],
      hint: novaHint,
    },
  ];
  it.each(hintCases)(
    "suggests only a sendable agent id ($case)",
    async ({ names, a2a, hint, send, visibility }) => {
      const entries = Object.fromEntries(
        names.map((name, index) => [`nova-${index + 1}`, { identity: { name } }]),
      );
      const tool = createMainSessionsSendTool({
        callGateway: callGatewayMock,
        config: {
          ...createAllSessionsConfig(visibility ? { visibility } : {}, a2a),
          agents: {
            ownership: "explicit",
            entries: { main: send ? { tools: { agentToAgent: { send } } } : {}, ...entries },
          },
        },
      });
      const agentId = names[0];

      expect(await sendDetails({ agentId, timeoutSeconds: 5 }, tool)).toMatchObject({
        status: "error",
        error: `Agent "${agentId}" not found.${hint} Run openclaw agents list to see configured agents.`,
      });
      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { params: { message: " \n\t " }, error: "message required" },
    { params: { timeoutSeconds: "1sec" }, error: "timeoutSeconds must be a non-negative integer" },
  ])("rejects malformed send input $params before forwarding", async ({ params, error }) => {
    await expect(executeSend({ sessionKey: MAIN_AGENT_SESSION_KEY, ...params })).rejects.toThrow(
      error,
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("returns an error when label resolution fails", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("No session found with label: nope"));
    expect(await sendDetails({ label: "nope", timeoutSeconds: 5 })).toMatchObject({
      status: "error",
      error: expect.stringContaining("No session found with label"),
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
  });

  it("conceals missing explicit keys denied by session visibility", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("No session found: agent:main:missing"));
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      callGateway: callGatewayMock,
      config: createAllSessionsConfig({ visibility: "self" }),
    });

    expect(
      (await sendDetails({ sessionKey: "agent:main:missing", timeoutSeconds: 0 }, tool)).status,
    ).toBe("forbidden");
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(requireGatewayRequest().method).toBe("sessions.resolve");
  });

  it.each([
    { targetKey: "agent:main:dashboard:child", timeoutSeconds: 0 },
    { targetKey: "agent:main:subagent:child", timeoutSeconds: 1 },
  ])(
    "keeps an exact-incarnation send scoped ($targetKey, wait $timeoutSeconds)",
    async ({ targetKey: targetSessionKey, timeoutSeconds }) => {
      const dir = sessionDirs.make();
      const storePath = path.join(dir, "sessions.json");
      const targetSessionId = "child-incarnation";
      await seedMainSession(MAIN_AGENT_SESSION_KEY, "requester-incarnation", storePath);
      await seedMainSession(targetSessionKey, targetSessionId, storePath, {
        parentSessionKey: MAIN_AGENT_SESSION_KEY,
        spawnedBy: MAIN_AGENT_SESSION_KEY,
      });
      mockGatewayMethods({
        "sessions.list": () => sessionList(targetSessionKey, {}, storePath),
        agent: () => ({ runId: "run-exact-send", acceptedAt: 123 }),
        "agent.wait": () => ({ runId: "run-exact-send", status: "timeout" }),
      });
      const tool = createSessionsSendTool({
        agentSessionKey: MAIN_AGENT_SESSION_KEY,
        expectedTargetSessionId: targetSessionId,
        completionOwner: "caller",
        idempotencyKey: "worker-session-send:stable-operation",
        callGateway: callGatewayMock,
        config: {
          ...createAllSessionsConfig({}, true),
          ...PEER_ONLY_ROUTING_CONFIG,
          session: { scope: "per-sender", mainKey: "main", store: storePath },
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
      expect(gatewayParams("agent")).toMatchObject({
        idempotencyKey: "worker-session-send:stable-operation",
        sessionKey: targetSessionKey,
        inputProvenance: { sourceSessionKey: MAIN_AGENT_SESSION_KEY },
      });
    },
  );

  it("does not disclose a resolved session key when sessionId access is denied", async () => {
    const tool = createSessionsSendTool({
      agentSessionKey: MAIN_AGENT_SESSION_KEY,
      callGateway: callGatewayMock,
      config: createAllSessionsConfig({ visibility: "tree" }),
    });
    callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: Record<string, unknown> }) => {
        const owned = request.params?.spawnedBy === MAIN_AGENT_SESSION_KEY;
        if (request.method === "sessions.resolve") {
          if (request.params?.key === "session-id-only") {
            throw new GatewayClientRequestError({
              code: "INVALID_REQUEST",
              message: "No session found: session-id-only",
            });
          }
          return owned ? {} : { key: "agent:other:main" };
        }
        return request.method === "sessions.list"
          ? {
              path: "/tmp/sessions.json",
              sessions: owned ? [] : [{ key: "agent:other:main", kind: "direct" }],
            }
          : {};
      },
    );

    expect(
      await sendDetails({ sessionKey: "session-id-only", timeoutSeconds: 0 }, tool),
    ).toMatchObject({ status: "forbidden", sessionKey: "session-id-only" });
  });

  it.each([
    { params: { label: "active thread" }, owner: "main", display: undefined, resolves: 2 },
    {
      params: { sessionKey: "thread-session-id" },
      owner: "other",
      display: "thread-session-id",
      resolves: 1,
    },
  ])(
    "rejects thread targets without exposing resolved IDs ($owner)",
    async ({ params, owner, display, resolves }) => {
      setActivePluginRegistry(createSessionConversationTestRegistry());
      setRuntimeConfigSnapshot(createAllSessionsConfig());
      const key = "agent:" + owner + ":discord:channel:123456:thread:987654";
      callGatewayMock.mockResolvedValueOnce({ key });
      expect(await sendDetails({ ...params, timeoutSeconds: 0 })).toMatchObject({
        status: "error",
        sessionKey: display ?? key,
        error: expect.stringContaining("cannot target a thread session"),
      });
      expect(callGatewayMock.mock.calls.map(([request]) => request.method)).toEqual(
        Array.from({ length: resolves }, () => "sessions.resolve"),
      );
    },
  );

  it("allows thread session targets when tools.sessions.allowThreadTargets is set", async () => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
    setRuntimeConfigSnapshot(
      createAllSessionsConfig({ visibility: "all", allowThreadTargets: true }),
    );
    const threadSessionKey = "agent:main:telegram:group:-100123:topic:42";
    await seedMainSession(threadSessionKey);
    mockGatewayMethods({
      "sessions.resolve": () => ({ key: threadSessionKey }),
      agent: () => ({ runId: "run-thread-opt-in", acceptedAt: 123 }),
    });
    const tool = createMainSessionsSendTool();

    const result = await executeSend({ label: "topic", timeoutSeconds: 0 }, tool);

    expect(tool.description).not.toContain("Thread chats rejected");
    expect(requireDetails(result)).toMatchObject({ status: "accepted" });
    expect(gatewayParams("agent")).toMatchObject({ sessionKey: threadSessionKey });
  });

  it("rejects synchronous sends to the raw legacy direct-message caller", async () => {
    const requesterSessionKey = "agent:main:feishu:direct:peer-1";
    callGatewayMock.mockResolvedValueOnce({ key: requesterSessionKey });
    const tool = createSessionsSendTool({
      agentSessionKey: requesterSessionKey,
      agentChannel: "feishu",
    });

    expect(
      await sendDetails({ sessionKey: "current", message: "use this as my reply" }, tool),
    ).toMatchObject({
      status: "error",
      error: "sessions_send cannot target the calling session; use your own reply instead",
      sessionKey: "current",
    });
    expect(callGatewayMock.mock.calls).not.toContainEqual([
      expect.objectContaining({ method: "agent" }),
    ]);
  });

  it.each([
    {
      disposition: "silent",
      delivered: false,
      message: expect.stringContaining("pending delivery"),
    },
    {
      disposition: "empty",
      delivered: true,
      message:
        "The target delivered its final reply directly to its source conversation. Do not resend.",
    },
  ] as const)(
    "reports $disposition completion without resending (delivered=$delivered)",
    async ({ disposition, delivered, message }) => {
      const targetSessionKey = "agent:main:other";
      const runId = "run-no-reply";
      const tool = createMainSessionsSendTool({ config: createAllSessionsConfig() });
      mockTargetRun(targetSessionKey, runId, {
        "chat.history": () => ({
          messages: [
            { role: "assistant", content: "private final that must stay private", timestamp: 21 },
          ],
        }),
        "agent.wait": () => ({
          runId,
          status: "ok",
          terminalReply: { disposition },
          terminalReceipt: delivered
            ? {
                runId,
                sessionId: targetSessionKey,
                turnId: "target-turn",
                requested: { provider: "provider", model: "model" },
                effective: { provider: "provider", model: "model", responseModel: "model" },
                successfulToolNames: ["message"],
                sourceReplyDelivered: true,
                rerouted: false,
                terminalDisposition: "visible",
              }
            : undefined,
        }),
      });
      const details = await sendDetails({ sessionKey: targetSessionKey, timeoutSeconds: 1 }, tool);
      expect(details).toMatchObject({ status: "no_reply", sessionKey: targetSessionKey, message });
      expect(details.reply).toBeUndefined();
      expect(details.delivery).toBeUndefined();
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
      expect(
        callGatewayMock.mock.calls.some(([request]) => request.method === "chat.history"),
      ).toBe(false);
    },
  );

  it("detaches fire-and-forget A2A work from parent transcript ownership", async () => {
    let inheritedFence: ReturnType<typeof getOwnedSessionTranscriptWriterFence>;
    runSessionsSendA2AFlow.mockImplementationOnce(async () => {
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
    const tool = createMainSessionsSendTool({ agentSessionKey: "main" });
    mockTargetRun(MAIN_AGENT_SESSION_KEY, "run-alias-fire-and-forget", {});

    const details = await sendDetails(
      { sessionKey: MAIN_AGENT_SESSION_KEY, message: "ping", timeoutSeconds: 0 },
      tool,
    );

    expect(details).toMatchObject({ status: "accepted", sessionKey: MAIN_AGENT_SESSION_KEY });
    const flowParams = runSessionsSendA2AFlow.mock.calls[0]?.[0];
    expect(flowParams?.requesterSessionKey).toBe(MAIN_AGENT_SESSION_KEY);
    expect(flowParams?.targetSessionKey).toBe(MAIN_AGENT_SESSION_KEY);
  });

  it("does not start requester delivery for an isolated cron run", async () => {
    await executeFireAndForgetA2AFrom("agent:main:cron:job:run:abc", { expectReplyFlow: false });
    expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
  });

  it("caps oversized timeoutSeconds before waiting for the target run", async () => {
    const targetSessionKey = "agent:main:other";
    const tool = createMainSessionsSendTool({ config: createAllSessionsConfig() });
    const waitTimeouts: unknown[] = [];

    mockTargetRun(targetSessionKey, "run-huge-timeout", {
      "agent.wait": ({ timeoutMs }) => {
        waitTimeouts.push(timeoutMs);
        return { runId: "run-huge-timeout", status: "ok", terminalReply: { disposition: "empty" } };
      },
    });

    const result = await executeSend(
      { sessionKey: targetSessionKey, message: "ping", timeoutSeconds: Number.MAX_SAFE_INTEGER },
      tool,
    );

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
    await seedMainSession(
      "agent:main:dashboard:req-provenance",
      "materialization-requester",
      store,
    );
    inProcessCreationMock.mockClear().mockImplementation(async () => {
      await seedMainSession(MAIN_AGENT_SESSION_KEY, "materialized-main", store);
      return {};
    });
    setRuntimeConfigSnapshot({
      ...createAllSessionsConfig(),
      session: { scope: "per-sender", mainKey: "main", store },
    });
  },
  cleanup: () => {
    inProcessGatewayContextAvailable = false;
    inProcessCreationMock.mockClear();
  },
});
