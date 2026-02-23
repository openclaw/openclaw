import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ButtonInteraction, ComponentData } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest } from "../../config/sessions.js";
import type { DiscordExecApprovalConfig } from "../../config/types.discord.js";
import {
  buildExecApprovalCustomId,
  extractDiscordChannelId,
  parseExecApprovalData,
  type ExecApprovalRequest,
  DiscordExecApprovalHandler,
  ExecApprovalButton,
  type ExecApprovalButtonContext,
} from "./exec-approvals.js";

const STORE_PATH = path.join(os.tmpdir(), "openclaw-exec-approvals-test.json");

const writeStore = (store: Record<string, unknown>) => {
  fs.writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  // CI runners can have coarse mtime resolution; avoid returning stale cached stores.
  clearSessionStoreCacheForTest();
};

beforeEach(() => {
  writeStore({});
});

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockRestPost = vi.hoisted(() => vi.fn());
const mockRestPatch = vi.hoisted(() => vi.fn());
const mockRestDelete = vi.hoisted(() => vi.fn());

vi.mock("../send.shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../send.shared.js")>();
  return {
    ...actual,
    createDiscordClient: () => ({
      rest: {
        post: mockRestPost,
        patch: mockRestPatch,
        delete: mockRestDelete,
      },
      request: (_fn: () => Promise<unknown>, _label: string) => _fn(),
    }),
  };
});

vi.mock("../../gateway/client.js", () => ({
  GatewayClient: class {
    private params: Record<string, unknown>;
    constructor(params: Record<string, unknown>) {
      this.params = params;
    }
    start() {}
    stop() {}
    async request() {
      return { ok: true };
    }
  },
}));

vi.mock("../../logger.js", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createHandler(config: DiscordExecApprovalConfig, accountId = "default") {
  return new DiscordExecApprovalHandler({
    token: "test-token",
    accountId,
    config,
    cfg: { session: { store: STORE_PATH } },
  });
}

type ExecApprovalHandlerInternals = {
  pending: Map<
    string,
    { discordMessageId: string; discordChannelId: string; timeoutId: NodeJS.Timeout }
  >;
  requestCache: Map<string, ExecApprovalRequest>;
  handleApprovalRequested: (request: ExecApprovalRequest) => Promise<void>;
  handleApprovalTimeout: (approvalId: string, source?: "channel" | "dm") => Promise<void>;
};

function getHandlerInternals(handler: DiscordExecApprovalHandler): ExecApprovalHandlerInternals {
  return handler as unknown as ExecApprovalHandlerInternals;
}

function clearPendingTimeouts(handler: DiscordExecApprovalHandler) {
  const internals = getHandlerInternals(handler);
  for (const pending of internals.pending.values()) {
    clearTimeout(pending.timeoutId);
  }
  internals.pending.clear();
}

function createRequest(
  overrides: Partial<ExecApprovalRequest["request"]> = {},
): ExecApprovalRequest {
  return {
    id: "test-id",
    request: {
      command: "echo hello",
      cwd: "/home/user",
      host: "gateway",
      agentId: "test-agent",
      sessionKey: "agent:test-agent:discord:channel:999888777",
      ...overrides,
    },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60000,
  };
}

// ─── buildExecApprovalCustomId ────────────────────────────────────────────────

describe("buildExecApprovalCustomId", () => {
  it("encodes approval id and action", () => {
    const customId = buildExecApprovalCustomId("abc-123", "allow-once");
    expect(customId).toBe("execapproval:id=abc-123;action=allow-once");
  });

  it("encodes special characters in approval id", () => {
    const customId = buildExecApprovalCustomId("abc=123;test", "deny");
    expect(customId).toBe("execapproval:id=abc%3D123%3Btest;action=deny");
  });
});

// ─── parseExecApprovalData ────────────────────────────────────────────────────

describe("parseExecApprovalData", () => {
  it("parses valid data", () => {
    const result = parseExecApprovalData({ id: "abc-123", action: "allow-once" });
    expect(result).toEqual({ approvalId: "abc-123", action: "allow-once" });
  });

  it("parses encoded data", () => {
    const result = parseExecApprovalData({
      id: "abc%3D123%3Btest",
      action: "allow-always",
    });
    expect(result).toEqual({ approvalId: "abc=123;test", action: "allow-always" });
  });

  it("rejects invalid action", () => {
    const result = parseExecApprovalData({ id: "abc-123", action: "invalid" });
    expect(result).toBeNull();
  });

  it("rejects missing id", () => {
    const result = parseExecApprovalData({ action: "deny" });
    expect(result).toBeNull();
  });

  it("rejects missing action", () => {
    const result = parseExecApprovalData({ id: "abc-123" });
    expect(result).toBeNull();
  });

  it("rejects null/undefined input", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    expect(parseExecApprovalData(null as any)).toBeNull();
    // oxlint-disable-next-line typescript/no-explicit-any
    expect(parseExecApprovalData(undefined as any)).toBeNull();
  });

  it("accepts all valid actions", () => {
    expect(parseExecApprovalData({ id: "x", action: "allow-once" })?.action).toBe("allow-once");
    expect(parseExecApprovalData({ id: "x", action: "allow-always" })?.action).toBe("allow-always");
    expect(parseExecApprovalData({ id: "x", action: "deny" })?.action).toBe("deny");
  });
});

