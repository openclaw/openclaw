import { afterEach, describe, expect, test, vi } from "vitest";
import {
  closeSessionTools,
  connectSessionTools,
  predictableSessionId,
  structuredContent,
} from "./session-tools.test-support.js";

afterEach(closeSessionTools);

describe("OpenClaw session MCP tools", () => {
  test("lists all sessions as opaque host-native sidebar items", async () => {
    const sessionKey = "agent:main:dashboard:private-route";
    const avatar = "data:image/png;base64,Y2xhdw==";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          path: "/Users/alice/.openclaw/agents/main/sessions",
          sessions: [
            {
              key: sessionKey,
              label: "Investigate flaky CI",
              derivedTitle: "Private derived title",
              lastMessagePreview: "The Linux shard is still failing",
              updatedAt: 1_767_995_121_286,
              hasActiveRun: true,
              status: "running",
              unread: true,
              pinned: true,
              archived: false,
              modelProvider: "private-provider",
            },
          ],
        };
      }
      if (method === "agents.list") {
        return {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            {
              id: "main",
              name: "Claw",
              identity: { name: "Claw", avatarUrl: avatar },
            },
          ],
        };
      }
      throw new Error(`unexpected gateway method ${method}`);
    });
    const { client } = await connectSessionTools({
      request,
      methods: [
        "sessions.list",
        "agents.list",
        "chat.history",
        "sessions.create",
        "sessions.send",
        "sessions.abort",
        "sessions.patch",
      ],
    });

    const result = await client.callTool({
      name: "openclaw_sessions_list",
      arguments: { limit: 25, search: "flaky", archived: false },
    });

    const payload = structuredContent(result);
    expect(payload).toEqual({
      items: [
        {
          id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
          agentId: "main",
          title: "Investigate flaky CI",
          preview: "The Linux shard is still failing",
          updatedAt: "2026-01-09T21:45:21.286Z",
          status: "working",
          unread: true,
          pinned: true,
          archived: false,
          icons: [{ src: avatar }],
          toolArguments: {
            session_id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            chrome: "detail",
          },
        },
      ],
      agents: [
        {
          id: "main",
          title: "Claw",
          icon: { src: avatar, fallback: "C" },
        },
      ],
      capabilities: {
        list: true,
        read: true,
        create: true,
        send: true,
        abort: true,
        update: true,
      },
    });
    const [item] = payload.items as Array<{
      id: string;
      toolArguments: { session_id: string };
    }>;
    expect(item?.toolArguments.session_id).toBe(item?.id);
    expect(item?.id).not.toBe(predictableSessionId(sessionKey));
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({
        limit: 25,
        search: "flaky",
        archived: false,
        configuredAgentsOnly: true,
        includeDerivedTitles: true,
        includeLastMessage: true,
      }),
    );
    expect(request).toHaveBeenCalledWith("agents.list", {});
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(sessionKey);
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("private-provider");
  });

  test("treats operator.admin as the read and write scope superset", async () => {
    const { client } = await connectSessionTools({
      request: async () => ({ sessions: [] }),
      methods: [
        "sessions.list",
        "chat.history",
        "sessions.create",
        "sessions.send",
        "sessions.abort",
        "sessions.patch",
      ],
      scopes: ["operator.admin"],
    });

    const result = await client.callTool({
      name: "openclaw_sessions_list",
      arguments: { archived: false },
    });

    expect(structuredContent(result).capabilities).toEqual({
      list: true,
      read: true,
      create: true,
      send: true,
      abort: true,
      update: true,
    });
  });

  test("includes active and archived sessions in the default native collection", async () => {
    const activeKey = "agent:main:dashboard:active";
    const archivedKey = "agent:main:dashboard:archived";
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== "sessions.list") {
        throw new Error(`unexpected gateway method ${method}`);
      }
      return {
        sessions:
          params.archived === true
            ? [{ key: archivedKey, label: "Closed investigation", archived: true }]
            : [{ key: activeKey, label: "Current investigation", archived: false }],
      };
    });
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.list"],
      scopes: ["operator.read"],
    });

    const result = await client.callTool({
      name: "openclaw_sessions_list",
      arguments: {},
    });

    expect(structuredContent(result).items).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        archived: false,
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        archived: true,
      }),
    ]);
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ archived: false }),
    );
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ archived: true }),
    );
  });

  test("keeps opaque session ids stable only within one bridge process", async () => {
    const sessionKey = "agent:main:dashboard:guessable-key";
    const request = vi.fn(async () => ({ sessions: [{ key: sessionKey }] }));
    const first = await connectSessionTools({
      request,
      methods: ["sessions.list"],
      scopes: ["operator.read"],
    });
    const second = await connectSessionTools({
      request,
      methods: ["sessions.list"],
      scopes: ["operator.read"],
    });

    const firstList = await first.client.callTool({
      name: "openclaw_sessions_list",
      arguments: { archived: false },
    });
    const repeatedList = await first.client.callTool({
      name: "openclaw_sessions_list",
      arguments: { archived: false },
    });
    const secondList = await second.client.callTool({
      name: "openclaw_sessions_list",
      arguments: { archived: false },
    });
    const firstId = (structuredContent(firstList).items as Array<{ id: string }>)[0]?.id;
    const repeatedId = (structuredContent(repeatedList).items as Array<{ id: string }>)[0]?.id;
    const secondId = (structuredContent(secondList).items as Array<{ id: string }>)[0]?.id;

    expect(firstId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repeatedId).toBe(firstId);
    expect(secondId).not.toBe(firstId);
    expect(firstId).not.toBe(predictableSessionId(sessionKey));
  });

  test("returns configured agents even when they have no listed session", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return { sessions: [] };
      }
      return {
        defaultId: "main",
        agents: [{ id: "ops", name: "Operations", identity: { emoji: "🦞" } }],
      };
    });
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.list", "agents.list"],
      scopes: ["operator.read"],
    });

    const result = await client.callTool({
      name: "openclaw_sessions_list",
      arguments: { archived: false },
    });

    expect(structuredContent(result).agents).toEqual([
      expect.objectContaining({ id: "ops", title: "Operations" }),
    ]);
  });

  test("retains an archived session mapping across an active-list refresh", async () => {
    const sessionKey = "agent:main:dashboard:archived-private-key";
    let listCalls = 0;
    const request = vi.fn(async (method: string, _params: Record<string, unknown>) => {
      if (method === "sessions.list") {
        listCalls += 1;
        return {
          sessions: listCalls === 1 ? [{ key: sessionKey, label: "Archived", archived: true }] : [],
        };
      }
      if (method === "sessions.patch") {
        return { entry: { label: "Archived", archivedAt: undefined } };
      }
      throw new Error(`unexpected gateway method ${method}`);
    });
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.list", "sessions.patch"],
    });
    const archived = await client.callTool({
      name: "openclaw_sessions_list",
      arguments: { archived: true },
    });
    const sessionId = (structuredContent(archived).items as Array<{ id: string }>)[0]?.id;
    await client.callTool({
      name: "openclaw_sessions_list",
      arguments: { archived: false },
    });

    const restored = await client.callTool({
      name: "openclaw_session_update",
      arguments: { session_id: sessionId, archived: false },
    });

    expect(restored.isError).not.toBe(true);
    expect(request).toHaveBeenLastCalledWith("sessions.patch", {
      key: sessionKey,
      agentId: "main",
      label: undefined,
      archived: false,
      pinned: undefined,
      unread: undefined,
    });
  });

  test("omits out-of-range Gateway timestamps", async () => {
    const request = vi.fn(async () => ({
      sessions: [{ key: "agent:main:dashboard:huge-date", updatedAt: 9_000_000_000_000_000 }],
    }));
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.list"],
      scopes: ["operator.read"],
    });

    const result = await client.callTool({ name: "openclaw_sessions_list", arguments: {} });
    const [item] = structuredContent(result).items as Array<Record<string, unknown>>;

    expect(item).not.toHaveProperty("updatedAt");
  });

  test("drops oversized agent avatar data", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return { sessions: [{ key: "agent:main:dashboard:oversized-icon" }] };
      }
      return {
        defaultId: "main",
        agents: [
          {
            id: "main",
            identity: { avatarUrl: `data:image/png;base64,${"A".repeat(256 * 1024)}` },
          },
        ],
      };
    });
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.list", "agents.list"],
      scopes: ["operator.read"],
    });

    const result = await client.callTool({ name: "openclaw_sessions_list", arguments: {} });
    const [item] = structuredContent(result).items as Array<Record<string, unknown>>;

    expect(item).not.toHaveProperty("icons");
    expect(item).not.toHaveProperty("icon");
  });

  test("keeps bounded data avatars and drops remote avatar URLs", async () => {
    const boundedAvatar = `data:image/png;base64,${"A".repeat(64 * 1024)}`;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          sessions: [{ key: "agent:data:dashboard:one" }, { key: "agent:remote:dashboard:two" }],
        };
      }
      return {
        defaultId: "data",
        agents: [
          { id: "data", identity: { avatarUrl: boundedAvatar } },
          { id: "remote", identity: { avatarUrl: "https://example.com/avatar.png" } },
        ],
      };
    });
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.list", "agents.list"],
      scopes: ["operator.read"],
    });

    const result = await client.callTool({
      name: "openclaw_sessions_list",
      arguments: { archived: false },
    });
    const items = structuredContent(result).items as Array<Record<string, unknown>>;

    expect(items[0]).toHaveProperty("icons", [{ src: boundedAvatar }]);
    expect(items[0]).not.toHaveProperty("icon");
    expect(items[1]).not.toHaveProperty("icons");
  });

  test("bounds agent emoji icons and fallbacks", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return { sessions: [{ key: "agent:main:dashboard:emoji-icon" }] };
      }
      return {
        defaultId: "main",
        agents: [
          {
            id: "main",
            identity: { emoji: "🦞".repeat(1_000) },
          },
        ],
      };
    });
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.list", "agents.list"],
      scopes: ["operator.read"],
    });

    const result = await client.callTool({
      name: "openclaw_sessions_list",
      arguments: { archived: false },
    });
    const payload = structuredContent(result);
    const [item] = payload.items as Array<{ icons?: Array<{ src: string }> }>;
    const [agent] = payload.agents as Array<{
      icon?: { fallback?: string; src?: string };
    }>;

    expect(item?.icons?.[0]?.src.length).toBeLessThan(1_024);
    expect(agent?.icon?.fallback?.length).toBeLessThanOrEqual(16);
    expect(agent?.icon?.src?.length).toBeLessThan(1_024);
  });

  test("keeps a 100-session response below the Codex stdio frame limit", async () => {
    const avatar = `data:image/png;base64,${"A".repeat(64 * 1024)}`;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          sessions: Array.from({ length: 100 }, (_, index) => ({
            key: `agent:main:dashboard:session-${index}`,
            label: `Session ${index}`,
          })),
        };
      }
      return {
        defaultId: "main",
        agents: [{ id: "main", identity: { avatarUrl: avatar } }],
      };
    });
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.list", "agents.list"],
      scopes: ["operator.read"],
    });

    const result = await client.callTool({
      name: "openclaw_sessions_list",
      arguments: { archived: false, limit: 100 },
    });
    const payload = structuredContent(result);
    const items = payload.items as Array<{ icons?: Array<{ src: string }> }>;
    const iconCount = items.filter((item) => item.icons != null).length;

    expect(items).toHaveLength(100);
    expect(iconCount).toBeGreaterThan(0);
    expect(iconCount).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(5 * 1024 * 1024);
  });

  test("opens the new-session app route with configured agents and without history", async () => {
    const request = vi.fn(async () => ({
      defaultId: "main",
      agents: [{ id: "ops", name: "Operations" }],
    }));
    const { client } = await connectSessionTools({
      request,
      methods: ["sessions.create", "agents.list"],
      scopes: ["operator.write"],
    });

    const result = await client.callTool({
      name: "openclaw_session_detail",
      arguments: { mode: "new", chrome: "detail" },
    });

    expect(structuredContent(result)).toMatchObject({
      mode: "new",
      agents: [{ id: "ops", title: "Operations" }],
      capabilities: { create: true },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("agents.list", {});
  });
});
