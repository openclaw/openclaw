// Register closed mocks before runtime imports; keep the shared row fixtures real.
import "./sessions-list.mocks.test-support.js";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildGatewaySessionRow } from "../../gateway/session-utils-row.js";
import { createSessionsListTool } from "./sessions-list-tool.js";

const { mocks } = await import("./sessions-list.mocks.test-support.js");

import { VALID_CONFIG, getSessionsListDetails, sessionRow } from "./sessions-list.test-support.js";

function mockRows(sessions: unknown[], path = "/tmp/sessions.json") {
  mocks.gatewayCall.mockImplementation(async (opts: unknown) =>
    (opts as { method?: string }).method === "sessions.list" ? { path, sessions } : {},
  );
}
function groupRow(key: string, classification: string, sessionId: string, peerKind?: string) {
  return { key, kind: "group", classification, sessionId, ...(peerKind ? { peerKind } : {}) };
}
function projectedRow(key: string, classification: string, extra: Record<string, unknown> = {}) {
  return { key, kind: "direct", classification, ...extra };
}
function globalConfig(owned = true): OpenClawConfig {
  return {
    session: { scope: "global" },
    agents: {
      ownership: "explicit",
      ...(owned ? { defaults: { sessionStore: { agentId: "ops" } } } : {}),
      entries: { ops: {}, research: {} },
    },
  };
}
const createTool = (options: NonNullable<Parameters<typeof createSessionsListTool>[0]> = {}) =>
  createSessionsListTool({ config: VALID_CONFIG, ...options });
