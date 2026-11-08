// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isSystemCreatedSessionRow } from "../../../../src/shared/session-list-visibility.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import {
  compareSessionRowsByUpdatedAt,
  resolveSessionNavigation,
  visibleSessionMatches,
} from "./navigation.ts";

function navigate(
  rows: GatewaySessionRow[],
  options: Omit<Parameters<typeof resolveSessionNavigation>[0], "result" | "resultAgentId">,
) {
  return resolveSessionNavigation({
    result: {
      ts: 1,
      path: "(multiple)",
      count: rows.length,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: rows,
    },
    resultAgentId: "main",
    ...options,
  });
}

const keys = (navigation: ReturnType<typeof navigate>) =>
  navigation.visibleSessions.map((row) => row.key);
const session = (key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key: `agent:main:${key}`,
  kind: "direct",
  ...fields,
});

function roster(
  prefix: string,
  count: number,
  updatedAt: number,
  fields: Partial<GatewaySessionRow> = {},
) {
  return Array.from({ length: count }, (_, index) =>
    session(`${prefix}-${index}`, {
      updatedAt: updatedAt - index,
      ...fields,
    }),
  );
}

describe("resolveSessionNavigation", () => {
  it("keeps persistent spawned conversations discoverable without selecting or loading their parent", () => {
    const parentKey = "agent:main:discord:channel:parent";
    const office = session("dashboard:office-ha", {
      category: "HOME ASSISTANT",
      spawnedBy: parentKey,
      createdActor: { type: "agent" },
      updatedAt: 30,
    });
    const wake = session("dashboard:wake-word", { updatedAt: 20 });
    const rows: GatewaySessionRow[] = [
      office,
      wake,
      { ...office, key: "agent:main:subagent:worker" },
      { ...office, key: "agent:main:dashboard:uncategorized", category: " " },
      { ...office, key: "agent:main:dashboard:archived", archived: true },
    ];
    const navigation = navigate(rows, { sessionKey: wake.key });
    expect(keys(navigation)).toEqual([office.key, "agent:main:dashboard:uncategorized", wake.key]);
  });

  it("hides cron sessions unless showCron opts in", () => {
    // The automation toggle must reveal system-created cron rows without showSystem.
    const rows: GatewaySessionRow[] = [
      session("chat", { updatedAt: 300 }),
      session("cron:job", {
        kind: "cron" as never,
        updatedAt: 200,
        createdVia: "cron",
        createdActor: { type: "system" },
      }),
    ];

    expect(keys(navigate(rows, { sessionKey: "agent:main:chat" }))).toEqual(["agent:main:chat"]);
    expect(keys(navigate(rows, { sessionKey: "agent:main:chat", showCron: true }))).toEqual([
      "agent:main:chat",
      "agent:main:cron:job",
    ]);
  });

  it("hides isolated heartbeat lanes unless showSystem opts in", () => {
    // Classification comes from persisted provenance, not a matching key suffix.
    const heartbeatLane = session("main:heartbeat", {
      updatedAt: 200,
      classification: "heartbeat",
      createdVia: "cron",
    });
    const rows: GatewaySessionRow[] = [
      session("chat", { updatedAt: 300 }),
      session("alerts:heartbeat", {
        label: "My heartbeat monitor",
        updatedAt: 250,
      }),
      heartbeatLane,
    ];

    const hidden = navigate(rows, { sessionKey: "agent:main:chat" });
    expect(keys(hidden)).toEqual(["agent:main:chat", "agent:main:alerts:heartbeat"]);

    const shown = navigate(rows, { sessionKey: "agent:main:chat", showSystem: true });
    expect(keys(shown)).toEqual([
      "agent:main:chat",
      "agent:main:alerts:heartbeat",
      "agent:main:main:heartbeat",
    ]);

    const direct = navigate(rows, { sessionKey: heartbeatLane.key });
    expect(direct.currentSessionKey).toBe(heartbeatLane.key);
    expect(keys(direct)).toContain(heartbeatLane.key);
  });

  it("keeps a selected dock conversation readable without adding it to the sidebar", () => {
    const dock = session("board-agent", { isDock: true });
    const navigation = navigate([session("chat"), dock], {
      sessionKey: dock.key,
      activeSession: dock,
      showSystem: true,
    });
    expect(keys(navigation)).toEqual(["agent:main:chat"]);
    expect(navigation.selectedSession?.key).toBe(dock.key);
    expect(navigation.activeRowKey).toBeNull();
  });

  it("does not synthesize a session row for a catalog session key", () => {
    const rows = [session("recent-0", { updatedAt: 100 }), session("recent-1", { updatedAt: 90 })];
    const navigation = navigate(rows, { sessionKey: "catalog:claude:gateway%3Alocal:thread-1" });

    expect(keys(navigation)).toEqual(rows.map((row) => row.key));
    expect(navigation.activeRowKey).toBeNull();
    expect(navigation.selectedSession).toBeUndefined();
  });

  it("keeps a deep-linked session ahead of every returned active row", () => {
    const navigation = navigate(roster("recent", 11, 100), { sessionKey: "agent:main:oldest" });

    expect(navigation.visibleSessions).toHaveLength(12);
    expect(navigation.visibleSessions[0]).toMatchObject({
      key: "agent:main:oldest",
      kind: "direct",
      updatedAt: null,
    });
    expect(navigation.activeRowKey).toBe("agent:main:oldest");
    expect(navigation.visibleSessions.slice(1).map((row) => row.key)).toEqual(
      Array.from({ length: 11 }, (_, index) => `agent:main:recent-${index}`),
    );
  });

  it("keeps the selected archived session ahead of an active-filtered result", () => {
    const selectedSession = session("archived", {
      archived: true,
      updatedAt: 50,
    });
    const navigation = navigate([session("recent", { updatedAt: 100 })], {
      activeSession: selectedSession,
      sessionKey: selectedSession.key,
      archivedFilter: "active",
    });

    expect(keys(navigation)).toEqual([selectedSession.key, "agent:main:recent"]);
    const archived = { key: selectedSession.key, archived: true };
    expect(navigation.visibleSessions[0]).toMatchObject(archived);
    expect(navigation).toMatchObject({
      activeRowKey: selectedSession.key,
      selectedSession: archived,
    });
  });

  it("keeps every active chat in addition to pinned sessions", () => {
    const pinnedSessions = roster("pinned", 10, 100, { pinned: true });
    const recentSessions = roster("recent", 10, 1_000);
    const navigation = navigate([...recentSessions, ...pinnedSessions], {
      sessionKey: "unknown",
    });

    expect(keys(navigation)).toEqual([
      ...pinnedSessions.map((row) => row.key),
      ...recentSessions.map((row) => row.key),
    ]);
    expect(navigation.activeRowKey).toBeNull();
  });
});