// ─── roundtrip encoding ───────────────────────────────────────────────────────

describe("roundtrip encoding", () => {
  it("encodes and decodes correctly", () => {
    const approvalId = "test-approval-with=special;chars&more";
    const action = "allow-always" as const;
    const customId = buildExecApprovalCustomId(approvalId, action);

    // Parse the key=value pairs from the custom ID
    const parts = customId.split(";");
    const data: Record<string, string> = {};
    for (const part of parts) {
      const match = part.match(/^([^:]+:)?([^=]+)=(.+)$/);
      if (match) {
        data[match[2]] = match[3];
      }
    }

    const result = parseExecApprovalData(data);
    expect(result).toEqual({ approvalId, action });
  });
});

// ─── extractDiscordChannelId ──────────────────────────────────────────────────

describe("extractDiscordChannelId", () => {
  it("extracts channel IDs and rejects invalid session key inputs", () => {
    const cases: Array<{
      name: string;
      input: string | null | undefined;
      expected: string | null;
    }> = [
      {
        name: "standard session key",
        input: "agent:main:discord:channel:123456789",
        expected: "123456789",
      },
      {
        name: "agent-specific session key",
        input: "agent:test-agent:discord:channel:999888777",
        expected: "999888777",
      },
      {
        name: "group session key",
        input: "agent:main:discord:group:222333444",
        expected: "222333444",
      },
      {
        name: "longer session key",
        input: "agent:my-agent:discord:channel:111222333:thread:444555",
        expected: "111222333",
      },
      {
        name: "non-discord session key",
        input: "agent:main:telegram:channel:123456789",
        expected: null,
      },
      {
        name: "missing channel/group segment",
        input: "agent:main:discord:dm:123456789",
        expected: null,
      },
      { name: "null input", input: null, expected: null },
      { name: "undefined input", input: undefined, expected: null },
      { name: "empty input", input: "", expected: null },
    ];

    for (const testCase of cases) {
      expect(extractDiscordChannelId(testCase.input), testCase.name).toBe(testCase.expected);
    }
  });
});

// ─── DiscordExecApprovalHandler.shouldHandle ──────────────────────────────────