async function list(
  params: Record<string, unknown> = {},
  options: NonNullable<Parameters<typeof createSessionsListTool>[0]> = {},
) {
  return getSessionsListDetails(await createTool(options).execute("list", params));
}
describe("sessions-list-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionStateVersions.mockReturnValue({});
  });

  it("filters Gateway-projected agent sessions by their authoritative classification", async () => {
    const cases = [
      ["agent:main:main", "direct", "main", "main"],
      ["agent:main:slack:channel:C123", "group", "channel", "group"],
      ["agent:main:cron:nightly", "direct", "cron", "cron"],
      ["agent:main:hook:deploy", "direct", "hook", "hook"],
      ["agent:main:node-device", "direct", "node", "node"],
    ] as const;
    const entries: Array<[string, SessionEntry]> = cases.map((row, index) => [
      row[0],
      {
        sessionId: `session-${row[3]}`,
        updatedAt: 5 - index,
        ...(row[3] === "group" ? { chatType: "channel" as const } : {}),
      },
    ]);
    const store = Object.fromEntries(entries);
    const sessions = entries.map(([key, entry]) =>
      buildGatewaySessionRow({
        cfg: VALID_CONFIG,
        agentId: "main",
        storePath: "/tmp/sessions.json",
        store,
        key,
        entry,
        lightweightListRow: true,
      }),
    );
    mocks.gatewayCall.mockResolvedValue({ path: "/tmp/sessions.json", sessions });
    const unfiltered = (await list()).sessions ?? [];
    const filteredKeys: Record<string, string[]> = {};
    for (const kind of ["main", "group", "cron", "hook", "node"]) {
      const result = await list({ kinds: [kind] });
      filteredKeys[kind] = (result.sessions ?? []).map((row) => String(row.key));
    }

    expect({
      modelVisible: unfiltered.map(({ key, kind }) => [key, kind]),
      filteredKeys,
    }).toEqual({
      modelVisible: cases.map((row) => [row[0], row[3]]),
      filteredKeys: Object.fromEntries(cases.map((row) => [row[3], [row[0]]])),
    });
  });

  it.each([
    { name: "unknown-only", kinds: ["unknown"], expected: [] },
    { name: "whitespace scalar", kinds: "   ", expected: [] },
    { name: "known scalar", kinds: "MAIN", expected: ["agent:main:main"] },
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

    expect((await list({ kinds })).sessions?.map((session) => session.key)).toEqual(expected);
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

      const result = await list(
        {},
        {
          agentSessionKey: requester,
          config: { ...VALID_CONFIG, tools: { sessions: { visibility } } },
        },
      );
      expect(result.sessions?.map((session) => session.key)).toEqual([
        "agent:main:main",
        "agent:main:slack:channel:team-room",
      ]);
    },
  );

  it("never exposes incognito rows or hidden hierarchy references to cross-session tools", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "(multiple)",
      sessions: [
        projectedRow("agent:main:dashboard:visible", "dashboard", {
          category: "Projects",
          parentSessionKey: "agent:other:dashboard:hidden-parent",
          childSessions: [
            "agent:main:subagent:visible-child",
            "agent:main:dashboard:incognito-private",
            "agent:other:subagent:hidden-child",
          ],
        }),
        projectedRow("agent:main:dashboard:incognito-private", "dashboard", {
          incognito: true,
          category: "Secret",
        }),
      ],
    });

    const details = await list();
    expect(details.sessions?.map(({ key, group }) => ({ key, group }))).toEqual([
      { key: "agent:main:dashboard:visible", group: "Projects" },
    ]);
    expect(details.sessions?.[0]).not.toHaveProperty("parentSessionKey");
    expect(details.sessions?.[0]?.childSessions).toEqual(["agent:main:subagent:visible-child"]);
  });

  it("keeps channel discovery but omits delivery routing metadata", async () => {
    const deliveries = [
      ["dashboard:child", "dashboard", "discord", "discord:child", "acct-1", "thread-1"],
      ["telegram:topic", "custom", "telegram", "telegram:topic", "acct-2", 271],
    ] as const;
    mockRows(
      deliveries.map(([suffix, classification, channel, to, accountId, threadId]) =>
        projectedRow(`agent:main:${suffix}`, classification, {
          sessionId: `sess-${suffix.replace(":", "-")}`,
          deliveryContext: { channel, to, accountId, threadId },
        }),
      ),
    );
    const details = await list();

    expect(details.sessions?.map((session) => session.channel)).toEqual(["discord", "telegram"]);
    expect(details.sessions?.every((session) => !Object.hasOwn(session, "deliveryContext"))).toBe(
      true,
    );
  });

  it("prefers the explicit parent key over the legacy spawner", async () => {
    mocks.gatewayCall.mockResolvedValue({
      path: "/tmp/sessions.json",
      sessions: [
        projectedRow("agent:main:subagent:child", "subagent", {
          parentSessionKey: "agent:main:subagent:parent",
          spawnedBy: "agent:main:main",
        }),
      ],
    });

    expect((await list()).sessions?.[0]?.parentSessionKey).toBe("agent:main:subagent:parent");
  });

  it("omits malformed agent keys and derives channels only from valid group keys", async () => {
    mockRows([
      groupRow(
        "agent:main:slack:channel:C123:thread:1710000000.000100",
        "thread",
        "sess-slack-thread",
        "channel",
      ),
      groupRow("discord:group:ops", "group", "sess-discord-group"),
      groupRow("agent:main:matrix:channel:!room:[2001:db8::1]", "channel", "sess-matrix-room"),
      groupRow("agent:main:agent:plugin:slack:channel:C123", "custom", "sess-nested-agent"),
      groupRow("agent::slack:channel:C123", "channel", "sess-malformed-agent"),
      {
        key: "Agent::discord:channel:C456",
        kind: "group",
        sessionId: "sess-malformed-agent-mixed-case",
      },
    ]);
    const details = await list();

    expect(details.sessions?.map((session) => session.channel)).toEqual([
      "slack",
      "discord",
      "matrix",
      "unknown",
    ]);
  });

  it.each([true, "all"] as const)(
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
          sidebarRoot: true,
        })),
      });
      const tool = createTool();

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
      expect(rows?.every((row) => row.sidebarRoot === true)).toBe(true);
      expect(rows?.every((row) => !Object.hasOwn(row, "archivedAt"))).toBe(true);
    },
  );

  it.each([true, false])("preserves fixed-store owner attribution (owned=%s)", async (owned) => {
    const store = owned ? "/tmp/shared-sessions.sqlite" : "/tmp/ownerless-shared.sqlite";
    mocks.gatewayCall.mockResolvedValueOnce({
      path: store,
      sessions: [
        {
          key: "global",
          kind: "main",
          channel: "webchat",
          archived: false,
          pinned: false,
          ...(owned ? { agentId: "ops" } : {}),
        },
      ],
    });
    if (owned) {
      mocks.gatewayCall.mockResolvedValueOnce({ messages: [] });
    }
    const result = await list(owned ? { messageLimit: 1 } : {}, {
      agentSessionKey: owned ? "global" : "agent:research:main",
      requesterAgentIdOverride: owned ? "ops" : "research",
      config: { ...globalConfig(owned), session: { store, scope: "global" } },
    });
    if (owned) {
      expect(result.sessions?.[0]).toMatchObject({ agentId: "ops" });
      expect(mocks.gatewayCall).toHaveBeenLastCalledWith({
        method: "chat.history",
        params: { sessionKey: "global", agentId: "ops", limit: 1 },
      });
    } else {
      expect(result.sessions).toEqual([]);
    }
  });

  it("preserves active sentinel rows and state versions from different agent stores", async () => {
    mocks.gatewayCall.mockResolvedValue({
      sessions: [
        ["ops", "ops-session", "running"],
        ["research", "research-session", "queued"],
      ].map(([agentId, sessionId, status]) => ({
        key: "global",
        agentId,
        classification: "global",
        kind: "global",
        sessionId,
        status,
      })),
    });
    mocks.getSessionStateVersions.mockReturnValue({ ops: { global: 7 }, research: { global: 9 } });
    const result = await list(
      { activeOnly: true },
      {
        agentSessionKey: "global",
        requesterAgentIdOverride: "ops",
        config: {
          ...globalConfig(),
          tools: {
            sessions: { visibility: "all" },
            agentToAgent: { enabled: true, allow: ["ops", "research"] },
          },
        },
      },
    );
    expect(mocks.getSessionStateVersions).toHaveBeenCalledWith([
      { sessionKey: "global", agentId: "ops" },
      { sessionKey: "global", agentId: "research" },
    ]);
    expect(
      result.sessions?.map(({ key, agentId, sessionId, stateVersion }) => ({
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

  it.each([
    [{ limit: 1.5 }, "limit must be a positive integer"],
    [{ offset: -1 }, "offset must be a non-negative integer"],
    [{ offset: 1.5 }, "offset must be a non-negative integer"],
    [{ activeMinutes: 0 }, "activeMinutes must be a positive integer"],
    [{ messageLimit: 1.5 }, "messageLimit must be a non-negative integer"],
  ])("rejects invalid numeric parameter %o", async (params, message) => {
    await expect(createTool().execute("call-4", params)).rejects.toThrow(message);
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
  });
});
