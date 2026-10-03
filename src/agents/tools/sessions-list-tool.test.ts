// sessions_list tool tests cover session metadata projection, visibility
// helpers, and numeric argument validation.
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildGatewaySessionRow } from "../../gateway/session-utils-row.js";
import { createSessionsListTool } from "./sessions-list-tool.js";

const mocks = vi.hoisted(() => ({
  gatewayCall: vi.fn(),
  getSessionStateVersions: vi.fn(
    (_refs: Array<{ sessionKey: string; agentId: string }>) =>
      ({}) as Record<string, Record<string, number>>,
  ),
}));

vi.mock("./in-process-gateway.js", () => ({
  hasGatewayToolRoutingContext: () => false,
  getInProcessGatewayToolContext: () => undefined,
  callAgentToolGatewayRequest: (opts: unknown) => mocks.gatewayCall(opts),
}));

vi.mock("../../sessions/session-state-events.js", () => ({
  getSessionStateVersions: (refs: Array<{ sessionKey: string; agentId: string }>) =>
    mocks.getSessionStateVersions(refs),
}));

import { VALID_CONFIG, getSessionsListDetails, sessionRow } from "./sessions-list.test-support.js";
describe("sessions-list-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionStateVersions.mockReturnValue({});
  });

  it("filters Gateway-projected agent sessions by their authoritative classification", async () => {
    const entries = [
      ["agent:main:main", { sessionId: "session-main", updatedAt: 5 }],
      [
        "agent:main:slack:channel:C123",
        { sessionId: "session-group", updatedAt: 4, chatType: "channel" },
      ],
      ["agent:main:cron:nightly", { sessionId: "session-cron", updatedAt: 3 }],
      ["agent:main:hook:deploy", { sessionId: "session-hook", updatedAt: 2 }],
      ["agent:main:node-device", { sessionId: "session-node", updatedAt: 1 }],
    ] satisfies Array<[string, SessionEntry]>;
    const store = Object.fromEntries(entries);
    const sessions = entries.map(([key, entry]) =>
      buildGatewaySessionRow({
        cfg: VALID_CONFIG,
        agentId: "main",
        storePath: "/tmp/sessions.json",
        store,
        key,
        entry,
        skipTranscriptUsageFallback: true,
        lightweightListRow: true,
      }),
    );
    mocks.gatewayCall.mockResolvedValue({ path: "/tmp/sessions.json", sessions });
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const unfiltered = getSessionsListDetails(await tool.execute("all-kinds", {})).sessions ?? [];
    const filteredKeys: Record<string, string[]> = {};
    for (const kind of ["main", "group", "cron", "hook", "node"]) {
      const result = getSessionsListDetails(
        await tool.execute(`filter-${kind}`, { kinds: [kind] }),
      );
      filteredKeys[kind] = (result.sessions ?? []).map((row) => String(row.key));
    }

    expect({
      projected: sessions.map(({ key, kind, classification }) => ({
        key,
        wireKind: kind,
        classification,
      })),
      modelVisible: unfiltered.map(({ key, kind }) => ({ key, kind })),
      filteredKeys,
    }).toEqual({
      projected: [
        { key: "agent:main:main", wireKind: "direct", classification: "main" },
        {
          key: "agent:main:slack:channel:C123",
          wireKind: "group",
          classification: "channel",
        },
        { key: "agent:main:cron:nightly", wireKind: "direct", classification: "cron" },
        { key: "agent:main:hook:deploy", wireKind: "direct", classification: "hook" },
        { key: "agent:main:node-device", wireKind: "direct", classification: "node" },
      ],
      modelVisible: [
        { key: "agent:main:main", kind: "main" },
        { key: "agent:main:slack:channel:C123", kind: "group" },
        { key: "agent:main:cron:nightly", kind: "cron" },
        { key: "agent:main:hook:deploy", kind: "hook" },
        { key: "agent:main:node-device", kind: "node" },
      ],
      filteredKeys: {
        main: ["agent:main:main"],
        group: ["agent:main:slack:channel:C123"],
        cron: ["agent:main:cron:nightly"],
        hook: ["agent:main:hook:deploy"],
        node: ["agent:main:node-device"],
      },
    });
  });

  it("limits session kind arguments to the documented classification values", () => {
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    expect(
      Value.Check(tool.parameters, { kinds: ["main", "group", "cron", "hook", "node", "other"] }),
    ).toBe(true);
    expect(Value.Check(tool.parameters, { kinds: ["unknown"] })).toBe(false);
    expect(Value.Check(tool.parameters, { kinds: ["   "] })).toBe(false);
  });

  it.each([
    { name: "unknown-only", kinds: ["unknown"], expected: [] },
    { name: "whitespace-only", kinds: ["   "], expected: [] },
    { name: "unknown scalar", kinds: "unknown", expected: [] },
    { name: "whitespace scalar", kinds: "   ", expected: [] },
    { name: "known scalar", kinds: "MAIN", expected: ["agent:main:main"] },
    { name: "mixed known and unknown", kinds: ["unknown", "MAIN"], expected: ["agent:main:main"] },
    {
      name: "empty",
      kinds: [],
      expected: ["agent:main:main", "agent:main:slack:channel:team-room"],
    },
  ])("never broadens an explicit $name session kind filter", async ({ kinds, expected }) => {
    mocks.gatewayCall.mockResolvedValue({
      sessions: [
        sessionRow("agent:main:main", "main"),
        sessionRow("agent:main:slack:channel:team-room", "channel"),
        sessionRow("agent:other:main", "main", "other"),
      ],
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute("filter-kinds", {
      kinds,
    });

    expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual(
      expected,
    );
  });

  it.each([
    { requester: "agent:main:main", visibility: "tree" as const },
    { requester: "agent:main:cron:organize", visibility: "agent" as const },
  ])(
    "lists unspawned same-agent sessions from $requester with $visibility visibility",
    async ({ requester, visibility }) => {
      mocks.gatewayCall.mockResolvedValue({
        sessions: [
          sessionRow("agent:main:main", "main"),
          sessionRow("agent:main:slack:channel:team-room", "channel"),
          sessionRow("agent:other:main", "main", "other"),
          sessionRow("agent:main:dashboard:incognito-private"),
        ],
      });

      const result = await createSessionsListTool({
        agentSessionKey: requester,
        config: { ...VALID_CONFIG, tools: { sessions: { visibility } } },
      }).execute("main-tree", {});

      expect(getSessionsListDetails(result).sessions?.map((session) => session.key)).toEqual([
        "agent:main:main",
        "agent:main:slack:channel:team-room",
      ]);
    },
  );

  it("adds nonzero state versions with one batch lookup", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:main",
          kind: "direct",
          classification: "main",
          sessionId: "main-1",
        },
        {
          key: "agent:main:subagent:child",
          kind: "direct",
          classification: "subagent",
          sessionId: "child-1",
        },
      ],
    });
    mocks.getSessionStateVersions.mockReturnValue({
      main: { "agent:main:main": 7, "agent:main:subagent:child": 0 },
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute("call-state", {});

    expect(mocks.getSessionStateVersions).toHaveBeenCalledWith([
      { sessionKey: "agent:main:main", agentId: "main" },
      { sessionKey: "agent:main:subagent:child", agentId: "main" },
    ]);
    expect(getSessionsListDetails(result).sessions?.[0]?.stateVersion).toBe(7);
    expect(getSessionsListDetails(result).sessions?.[1]?.stateVersion).toBeUndefined();
  });

  it("never exposes incognito rows or hidden hierarchy references to cross-session tools", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "(multiple)",
      sessions: [
        {
          key: "agent:main:dashboard:visible",
          kind: "direct",
          classification: "dashboard",
          category: "Projects",
          parentSessionKey: "agent:other:dashboard:hidden-parent",
          childSessions: [
            "agent:main:subagent:visible-child",
            "agent:main:dashboard:incognito-private",
            "agent:other:subagent:hidden-child",
          ],
        },
        {
          key: "agent:main:dashboard:incognito-private",
          kind: "direct",
          classification: "dashboard",
          incognito: true,
          category: "Secret",
        },
      ],
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute("blind", {});

    const details = getSessionsListDetails(result);
    expect(details.sessions?.map(({ key, group }) => ({ key, group }))).toEqual([
      { key: "agent:main:dashboard:visible", group: "Projects" },
    ]);
    expect(details.sessions?.[0]).not.toHaveProperty("parentSessionKey");
    expect(details.sessions?.[0]?.childSessions).toEqual(["agent:main:subagent:visible-child"]);
  });

  it("returns canonical session colors for readback", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:main",
          kind: "main",
          classification: "main",
          channel: "webchat",
          archived: false,
          pinned: false,
          color: "blue",
        },
      ],
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute(
      "color-readback",
      {},
    );

    expect(getSessionsListDetails(result).sessions?.[0]).toMatchObject({
      key: "agent:main:main",
      color: "blue",
    });
    expect(Value.Check(createSessionsListTool().outputSchema!, result.details)).toBe(true);
  });

  it("keeps channel discovery but omits delivery routing metadata", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:dashboard:child",
              kind: "direct",
              classification: "dashboard",
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
              classification: "custom",
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
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const result = await tool.execute("call-1", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.map((session) => session.channel)).toEqual(["discord", "telegram"]);
    expect(details.sessions?.every((session) => !Object.hasOwn(session, "deliveryContext"))).toBe(
      true,
    );
  });

  it("prefers the explicit parent key over the legacy spawner", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        {
          key: "agent:main:subagent:child",
          kind: "direct",
          classification: "subagent",
          parentSessionKey: "agent:main:subagent:parent",
          spawnedBy: "agent:main:main",
        },
      ],
    });

    const result = await createSessionsListTool({ config: VALID_CONFIG }).execute("lineage", {});

    expect(getSessionsListDetails(result).sessions?.[0]?.parentSessionKey).toBe(
      "agent:main:subagent:parent",
    );
  });

  it("omits malformed agent keys and derives channels only from valid group keys", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:slack:channel:C123:thread:1710000000.000100",
              kind: "group",
              classification: "thread",
              peerKind: "channel",
              sessionId: "sess-slack-thread",
            },
            {
              key: "discord:group:ops",
              kind: "group",
              classification: "group",
              sessionId: "sess-discord-group",
            },
            {
              key: "agent:main:matrix:channel:!room:[2001:db8::1]",
              kind: "group",
              classification: "channel",
              sessionId: "sess-matrix-room",
            },
            {
              key: "agent:main:agent:plugin:slack:channel:C123",
              kind: "group",
              classification: "custom",
              sessionId: "sess-nested-agent",
            },
            {
              key: "agent::slack:channel:C123",
              kind: "group",
              classification: "channel",
              sessionId: "sess-malformed-agent",
            },
            {
              key: "Agent::discord:channel:C456",
              kind: "group",
              sessionId: "sess-malformed-agent-mixed-case",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const result = await tool.execute("call-agent-scoped-channel", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.map((session) => session.channel)).toEqual([
      "slack",
      "discord",
      "matrix",
      "unknown",
    ]);
  });

  it("omits detailed runtime settings from discovery rows", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:main",
              kind: "direct",
              classification: "main",
              sessionId: "sess-main",
              thinkingLevel: "high",
              fastMode: "auto",
              effectiveFastMode: "auto",
              effectiveFastModeSource: "config",
              fastAutoOnSeconds: 30,
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
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    const result = await tool.execute("call-3", {});
    const details = getSessionsListDetails(result);

    const session = details.sessions?.[0];
    expect(session).toEqual({
      key: "agent:main:main",
      sessionId: "sess-main",
      agentId: "main",
      kind: "main",
      channel: "unknown",
      archived: false,
      pinned: false,
    });
  });

  it.each([false, true, "all"] as const)(
    "forwards archived=%s and keeps management state",
    async (archived) => {
      const states = archived === "all" ? [false, true] : [archived];
      mocks.gatewayCall.mockResolvedValue({
        path: "/tmp/sessions.json",
        sessions: states.map((state) => ({
          ...sessionRow(`agent:main:dashboard:archived-${state}`),
          archived: state,
          archivedAt: state ? 20 : undefined,
          pinned: false,
        })),
      });
      const tool = createSessionsListTool({ config: VALID_CONFIG });

      expect(Value.Check(tool.parameters, { archived })).toBe(true);
      const result = await tool.execute("call-archived", { archived });

      expect(mocks.gatewayCall).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "sessions.list",
          params: expect.objectContaining({ archived }),
        }),
      );
      const rows = getSessionsListDetails(result).sessions;
      expect(rows?.map(({ archived: state, pinned }) => ({ archived: state, pinned }))).toEqual(
        states.map((state) => ({ archived: state, pinned: false })),
      );
      expect(rows?.every((row) => !Object.hasOwn(row, "archivedAt"))).toBe(true);
    },
  );

  it("keeps a bare row's gateway owner during transcript hydration", async () => {
    mocks.gatewayCall
      .mockResolvedValueOnce({
        path: "/tmp/shared-sessions.sqlite",
        sessions: [
          {
            key: "global",
            agentId: "ops",
            kind: "main",
            channel: "webchat",
            archived: false,
            pinned: false,
          },
        ],
      })
      .mockResolvedValueOnce({ messages: [] });
    const config: OpenClawConfig = {
      session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    const result = await createSessionsListTool({
      agentSessionKey: "global",
      requesterAgentIdOverride: "ops",
      config,
    }).execute("owned-row", { messageLimit: 1 });

    expect(getSessionsListDetails(result).sessions?.[0]).toMatchObject({ agentId: "ops" });
    expect(mocks.gatewayCall).toHaveBeenLastCalledWith({
      method: "chat.history",
      params: { sessionKey: "global", agentId: "ops", limit: 1 },
    });
  });

  it("preserves active sentinel rows and state versions from different agent stores", async () => {
    mocks.gatewayCall.mockResolvedValue({
      sessions: [
        {
          key: "global",
          agentId: "ops",
          classification: "global",
          kind: "global",
          sessionId: "ops-session",
          status: "running",
        },
        {
          key: "global",
          agentId: "research",
          classification: "global",
          kind: "global",
          sessionId: "research-session",
          status: "queued",
        },
      ],
    });
    mocks.getSessionStateVersions.mockReturnValue({ ops: { global: 7 }, research: { global: 9 } });
    const result = await createSessionsListTool({
      agentSessionKey: "global",
      requesterAgentIdOverride: "ops",
      config: {
        session: { scope: "global" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
        tools: {
          sessions: { visibility: "all" },
          agentToAgent: { enabled: true, allow: ["ops", "research"] },
        },
      },
    }).execute("active-sentinels", { activeOnly: true });
    expect(mocks.getSessionStateVersions).toHaveBeenCalledWith([
      { sessionKey: "global", agentId: "ops" },
      { sessionKey: "global", agentId: "research" },
    ]);
    expect(
      getSessionsListDetails(result).sessions?.map(({ key, agentId, sessionId, stateVersion }) => ({
        key,
        agentId,
        sessionId,
        stateVersion,
      })),
    ).toEqual([
      { key: "main", agentId: "ops", sessionId: "ops-session", stateVersion: 7 },
      { key: "main", agentId: "research", sessionId: "research-session", stateVersion: 9 },
    ]);
  });

  it("does not attribute an ownerless fixed-store bare row to the requester", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/ownerless-shared.sqlite",
      sessions: [
        {
          key: "global",
          kind: "main",
          channel: "webchat",
          archived: false,
          pinned: false,
        },
      ],
    });

    const result = await createSessionsListTool({
      agentSessionKey: "agent:research:main",
      requesterAgentIdOverride: "research",
      config: {
        session: { store: "/tmp/ownerless-shared.sqlite", scope: "global" },
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      },
    }).execute("ownerless-row", {});

    expect(getSessionsListDetails(result).sessions).toEqual([]);
  });

  it.each([
    [{ limit: 1.5 }, "limit must be a positive integer"],
    [{ offset: -1 }, "offset must be a non-negative integer"],
    [{ offset: 1.5 }, "offset must be a non-negative integer"],
    [{ offset: Number.MAX_SAFE_INTEGER + 1 }, "offset must be a non-negative integer"],
    [{ activeMinutes: 0 }, "activeMinutes must be a positive integer"],
    [{ messageLimit: 1.5 }, "messageLimit must be a non-negative integer"],
    [{ messageLimit: -1 }, "messageLimit must be a non-negative integer"],
  ])("rejects invalid numeric parameter %o", async (params, message) => {
    // Reject before gateway dispatch so malformed limits cannot reach session
    // store queries.
    const tool = createSessionsListTool({ config: VALID_CONFIG });

    await expect(tool.execute("call-4", params)).rejects.toThrow(message);
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
  });
});