describe("visibleSessionMatches", () => {
  const baseHost = {
    assistantAgentId: "work",
    agentsList: { defaultId: "main", mainKey: "workspace", scope: "global" },
    hello: null,
  };
  const group = (owner: string, hostKeys: string[]) => ({
    owner,
    hostKeys,
    candidates: [
      { sessionKey: "global", agentId: owner },
      ...hostKeys
        .filter((key) => key !== "global")
        .map((sessionKey) => ({ sessionKey, agentId: undefined })),
    ],
  });
  const routeGroups = [
    group("main", ["main", "workspace", "agent:main:main", "agent:main:workspace"]),
    group("work", ["global", "agent:work:main", "agent:work:workspace"]),
    group("alpha", ["agent:alpha:main", "agent:alpha:workspace"]),
  ];

  it("matches every canonical global alias pair only within the same owner", () => {
    for (const hostGroup of routeGroups) {
      for (const hostKey of hostGroup.hostKeys) {
        const host = { ...baseHost, sessionKey: hostKey };
        for (const candidateGroup of routeGroups) {
          for (const candidate of candidateGroup.candidates) {
            expect(
              visibleSessionMatches(host, candidate.sessionKey, candidate.agentId),
              `${hostKey} -> ${candidate.sessionKey} (${candidate.agentId ?? "no agent"})`,
            ).toBe(hostGroup.owner === candidateGroup.owner);
          }
        }
      }
    }
  });

  it("uses the same canonical owner check for non-global conversations", () => {
    const qualifiedHost = { ...baseHost, sessionKey: "agent:work:room:123" };
    expect(visibleSessionMatches(qualifiedHost, "agent:work:room:123", undefined)).toBe(true);
    expect(visibleSessionMatches(qualifiedHost, "agent:work:room:123", "work")).toBe(true);
    expect(visibleSessionMatches(qualifiedHost, "agent:work:room:123", "alpha")).toBe(false);

    const bareHost = { ...baseHost, sessionKey: "room:123" };
    expect(visibleSessionMatches(bareHost, "room:123", undefined)).toBe(true);
    expect(visibleSessionMatches(bareHost, "room:123", "main")).toBe(true);
    expect(visibleSessionMatches(bareHost, "room:123", "work")).toBe(false);
    expect(visibleSessionMatches(bareHost, "room:456", "main")).toBe(false);
  });
});

it("keeps a newly created operator-named CLI session visible", () => {
  const row = session("incident-42", {
    createdVia: "run",
    displayName: "incident-42",
  });

  expect(isSystemCreatedSessionRow(row)).toBe(false);
});

it("breaks updatedAt ties by key, matching the gateway list order", () => {
  const rows = ["zeta", "alpha", "mid"].map((name) => session(name, { updatedAt: null }));
  const sorted = rows.toSorted(compareSessionRowsByUpdatedAt).map((row) => row.key);
  expect(sorted).toEqual(["agent:main:alpha", "agent:main:mid", "agent:main:zeta"]);
});