describe("DiscordExecApprovalHandler.shouldHandle", () => {
  it("returns false when disabled", () => {
    const handler = createHandler({ enabled: false, approvers: ["123"] });
    expect(handler.shouldHandle(createRequest())).toBe(false);
  });

  it("returns false when no approvers", () => {
    const handler = createHandler({ enabled: true, approvers: [] });
    expect(handler.shouldHandle(createRequest())).toBe(false);
  });

  it("returns true with minimal config", () => {
    const handler = createHandler({ enabled: true, approvers: ["123"] });
    expect(handler.shouldHandle(createRequest())).toBe(true);
  });

  it("filters by agent ID", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      agentFilter: ["allowed-agent"],
    });
    expect(handler.shouldHandle(createRequest({ agentId: "allowed-agent" }))).toBe(true);
    expect(handler.shouldHandle(createRequest({ agentId: "other-agent" }))).toBe(false);
    expect(handler.shouldHandle(createRequest({ agentId: null }))).toBe(false);
  });

  it("filters by session key substring", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      sessionFilter: ["discord"],
    });
    expect(handler.shouldHandle(createRequest({ sessionKey: "agent:test:discord:123" }))).toBe(
      true,
    );
    expect(handler.shouldHandle(createRequest({ sessionKey: "agent:test:telegram:123" }))).toBe(
      false,
    );
    expect(handler.shouldHandle(createRequest({ sessionKey: null }))).toBe(false);
  });

  it("filters by session key regex", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      sessionFilter: ["^agent:.*:discord:"],
    });
    expect(handler.shouldHandle(createRequest({ sessionKey: "agent:test:discord:123" }))).toBe(
      true,
    );
    expect(handler.shouldHandle(createRequest({ sessionKey: "other:test:discord:123" }))).toBe(
      false,
    );
  });

  it("filters by discord account when session store includes account", () => {
    writeStore({
      "agent:test-agent:discord:channel:999888777": {
        sessionId: "sess",
        updatedAt: Date.now(),
        origin: { provider: "discord", accountId: "secondary" },
        lastAccountId: "secondary",
      },
    });
    const handler = createHandler({ enabled: true, approvers: ["123"] }, "default");
    expect(handler.shouldHandle(createRequest())).toBe(false);
    const matching = createHandler({ enabled: true, approvers: ["123"] }, "secondary");
    expect(matching.shouldHandle(createRequest())).toBe(true);
  });

  it("combines agent and session filters", () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      agentFilter: ["my-agent"],
      sessionFilter: ["discord"],
    });
    expect(
      handler.shouldHandle(
        createRequest({
          agentId: "my-agent",
          sessionKey: "agent:my-agent:discord:123",
        }),
      ),
    ).toBe(true);
    expect(
      handler.shouldHandle(
        createRequest({
          agentId: "other-agent",
          sessionKey: "agent:other:discord:123",
        }),
      ),
    ).toBe(false);
    expect(
      handler.shouldHandle(
        createRequest({
          agentId: "my-agent",
          sessionKey: "agent:my-agent:telegram:123",
        }),
      ),
    ).toBe(false);
  });
});

// ─── DiscordExecApprovalHandler.getApprovers ──────────────────────────────────

describe("DiscordExecApprovalHandler.getApprovers", () => {
  it("returns approvers for configured, empty, and undefined lists", () => {
    const cases = [
      {
        name: "configured approvers",
        config: { enabled: true, approvers: ["111", "222"] } as DiscordExecApprovalConfig,
        expected: ["111", "222"],
      },
      {
        name: "empty approvers",
        config: { enabled: true, approvers: [] } as DiscordExecApprovalConfig,
        expected: [],
      },
      {
        name: "undefined approvers",
        config: { enabled: true } as DiscordExecApprovalConfig,
        expected: [],
      },
    ] as const;

    for (const testCase of cases) {
      const handler = createHandler(testCase.config);
      expect(handler.getApprovers(), testCase.name).toEqual(testCase.expected);
    }
  });
});

// ─── ExecApprovalButton authorization ─────────────────────────────────────────

