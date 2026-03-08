import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { extractAssistantText, sanitizeTextContent } from "./sessions-helpers.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

// A2A flow: stub agent-step helpers (we only assert outbound send params)
vi.mock("./agent-step.js", () => ({
  readLatestAssistantReply: async () => "latest reply",
  runAgentStep: async () => "announce reply",
}));

type SessionsToolTestConfig = {
  session: { scope: "per-sender"; mainKey: string };
  tools: {
    agentToAgent: { enabled: boolean };
    sessions?: { visibility: "all" | "own" };
  };
};

const loadConfigMock = vi.fn<() => SessionsToolTestConfig>(() => ({
  session: { scope: "per-sender", mainKey: "main" },
  tools: { agentToAgent: { enabled: false } },
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => loadConfigMock() as never,
  };
});

import { createSessionsListTool } from "./sessions-list-tool.js";
import { resolveAnnounceTargetFromKey } from "./sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

let resolveAnnounceTarget: (typeof import("./sessions-announce-target.js"))["resolveAnnounceTarget"];
let setActivePluginRegistry: (typeof import("../../plugins/runtime.js"))["setActivePluginRegistry"];
const MAIN_AGENT_SESSION_KEY = "agent:main:main";
const MAIN_AGENT_CHANNEL = "whatsapp";

type SessionsListResult = Awaited<ReturnType<ReturnType<typeof createSessionsListTool>["execute"]>>;

const installRegistry = async () => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          id: "discord",
          meta: {
            id: "discord",
            label: "Discord",
            selectionLabel: "Discord",
            docsPath: "/channels/discord",
            blurb: "Discord test stub.",
          },
          capabilities: { chatTypes: ["direct", "channel", "thread"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          id: "telegram",
          meta: {
            id: "telegram",
            label: "Telegram",
            selectionLabel: "Telegram",
            docsPath: "/channels/telegram",
            blurb: "Telegram test stub.",
          },
          capabilities: { chatTypes: ["direct", "group", "thread"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
          messaging: {
            normalizeTarget: (t: string) => {
              // Minimal normalizer used by resolveAnnounceTargetFromKey tests.
              // In real telegram plugin, chat ids are raw strings.
              return t.replace(/^(group:|channel:)/, "");
            },
          },
        },
      },
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          id: "whatsapp",
          meta: {
            id: "whatsapp",
            label: "WhatsApp",
            selectionLabel: "WhatsApp",
            docsPath: "/channels/whatsapp",
            blurb: "WhatsApp test stub.",
            preferSessionLookupForAnnounceTarget: true,
          },
          capabilities: { chatTypes: ["direct", "group"] },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
    ]),
  );
};

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

function getFirstListedSession(result: SessionsListResult) {
  const details = result.details as
    | { sessions?: Array<{ key?: string; transcriptPath?: string }> }
    | undefined;
  return details?.sessions?.[0];
}

function expectWorkerTranscriptPath(
  result: SessionsListResult,
  params: { containsPath: string; sessionId: string },
) {
  const session = getFirstListedSession(result);
  expect(session).toMatchObject({ key: "agent:worker:main" });
  const transcriptPath = String(session?.transcriptPath ?? "");
  expect(path.normalize(transcriptPath)).toContain(path.normalize(params.containsPath));
  expect(transcriptPath).toMatch(new RegExp(`${params.sessionId}\\.jsonl$`));
}

