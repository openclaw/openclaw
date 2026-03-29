import { beforeEach, describe, expect, it, vi } from "vitest";

describe("sessions-list-tool", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("keeps deliveryContext.threadId in sessions_list results", async () => {
    const gatewayCallMock = vi.fn(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:dashboard:child",
              kind: "direct",
              sessionId: "sess-dashboard-child",
              deliveryContext: {
                channel: "discord",
                to: "discord:child",
                accountId: "acct-1",
                threadId: "thread-1",
              },
            },
            {
              key: "agent:main:telegram:topic",
              kind: "direct",
              sessionId: "sess-telegram-topic",
              deliveryContext: {
                channel: "telegram",
                to: "telegram:topic",
                accountId: "acct-2",
                threadId: 271,
              },
            },
          ],
        };
      }
      return {};
    });

    vi.doMock("../../gateway/call.js", () => ({
      callGateway: gatewayCallMock,
    }));
    vi.doMock("./sessions-helpers.js", async () => {
      const actual =
        await vi.importActual<typeof import("./sessions-helpers.js")>("./sessions-helpers.js");
      return {
        ...actual,
        createAgentToAgentPolicy: () => ({}),
        createSessionVisibilityGuard: async () => ({
          check: () => ({ allowed: true }),
        }),
        resolveEffectiveSessionToolsVisibility: () => "all",
        resolveSandboxedSessionToolContext: () => ({
          mainKey: "main",
          alias: "main",
          requesterInternalKey: undefined,
          restrictToSpawned: false,
        }),
      };
    });

    const { createSessionsListTool } = await import("./sessions-list-tool.js");
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-1", {});
    const details = result.details as {
      sessions?: Array<{
        deliveryContext?: {
          channel?: string;
          to?: string;
          accountId?: string;
          threadId?: string | number;
        };
      }>;
    };

    expect(details.sessions?.[0]?.deliveryContext).toEqual({
      channel: "discord",
      to: "discord:child",
      accountId: "acct-1",
      threadId: "thread-1",
    });
    expect(details.sessions?.[1]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "telegram:topic",
      accountId: "acct-2",
      threadId: 271,
    });
  });

  it("keeps numeric deliveryContext.threadId in sessions_list results", async () => {
    const gatewayCallMock = vi.fn(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:telegram:group:-100123:topic:99",
              kind: "group",
              sessionId: "sess-telegram-topic",
              deliveryContext: {
                channel: "telegram",
                to: "-100123",
                accountId: "acct-1",
                threadId: 99,
              },
            },
          ],
        };
      }
      return {};
    });

    vi.doMock("../../gateway/call.js", () => ({
      callGateway: gatewayCallMock,
    }));
    vi.doMock("./sessions-helpers.js", async () => {
      const actual =
        await vi.importActual<typeof import("./sessions-helpers.js")>("./sessions-helpers.js");
      return {
        ...actual,
        createAgentToAgentPolicy: () => ({}),
        createSessionVisibilityGuard: async () => ({
          check: () => ({ allowed: true }),
        }),
        resolveEffectiveSessionToolsVisibility: () => "all",
        resolveSandboxedSessionToolContext: () => ({
          mainKey: "main",
          alias: "main",
          requesterInternalKey: undefined,
          restrictToSpawned: false,
        }),
      };
    });

    const { createSessionsListTool } = await import("./sessions-list-tool.js");
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-2", {});
    const details = result.details as {
      sessions?: Array<{
        deliveryContext?: {
          channel?: string;
          to?: string;
          accountId?: string;
          threadId?: string | number;
        };
      }>;
    };

    expect(details.sessions?.[0]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "acct-1",
      threadId: 99,
    });
  });

  it("includes sessionFile field in sessions_list results when present", async () => {
    const gatewayCallMock = vi.fn(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:main",
              kind: "direct",
              sessionId: "sess-abc",
              sessionFile: "/home/user/.openclaw/agents/main/sessions/sess-abc.jsonl",
            },
          ],
        };
      }
      return {};
    });

    vi.doMock("../../gateway/call.js", () => ({
      callGateway: gatewayCallMock,
    }));
    vi.doMock("./sessions-helpers.js", async () => {
      const actual =
        await vi.importActual<typeof import("./sessions-helpers.js")>("./sessions-helpers.js");
      return {
        ...actual,
        createAgentToAgentPolicy: () => ({}),
        createSessionVisibilityGuard: async () => ({
          check: () => ({ allowed: true }),
        }),
        resolveEffectiveSessionToolsVisibility: () => "all",
        resolveSandboxedSessionToolContext: () => ({
          mainKey: "main",
          alias: "main",
          requesterInternalKey: undefined,
          restrictToSpawned: false,
        }),
      };
    });

    const { createSessionsListTool } = await import("./sessions-list-tool.js");
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-sf", {});
    const details = result.details as {
      sessions?: Array<{
        sessionId?: string;
        sessionFile?: string;
      }>;
    };

    expect(details.sessions?.[0]?.sessionFile).toBe(
      "/home/user/.openclaw/agents/main/sessions/sess-abc.jsonl",
    );
  });

  it("keeps live session setting metadata in sessions_list results", async () => {
    const gatewayCallMock = vi.fn(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "sess-main",
              thinkingLevel: "high",
              fastMode: true,
              verboseLevel: "on",
              reasoningLevel: "deep",
              elevatedLevel: "on",
              responseUsage: "full",
            },
          ],
        };
      }
      return {};
    });

    vi.doMock("../../gateway/call.js", () => ({
      callGateway: gatewayCallMock,
    }));
    vi.doMock("./sessions-helpers.js", async () => {
      const actual =
        await vi.importActual<typeof import("./sessions-helpers.js")>("./sessions-helpers.js");
      return {
        ...actual,
        createAgentToAgentPolicy: () => ({}),
        createSessionVisibilityGuard: async () => ({
          check: () => ({ allowed: true }),
        }),
        resolveEffectiveSessionToolsVisibility: () => "all",
        resolveSandboxedSessionToolContext: () => ({
          mainKey: "main",
          alias: "main",
          requesterInternalKey: undefined,
          restrictToSpawned: false,
        }),
      };
    });

    const { createSessionsListTool } = await import("./sessions-list-tool.js");
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-3", {});
    const details = result.details as {
      sessions?: Array<{
        thinkingLevel?: string;
        fastMode?: boolean;
        verboseLevel?: string;
        reasoningLevel?: string;
        elevatedLevel?: string;
        responseUsage?: string;
      }>;
    };

    expect(details.sessions?.[0]).toMatchObject({
      thinkingLevel: "high",
      fastMode: true,
      verboseLevel: "on",
      reasoningLevel: "deep",
      elevatedLevel: "on",
      responseUsage: "full",
    });
  });
});