describe("ExecApprovalButton", () => {
  function createMockHandler(approverIds: string[]) {
    const handler = createHandler({
      enabled: true,
      approvers: approverIds,
    });
    // Mock resolveApproval to track calls
    handler.resolveApproval = vi.fn().mockResolvedValue(true);
    return handler;
  }

  function createMockInteraction(userId: string) {
    const reply = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const followUp = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      userId,
      reply,
      update,
      followUp,
    } as unknown as ButtonInteraction;
    return { interaction, reply, update, followUp };
  }

  it("denies unauthorized users with ephemeral message", async () => {
    const handler = createMockHandler(["111", "222"]);
    const ctx: ExecApprovalButtonContext = { handler };
    const button = new ExecApprovalButton(ctx);

    const { interaction, reply, update } = createMockInteraction("999");
    const data: ComponentData = { id: "test-approval", action: "allow-once" };

    await button.run(interaction, data);

    expect(reply).toHaveBeenCalledWith({
      content: "⛔ You are not authorized to approve exec requests.",
      ephemeral: true,
    });
    expect(update).not.toHaveBeenCalled();
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock
    expect(handler.resolveApproval).not.toHaveBeenCalled();
  });

  it("allows authorized user and resolves approval", async () => {
    const handler = createMockHandler(["111", "222"]);
    const ctx: ExecApprovalButtonContext = { handler };
    const button = new ExecApprovalButton(ctx);

    const { interaction, reply, update } = createMockInteraction("222");
    const data: ComponentData = { id: "test-approval", action: "allow-once" };

    await button.run(interaction, data);

    expect(reply).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      content: "Submitting decision: **Allowed (once)**...",
      components: [],
    });
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock
    expect(handler.resolveApproval).toHaveBeenCalledWith("test-approval", "allow-once");
  });

  it("shows correct label for allow-always", async () => {
    const handler = createMockHandler(["111"]);
    const ctx: ExecApprovalButtonContext = { handler };
    const button = new ExecApprovalButton(ctx);

    const { interaction, update } = createMockInteraction("111");
    const data: ComponentData = { id: "test-approval", action: "allow-always" };

    await button.run(interaction, data);

    expect(update).toHaveBeenCalledWith({
      content: "Submitting decision: **Allowed (always)**...",
      components: [],
    });
  });

  it("shows correct label for deny", async () => {
    const handler = createMockHandler(["111"]);
    const ctx: ExecApprovalButtonContext = { handler };
    const button = new ExecApprovalButton(ctx);

    const { interaction, update } = createMockInteraction("111");
    const data: ComponentData = { id: "test-approval", action: "deny" };

    await button.run(interaction, data);

    expect(update).toHaveBeenCalledWith({
      content: "Submitting decision: **Denied**...",
      components: [],
    });
  });

  it("handles invalid data gracefully", async () => {
    const handler = createMockHandler(["111"]);
    const ctx: ExecApprovalButtonContext = { handler };
    const button = new ExecApprovalButton(ctx);

    const { interaction, update } = createMockInteraction("111");
    const data: ComponentData = { id: "", action: "invalid" };

    await button.run(interaction, data);

    expect(update).toHaveBeenCalledWith({
      content: "This approval is no longer valid.",
      components: [],
    });
    // oxlint-disable-next-line typescript/unbound-method -- vi.fn() mock
    expect(handler.resolveApproval).not.toHaveBeenCalled();
  });
  it("follows up with error when resolve fails", async () => {
    const handler = createMockHandler(["111"]);
    handler.resolveApproval = vi.fn().mockResolvedValue(false);
    const ctx: ExecApprovalButtonContext = { handler };
    const button = new ExecApprovalButton(ctx);

    const { interaction, followUp } = createMockInteraction("111");
    const data: ComponentData = { id: "test-approval", action: "allow-once" };

    await button.run(interaction, data);

    expect(followUp).toHaveBeenCalledWith({
      content:
        "Failed to submit approval decision. The request may have expired or already been resolved.",
      ephemeral: true,
    });
  });

  it("matches approvers with string coercion", async () => {
    // Approvers might be numbers in config
    const handler = createHandler({
      enabled: true,
      approvers: [111 as unknown as string],
    });
    handler.resolveApproval = vi.fn().mockResolvedValue(true);
    const ctx: ExecApprovalButtonContext = { handler };
    const button = new ExecApprovalButton(ctx);

    const { interaction, update, reply } = createMockInteraction("111");
    const data: ComponentData = { id: "test-approval", action: "allow-once" };

    await button.run(interaction, data);

    // Should match because getApprovers returns [111] and button does String(id) === userId
    expect(reply).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
  });
});

// ─── Target routing (handler config) ──────────────────────────────────────────