async function withStubbedStateDir<T>(
  name: string,
  run: (stateDir: string) => Promise<T>,
): Promise<T> {
  const stateDir = path.join(os.tmpdir(), name);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  try {
    return await run(stateDir);
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("sanitizeTextContent", () => {
  it("strips minimax tool call XML and downgraded markers", () => {
    const input =
      'Hello <invoke name="tool">payload</invoke></minimax:tool_call> ' +
      "[Tool Call: foo (ID: 1)] world";
    const result = sanitizeTextContent(input).trim();
    expect(result).toBe("Hello  world");
    expect(result).not.toContain("invoke");
    expect(result).not.toContain("Tool Call");
  });

  it("strips thinking tags", () => {
    const input = "Before <think>secret</think> after";
    const result = sanitizeTextContent(input).trim();
    expect(result).toBe("Before  after");
  });
});

beforeAll(async () => {
  ({ resolveAnnounceTarget } = await import("./sessions-announce-target.js"));
  ({ setActivePluginRegistry } = await import("../../plugins/runtime.js"));
});

beforeEach(() => {
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue({
    session: { scope: "per-sender", mainKey: "main" },
    tools: { agentToAgent: { enabled: false } },
  });
});

describe("extractAssistantText", () => {
  it("sanitizes blocks without injecting newlines", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "Hi " },
        { type: "text", text: "<think>secret</think>there" },
      ],
    };
    expect(extractAssistantText(message)).toBe("Hi there");
  });

  it("rewrites error-ish assistant text only when the transcript marks it as an error", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "500 Internal Server Error",
      content: [{ type: "text", text: "500 Internal Server Error" }],
    };
    expect(extractAssistantText(message)).toBe("HTTP 500: Internal Server Error");
  });

  it("keeps normal status text that mentions billing", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Firebase downgraded us to the free Spark plan. Check whether billing should be re-enabled.",
        },
      ],
    };
    expect(extractAssistantText(message)).toBe(
      "Firebase downgraded us to the free Spark plan. Check whether billing should be re-enabled.",
    );
  });
});

