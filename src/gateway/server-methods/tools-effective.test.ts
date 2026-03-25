import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEffectiveToolInventory } from "../../agents/tools-effective-inventory.js";
import { ErrorCodes } from "../protocol/index.js";
import { loadSessionEntry } from "../session-utils.js";
import { toolsEffectiveHandlers } from "./tools-effective.js";

vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return {
    ...actual,
    listAgentIds: vi.fn(() => ["main"]),
    resolveDefaultAgentId: vi.fn(() => "main"),
    resolveSessionAgentId: vi.fn(() => "main"),
  };
});

vi.mock("../../agents/tools-effective-inventory.js", () => ({
  resolveEffectiveToolInventory: vi.fn(() => ({
    agentId: "main",
    profile: "coding",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          {
            id: "exec",
            label: "Exec",
            description: "Run shell commands",
            rawDescription: "Run shell commands",
            source: "core",
          },
        ],
      },
    ],
  })),
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: vi.fn(() => ({
      cfg: {},
      canonicalKey: "main:abc",
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
        lastChannel: "telegram",
        lastAccountId: "acct-1",
        lastThreadId: "thread-2",
        lastTo: "channel-1",
        groupId: "group-4",
        groupChannel: "#ops",
        space: "workspace-5",
        chatType: "group",
        modelProvider: "openai",
        model: "gpt-4.1",
      },
    })),
    resolveSessionModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-4.1" })),
  };
});

vi.mock("../../utils/delivery-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/delivery-context.js")>();
  return {
    ...actual,
    deliveryContextFromSession: vi.fn(() => ({
      channel: "telegram",
      to: "channel-1",
      accountId: "acct-1",
      threadId: "thread-2",
    })),
  };
});

vi.mock("../../auto-reply/reply/reply-threading.js", () => ({
  resolveReplyToMode: vi.fn(() => "first"),
}));

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvokeParams(params: Record<string, unknown>) {
  const respond = vi.fn();
  return {
    respond,
    invoke: async () =>
      await toolsEffectiveHandlers["tools.effective"]({
        params,
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-1", method: "tools.effective" },
        isWebchatConnect: () => false,
      }),
  };
}

describe("tools.effective handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid params", async () => {
    const { respond, invoke } = createInvokeParams({ includePlugins: false });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects missing sessionKey", async () => {
    const { respond, invoke } = createInvokeParams({});
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects caller-supplied auth context params", async () => {
    const { respond, invoke } = createInvokeParams({ senderIsOwner: true });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid tools.effective params");
  });

  it("rejects unknown agent ids", async () => {
    const { respond, invoke } = createInvokeParams({
      sessionKey: "main:abc",
      agentId: "unknown-agent",
    });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("unknown agent id");
  });

  it("rejects unknown session keys", async () => {
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      cfg: {},
      canonicalKey: "missing-session",
      entry: undefined,
      legacyKey: undefined,
      storePath: "/tmp/sessions.json",
    } as never);
    const { respond, invoke } = createInvokeParams({ sessionKey: "missing-session" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown session key "missing-session"');
  });

  it("returns the effective runtime inventory", async () => {
    const { respond, invoke } = createInvokeParams({ sessionKey: "main:abc" });
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          source: "core",
          tools: [{ id: "exec", source: "core" }],
        },
      ],
    });
    expect(vi.mocked(resolveEffectiveToolInventory)).toHaveBeenCalledWith(
      expect.objectContaining({
        senderIsOwner: false,
        currentChannelId: "channel-1",
        currentThreadTs: "thread-2",
        accountId: "acct-1",
        groupId: "group-4",
        groupChannel: "#ops",
        groupSpace: "workspace-5",
        replyToMode: "first",
        messageProvider: "telegram",
        modelProvider: "openai",
        modelId: "gpt-4.1",
      }),
    );
  });

  it("passes senderIsOwner=true for admin-scoped callers", async () => {
    const respond = vi.fn();
    await toolsEffectiveHandlers["tools.effective"]({
      params: { sessionKey: "main:abc" },
      respond: respond as never,
      context: {} as never,
      client: {
        connect: { scopes: ["operator.admin"] },
      } as never,
      req: { type: "req", id: "req-1", method: "tools.effective" },
      isWebchatConnect: () => false,
    });
    expect(vi.mocked(resolveEffectiveToolInventory)).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: true }),
    );
  });

  it("rejects agent ids that do not match the session agent", async () => {
    const { respond, invoke } = createInvokeParams({
      sessionKey: "main:abc",
      agentId: "other",
    });
    vi.mocked(loadSessionEntry).mockReturnValueOnce({
      cfg: {},
      canonicalKey: "main:abc",
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
      },
    } as never);
    await invoke();
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain('unknown agent id "other"');
  });
});