describe("DiscordExecApprovalHandler target config", () => {
  beforeEach(() => {
    mockRestPost.mockClear().mockResolvedValue({ id: "mock-message", channel_id: "mock-channel" });
    mockRestPatch.mockClear().mockResolvedValue({});
    mockRestDelete.mockClear().mockResolvedValue({});
  });

  it("accepts all target modes and defaults to dm when target is omitted", () => {
    const cases = [
      {
        name: "default target",
        config: { enabled: true, approvers: ["123"] } as DiscordExecApprovalConfig,
        expectedTarget: undefined,
      },
      {
        name: "channel target",
        config: {
          enabled: true,
          approvers: ["123"],
          target: "channel",
        } as DiscordExecApprovalConfig,
      },
      {
        name: "both target",
        config: {
          enabled: true,
          approvers: ["123"],
          target: "both",
        } as DiscordExecApprovalConfig,
      },
      {
        name: "dm target",
        config: {
          enabled: true,
          approvers: ["123"],
          target: "dm",
        } as DiscordExecApprovalConfig,
      },
    ] as const;

    for (const testCase of cases) {
      if ("expectedTarget" in testCase) {
        expect(testCase.config.target, testCase.name).toBe(testCase.expectedTarget);
      }
      const handler = createHandler(testCase.config);
      expect(handler.shouldHandle(createRequest()), testCase.name).toBe(true);
    }
  });
});

// ─── Timeout cleanup ─────────────────────────────────────────────────────────

describe("DiscordExecApprovalHandler timeout cleanup", () => {
  beforeEach(() => {
    mockRestPost.mockClear().mockResolvedValue({ id: "mock-message", channel_id: "mock-channel" });
    mockRestPatch.mockClear().mockResolvedValue({});
    mockRestDelete.mockClear().mockResolvedValue({});
  });

  it("cleans up request cache for the exact approval id", async () => {
    const handler = createHandler({ enabled: true, approvers: ["123"] });
    const internals = getHandlerInternals(handler);
    const requestA = { ...createRequest(), id: "abc" };
    const requestB = { ...createRequest(), id: "abc2" };

    internals.requestCache.set("abc", requestA);
    internals.requestCache.set("abc2", requestB);

    const timeoutIdA = setTimeout(() => {}, 0);
    const timeoutIdB = setTimeout(() => {}, 0);
    clearTimeout(timeoutIdA);
    clearTimeout(timeoutIdB);

    internals.pending.set("abc:dm", {
      discordMessageId: "m1",
      discordChannelId: "c1",
      timeoutId: timeoutIdA,
    });
    internals.pending.set("abc2:dm", {
      discordMessageId: "m2",
      discordChannelId: "c2",
      timeoutId: timeoutIdB,
    });

    await internals.handleApprovalTimeout("abc", "dm");

    expect(internals.pending.has("abc:dm")).toBe(false);
    expect(internals.requestCache.has("abc")).toBe(false);
    expect(internals.requestCache.has("abc2")).toBe(true);

    clearPendingTimeouts(handler);
  });
});

// ─── Delivery routing ────────────────────────────────────────────────────────

describe("DiscordExecApprovalHandler delivery routing", () => {
  beforeEach(() => {
    mockRestPost.mockClear().mockResolvedValue({ id: "mock-message", channel_id: "mock-channel" });
    mockRestPatch.mockClear().mockResolvedValue({});
    mockRestDelete.mockClear().mockResolvedValue({});
  });

  it("falls back to DM delivery when channel target has no channel id", async () => {
    const handler = createHandler({
      enabled: true,
      approvers: ["123"],
      target: "channel",
    });
    const internals = getHandlerInternals(handler);

    mockRestPost.mockImplementation(async (route: string) => {
      if (route === Routes.userChannels()) {
        return { id: "dm-1" };
      }
      if (route === Routes.channelMessages("dm-1")) {
        return { id: "msg-1", channel_id: "dm-1" };
      }
      return { id: "msg-unknown" };
    });

    const request = createRequest({ sessionKey: "agent:main:discord:dm:123" });
    await internals.handleApprovalRequested(request);

    expect(mockRestPost).toHaveBeenCalledTimes(2);
    expect(mockRestPost).toHaveBeenCalledWith(Routes.userChannels(), {
      body: { recipient_id: "123" },
    });
    expect(mockRestPost).toHaveBeenCalledWith(
      Routes.channelMessages("dm-1"),
      expect.objectContaining({
        body: expect.objectContaining({
          components: expect.any(Array),
        }),
      }),
    );

    clearPendingTimeouts(handler);
  });
});