describe("resolveAnnounceTarget", () => {
  beforeEach(async () => {
    callGatewayMock.mockClear();
    await installRegistry();
  });

  it("derives non-WhatsApp announce targets from the session key", async () => {
    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:discord:group:dev",
      displayKey: "agent:main:discord:group:dev",
    });
    expect(target).toEqual({ channel: "discord", to: "channel:dev" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("hydrates WhatsApp accountId from sessions.list when available", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:whatsapp:group:123@g.us",
          deliveryContext: {
            channel: "whatsapp",
            to: "123@g.us",
            accountId: "work",
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      displayKey: "agent:main:whatsapp:group:123@g.us",
    });
    expect(target).toEqual({
      channel: "whatsapp",
      to: "123@g.us",
      accountId: "work",
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    const first = callGatewayMock.mock.calls[0]?.[0] as { method?: string } | undefined;
    expect(first).toBeDefined();
    expect(first?.method).toBe("sessions.list");
  });
});

describe("resolveAnnounceTargetFromKey — DM session keys", () => {
  it("returns null for legacy main key (agent:main:main)", () => {
    // Legacy DM key — only 1 part after stripping agent:main, cannot resolve without gateway
    expect(resolveAnnounceTargetFromKey("agent:main:main")).toBeNull();
  });

  it("resolves per-channel-peer DM key (direct kind)", () => {
    const result = resolveAnnounceTargetFromKey("agent:main:telegram:direct:102272550");
    expect(result).not.toBeNull();
    expect(result?.channel).toBe("telegram");
    expect(result?.to).toBe("102272550");
    expect(result?.threadId).toBeUndefined();
  });

  it("resolves per-channel-peer DM key (dm kind)", () => {
    const result = resolveAnnounceTargetFromKey("agent:main:telegram:dm:102272550");
    expect(result).not.toBeNull();
    expect(result?.channel).toBe("telegram");
    expect(result?.to).toBe("102272550");
    expect(result?.threadId).toBeUndefined();
  });

  it("DM key and group key for same channel do not collide", () => {
    const dm = resolveAnnounceTargetFromKey("agent:main:telegram:direct:102272550");
    const group = resolveAnnounceTargetFromKey("agent:main:telegram:group:-1001234567890");
    expect(dm?.to).not.toBe(group?.to);
    expect(dm?.channel).toBe(group?.channel);
  });

  it("resolves group key with topic thread ID", () => {
    const result = resolveAnnounceTargetFromKey(
      "agent:main:telegram:group:-1001234567890:topic:99",
    );
    expect(result).not.toBeNull();
    expect(result?.threadId).toBe("99");
  });

  it("resolves Discord DM key (direct kind) as user target", () => {
    const result = resolveAnnounceTargetFromKey("agent:main:discord:direct:214905613497532417");
    expect(result).not.toBeNull();
    expect(result).toEqual({
      channel: "discord",
      to: "user:214905613497532417",
      threadId: undefined,
    });
  });

  it("resolves group key without topic", () => {
    const result = resolveAnnounceTargetFromKey("agent:main:discord:group:dev");
    expect(result).toEqual({ channel: "discord", to: "channel:dev", threadId: undefined });
  });

  it("returns null for unknown key shape", () => {
    expect(resolveAnnounceTargetFromKey("agent:main:webchat:internal")).toBeNull();
  });
});

describe("resolveAnnounceTarget — DM gateway fallback with threadId", () => {
  beforeEach(async () => {
    callGatewayMock.mockClear();
    await installRegistry();
  });

  it("returns threadId from deliveryContext when resolving DM via gateway fallback", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:main",
          deliveryContext: {
            channel: "telegram",
            to: "telegram:102272550",
            accountId: "mybot",
            threadId: 42,
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:main",
      displayKey: "agent:main:main",
    });
    expect(target).toEqual({
      channel: "telegram",
      to: "telegram:102272550",
      accountId: "mybot",
      threadId: "42",
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("omits threadId when deliveryContext has none", async () => {
    callGatewayMock.mockResolvedValueOnce({
      sessions: [
        {
          key: "agent:main:main",
          deliveryContext: {
            channel: "telegram",
            to: "telegram:102272550",
          },
        },
      ],
    });

    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:main",
      displayKey: "agent:main:main",
    });
    expect(target).not.toBeNull();
    expect(target?.threadId).toBeUndefined();
  });

  it("returns null when gateway has no matching session and key parsing fails", async () => {
    callGatewayMock.mockResolvedValueOnce({ sessions: [] });
    const target = await resolveAnnounceTarget({
      sessionKey: "agent:main:main",
      displayKey: "agent:main:main",
    });
    expect(target).toBeNull();
  });
});

describe("runSessionsSendA2AFlow — forwards threadId to send", () => {
  beforeEach(async () => {
    callGatewayMock.mockClear();
    await installRegistry();
  });

  it("includes threadId when announce target has one", async () => {
    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:main:telegram:group:-1001234567890:topic:99",
      displayKey: "agent:main:telegram:group:-1001234567890:topic:99",
      message: "hello",
      announceTimeoutMs: 1000,
      maxPingPongTurns: 0,
      roundOneReply: "round one",
    });

    type GatewayCall = { method?: unknown; params?: unknown };
    const asGatewayCall = (x: unknown): GatewayCall | null => {
      if (!x || typeof x !== "object") {
        return null;
      }
      const obj = x as Record<string, unknown>;
      return { method: obj.method, params: obj.params };
    };

    const sendCalls = callGatewayMock.mock.calls
      .map((c) => asGatewayCall(c?.[0]))
      .filter((c): c is GatewayCall => !!c && c.method === "send");

    expect(sendCalls.length).toBe(1);
    const params = sendCalls[0]?.params;
    expect(params).toMatchObject({
      channel: "telegram",
      to: "-1001234567890",
      threadId: "99",
    });
  });
});

describe("sessions_list gating", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    callGatewayMock.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        { key: "agent:main:main", kind: "direct" },
        { key: "agent:other:main", kind: "direct" },
      ],
    });
  });

  it("filters out other agents when tools.agentToAgent.enabled is false", async () => {
    const tool = createMainSessionsListTool();
    const result = await tool.execute("call1", {});
    expect(result.details).toMatchObject({
      count: 1,
      sessions: [{ key: MAIN_AGENT_SESSION_KEY }],
    });
  });
});

