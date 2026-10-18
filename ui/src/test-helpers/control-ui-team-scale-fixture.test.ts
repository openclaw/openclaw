import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { CronJobSchema } from "../../../packages/gateway-protocol/src/schema/cron.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { createTeamScaleSidebarListOwner } from "./control-ui-sidebar-list-fixture.ts";
import { createControlUiTeamScaleFixture } from "./control-ui-team-scale-fixture.ts";

const now = 1_800_000_000_000;

describe("Team-scale Gateway fixture", () => {
  it("pages session lists using pin placement, stable key ties, and the requested activity clock", () => {
    const fixture = createControlUiTeamScaleFixture({ now });
    const rows: GatewaySessionRow[] = [
      {
        key: "agent:main:newest",
        kind: "direct",
        updatedAt: 900,
        lastInteractionAt: 100,
        lastActivityAt: 200,
      },
      {
        key: "agent:main:pin-old",
        kind: "direct",
        updatedAt: 100,
        pinned: true,
        pinnedAt: 10,
        parentSessionKey: "agent:main:main",
        lastInteractionAt: 800,
      },
      {
        key: "agent:main:pin-new",
        kind: "direct",
        updatedAt: 50,
        pinned: true,
        pinnedAt: 20,
        lastInteractionAt: 200,
      },
      {
        key: "agent:main:tie-a",
        kind: "direct",
        updatedAt: 700,
        lastInteractionAt: 300,
        lastActivityAt: 500,
      },
      {
        key: "agent:main:tie-B",
        kind: "direct",
        updatedAt: 700,
        lastInteractionAt: 300,
        lastActivityAt: 500,
      },
      {
        key: "agent:main:subagent:nested",
        kind: "direct",
        updatedAt: 800,
        pinned: true,
        pinnedAt: 1_000,
        spawnedBy: "agent:main:main",
      },
      {
        key: "agent:main:promoted",
        kind: "direct",
        updatedAt: 600,
        pinned: true,
        pinnedAt: 30,
        spawnedBy: "agent:main:main",
        sidebarRoot: true,
      },
      {
        key: "agent:main:false-pin",
        kind: "direct",
        updatedAt: 650,
        pinned: false,
        pinnedAt: 10_000,
        lastInteractionAt: 900,
        lastActivityAt: 800,
      },
      { key: "agent:main:created", kind: "direct", updatedAt: null, createdAt: 1_000 },
    ];
    const owner = createTeamScaleSidebarListOwner({ ...fixture.sidebarListInput, rows });
    for (const [sortBy, expected] of [
      [
        undefined,
        [
          "promoted",
          "pin-new",
          "pin-old",
          "newest",
          "subagent:nested",
          "tie-B",
          "tie-a",
          "false-pin",
          "created",
        ],
      ],
      [
        "lastInteractionAt",
        [
          "false-pin",
          "pin-old",
          "tie-B",
          "tie-a",
          "pin-new",
          "newest",
          "created",
          "promoted",
          "subagent:nested",
        ],
      ],
      [
        "activity",
        [
          "created",
          "false-pin",
          "pin-old",
          "subagent:nested",
          "promoted",
          "tie-B",
          "tie-a",
          "newest",
          "pin-new",
        ],
      ],
    ] as const) {
      const pages = [0, 3, 6].map((offset) => owner.list({ sortBy, offset, limit: 3 }).result);
      expect(
        pages.flatMap((page) => page.sessions.map((row) => row.key)),
        sortBy ?? "updatedAt",
      ).toEqual(expected.map((id) => `agent:main:${id}`));
      expect(pages.map((page) => page.nextOffset)).toEqual([3, 6, null]);
    }
  });

  it("answers the five boot list shapes from their own filtered and paged inventories", () => {
    const fixture = createControlUiTeamScaleFixture({ now });
    const owner = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
    const sidebar = owner.list({
      rowMode: "sidebar",
      limit: 200,
      agentId: "main",
      ownerFirst: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    }).result;
    const involved = owner.list({ rowMode: "sidebar", limit: 200, involvingMe: true }).result;
    const children = owner.list({
      rowMode: "compact",
      limit: 10_000,
      spawnedBy: fixture.selectedSessionKey,
    }).result;
    const mainChildren = owner.list({
      rowMode: "compact",
      limit: 100,
      spawnedBy: "agent:main:main",
    }).result;
    const counts = owner.list({
      rowMode: "compact",
      limit: 1,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
      includeOwnerSessionCounts: true,
    }).result;

    expect(sidebar.sessions.length).toBeGreaterThanOrEqual(200);
    expect(
      sidebar.sessions.slice(0, 12).every((row) => row.owner?.actor.id === "team-person-001"),
    ).toBe(true);
    expect(sidebar.nextOffset).toBe(200);
    expect(involved.sessions).toHaveLength(200);
    expect(children.sessions).toHaveLength(18);
    expect(
      children.sessions.every((row) =>
        row.childOwnerSessionKeys?.includes(fixture.selectedSessionKey),
      ),
    ).toBe(true);
    expect(mainChildren.sessions).toHaveLength(36);
    expect(sidebar.sessions.find((row) => row.key === "agent:main:main")).toMatchObject({
      isMain: true,
      childSessions: expect.arrayContaining(["agent:main:subagent:team-scale-19"]),
    });
    expect(fixture.sidebarListInput.rows.filter((row) => row.isMain)).toHaveLength(1);
    expect(counts.sessions).toHaveLength(1);
    expect(counts.totalCount).toBe(300);
    expect(counts.ownerSessionCounts?.reduce((total, row) => total + row.open, 0)).toBe(300);
    expect(sidebar).not.toHaveProperty("ownerSessionCounts");
    const sharedKeys = new Set(sidebar.sessions.map((row) => row.key));
    const involvingKeys = new Set(involved.sessions.map((row) => row.key));
    expect(fixture.pinnedKeys.every((key) => sharedKeys.has(key))).toBe(true);
    expect(fixture.pinnedKeys.slice(1, 29).every((key) => involvingKeys.has(key))).toBe(true);
    for (const [flag, total] of [
      ["excludeSubagents", 336],
      ["excludeCron", 366],
      ["excludeSystem", 378],
    ] as const) {
      expect(owner.list({ [flag]: true, limit: 1 }).result.totalCount).toBe(total);
    }

    const secondPage = owner.list({
      limit: 100,
      offset: 200,
      excludeSubagents: true,
      excludeCron: true,
      excludeSystem: true,
    }).result;
    expect(secondPage.sessions).toHaveLength(100);
    expect(secondPage.sessions[0]?.sessionId).toBe("team-session-171");
    expect(secondPage).toMatchObject({ offset: 200, nextOffset: null, hasMore: false });
  });

  it("projects real row modes and bounds transcript enrichment without changing row identity on reread", () => {
    const fixture = createControlUiTeamScaleFixture({ now });
    const owner = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
    const params = {
      rowMode: "sidebar",
      limit: 200,
      includeDerivedTitles: true,
      includeLastMessage: true,
    };
    const first = owner.list(params).result;
    expect(first.sessions[0]).toMatchObject({
      rowMode: "sidebar",
      derivedTitle: expect.any(String),
      lastMessagePreview: expect.any(String),
    });
    expect(first.sessions[0]).not.toHaveProperty("thinkingLevels");
    expect(first.sessions[0]).not.toHaveProperty("model");
    expect(first.sessions[99]).toHaveProperty("derivedTitle");
    expect(first.sessions[100]).not.toHaveProperty("derivedTitle");
    expect(first.sessions[100]).not.toHaveProperty("lastMessagePreview");
    expect(owner.list(params).result.sessions).toBe(first.sessions);

    const compact = owner.list({ rowMode: "compact", limit: 1 }).result.sessions[0];
    expect(compact).toMatchObject({ rowMode: "compact", model: "gpt-5-mini" });
    expect(compact).not.toHaveProperty("thinkingLevels");
    expect(compact).not.toHaveProperty("derivedTitle");
    expect(compact).not.toHaveProperty("lastMessagePreview");
    const dashboard = owner.list({ rowMode: "dashboard", limit: 1 }).result.sessions[0];
    expect(dashboard).toMatchObject({ rowMode: "dashboard", owner: expect.any(Object) });
    expect(dashboard).not.toHaveProperty("participants");
    expect(dashboard).not.toHaveProperty("hasActiveRun");
  });

  it("provides a valid three-page cron inventory and seven plugin activations", () => {
    const fixture = createControlUiTeamScaleFixture({ now });
    expect(fixture.cronJobs).toHaveLength(120);
    expect(fixture.cronJobs.every((job) => Value.Check(CronJobSchema, job))).toBe(true);
    const pages = [0, 50, 100].map((offset) =>
      fixture.listCronJobs({
        offset,
        limit: 50,
        includeDisabled: true,
        enabled: "all",
        compact: true,
      }),
    );
    expect(pages.map((page) => page.jobs.length)).toEqual([50, 50, 20]);
    expect(pages.map((page) => page.nextOffset)).toEqual([50, 100, null]);
    expect(pages.map((page) => page.snapshotRevision)).toEqual(Array(3).fill("team-scale-cron-v1"));
    expect(new Set(pages.flatMap((page) => page.jobs.map((job) => job.id))).size).toBe(120);
    expect(pages[0]?.jobs[0]).toMatchObject({
      enabled: false,
      nextRunAtMs: now + 60_000,
      lastRunAtMs: now - 60_000,
      lastRunStatus: "error",
    });
    expect(pages[0]?.jobs[0]).not.toHaveProperty("payload");
    expect(fixture.listCronJobs({ enabled: "enabled", includeDisabled: true }).total).toBe(96);
    expect(fixture.listCronJobs({ enabled: "disabled" }).total).toBe(24);
    expect(fixture.counts.plugins).toBe(7);
    expect([...fixture.assets.keys()].filter((key) => key.endsWith("/index.js"))).toHaveLength(7);
  });

  it("orders filtered cron inventories before paging full or compact responses", () => {
    const fixture = createControlUiTeamScaleFixture({ now });
    const catalog = fixture.listCronJobs({
      limit: 200,
      includeDisabled: true,
      compact: true,
      sortBy: "name",
      sortDir: "asc",
    });
    expect(catalog.jobs).toHaveLength(120);
    expect(catalog.jobs.slice(0, 4).map((job) => job.id)).toEqual([
      "team-cron-1",
      "team-cron-10",
      "team-cron-100",
      "team-cron-101",
    ]);
    const page = fixture.listCronJobs({
      limit: 1,
      offset: 1,
      enabled: "disabled",
      sortBy: "updatedAtMs",
      sortDir: "asc",
    });
    expect(page.jobs).toHaveLength(1);
    expect(page.jobs[0]).toMatchObject({ id: "team-cron-111", state: { lastRunStatus: "error" } });
    expect(page).toMatchObject({ total: 24, offset: 1, hasMore: true, nextOffset: 2 });
    expect(
      fixture.listCronJobs({
        limit: 1,
        includeDisabled: true,
        sortBy: "nextRunAtMs",
        sortDir: "desc",
      }).jobs[0]?.id,
    ).toBe("team-cron-120");
  });
});