describe("sessions_list transcriptPath resolution", () => {
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

  it("resolves cross-agent transcript paths from agent defaults when gateway store path is relative", async () => {
    await withStubbedStateDir("openclaw-state-relative", async () => {
      callGatewayMock.mockResolvedValueOnce({
        path: "agents/main/sessions/sessions.json",
        sessions: [
          {
            key: "agent:worker:main",
            kind: "direct",
            sessionId: "sess-worker",
          },
        ],
      });

      const result = await executeMainSessionsList();
      expectWorkerTranscriptPath(result, {
        containsPath: path.join("agents", "worker", "sessions"),
        sessionId: "sess-worker",
      });
    });
  });

  it("resolves transcriptPath even when sessions.list does not return a store path", async () => {
    await withStubbedStateDir("openclaw-state-no-path", async () => {
      callGatewayMock.mockResolvedValueOnce({
        sessions: [
          {
            key: "agent:worker:main",
            kind: "direct",
            sessionId: "sess-worker-no-path",
          },
        ],
      });

      const result = await executeMainSessionsList();
      expectWorkerTranscriptPath(result, {
        containsPath: path.join("agents", "worker", "sessions"),
        sessionId: "sess-worker-no-path",
      });
    });
  });

  it("falls back to agent defaults when gateway path is non-string", async () => {
    await withStubbedStateDir("openclaw-state-non-string-path", async () => {
      callGatewayMock.mockResolvedValueOnce({
        path: { raw: "agents/main/sessions/sessions.json" },
        sessions: [
          {
            key: "agent:worker:main",
            kind: "direct",
            sessionId: "sess-worker-shape",
          },
        ],
      });

      const result = await executeMainSessionsList();
      expectWorkerTranscriptPath(result, {
        containsPath: path.join("agents", "worker", "sessions"),
        sessionId: "sess-worker-shape",
      });
    });
  });

  it("falls back to agent defaults when gateway path is '(multiple)'", async () => {
    await withStubbedStateDir("openclaw-state-multiple", async (stateDir) => {
      callGatewayMock.mockResolvedValueOnce({
        path: "(multiple)",
        sessions: [
          {
            key: "agent:worker:main",
            kind: "direct",
            sessionId: "sess-worker-multiple",
          },
        ],
      });

      const result = await executeMainSessionsList();
      expectWorkerTranscriptPath(result, {
        containsPath: path.join(stateDir, "agents", "worker", "sessions"),
        sessionId: "sess-worker-multiple",
      });
    });
  });

  it("resolves absolute {agentId} template paths per session agent", async () => {
    const templateStorePath = "/tmp/openclaw/agents/{agentId}/sessions/sessions.json";

    callGatewayMock.mockResolvedValueOnce({
      path: templateStorePath,
      sessions: [
        {
          key: "agent:worker:main",
          kind: "direct",
          sessionId: "sess-worker-template",
        },
      ],
    });

    const result = await executeMainSessionsList();
    const expectedSessionsDir = path.dirname(templateStorePath.replace("{agentId}", "worker"));
    expectWorkerTranscriptPath(result, {
      containsPath: expectedSessionsDir,
      sessionId: "sess-worker-template",
    });
  });
});

describe("sessions_send gating", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
  });

  it("returns an error when neither sessionKey nor label is provided", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call-missing-target", {
      message: "hi",
      timeoutSeconds: 5,
    });

    expect(result.details).toMatchObject({
      status: "error",
      error: "Either sessionKey or label is required",
    });
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

    expect(result.details).toMatchObject({
      status: "error",
    });
    expect((result.details as { error?: string } | undefined)?.error ?? "").toContain(
      "No session found with label",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({ method: "sessions.resolve" });
  });

  it("blocks cross-agent sends when tools.agentToAgent.enabled is false", async () => {
    const tool = createMainSessionsSendTool();

    const result = await tool.execute("call1", {
      sessionKey: "agent:other:main",
      message: "hi",
      timeoutSeconds: 0,
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock.mock.calls[0]?.[0]).toMatchObject({ method: "sessions.list" });
    expect(result.details).toMatchObject({ status: "forbidden" });
  });
});
