import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { CronJobSchema } from "../../../packages/gateway-protocol/src/schema/cron.ts";
import { ChatHistoryDeltaResultSchema } from "../../../packages/gateway-protocol/src/schema/logs-chat.ts";
import { SessionRowSchema } from "../../../packages/gateway-protocol/src/schema/sessions-row.ts";
import { GatewaySessionRowEvents } from "../api/gateway-session-row-events.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { canApplySessionListSnapshot } from "../lib/sessions/session-list-query.ts";
import { sessionGatewayTest } from "./control-ui-e2e.sessions.test-support.ts";
import { createTeamScaleSidebarListOwner } from "./control-ui-sidebar-list-fixture.ts";
import { createControlUiTeamScaleFixture } from "./control-ui-team-scale-fixture.ts";

const now = 1_800_000_000_000;
const session = (
  id: string,
  updatedAt: number | null,
  fields: Partial<GatewaySessionRow> = {},
): GatewaySessionRow => ({ key: `agent:main:${id}`, kind: "direct", updatedAt, ...fields });
const pinned = (
  id: string,
  updatedAt: number,
  pinnedAt: number,
  fields: Partial<GatewaySessionRow> = {},
) => session(id, updatedAt, { pinned: true, pinnedAt, ...fields });
const rootOnly = { excludeSubagents: true, excludeCron: true, excludeSystem: true };
function expectAbsent(value: unknown, fields: string) {
  for (const field of fields.split(" ")) {
    expect(value).not.toHaveProperty(field);
  }
}

describe("Team-scale Gateway fixture", () => {
  sessionGatewayTest(
    "exercises authorized ticketed and cacheable native images in the late-row window",
    async ({ connect }) => {
      const fixture = createControlUiTeamScaleFixture({ now, lateRowFacts: true });
      const { request } = await connect(fixture.scenario);
      const response = await request("sessions.messages.subscribe", {
        key: fixture.selectedSessionKey,
        initialHistory: { limit: 80, maxBytes: 256 * 1024, knownState: {} },
      });
      const history = asOptionalRecord(asOptionalRecord(response.payload.initialHistory)?.payload);
      expect([...Value.Errors(SessionRowSchema, history?.sessionInfo)]).toEqual([]);
      const messages = Array.isArray(history?.messages) ? history.messages : [];
      const lastAnswer = messages
        .map(asOptionalRecord)
        .find((message) => asOptionalRecord(message?.__openclaw)?.id === "team-message-240");
      const images = (Array.isArray(lastAnswer?.content) ? lastAnswer.content : [])
        .map(asOptionalRecord)
        .filter((block) => block?.type === "image");
      expect(images).toHaveLength(2);
      expect(images[0]).toMatchObject({ artifactId: "synthetic-late-row-thumbnail" });
      expect(images[0]).not.toHaveProperty("url");
      expect(images[1]).toMatchObject({ url: "media://inbound/synthetic-l245-cacheable.png" });
      for (const image of images) {
        expectAbsent(image, "width height");
      }
      expect(history).toHaveProperty("sessionInfo.archived", true);
      const download = await request("artifacts.download", {
        sessionKey: fixture.selectedSessionKey,
        artifactId: "synthetic-late-row-thumbnail",
        transport: "http",
        previewWidth: 480,
      });
      expect(download.payload).toHaveProperty("artifact.mimeType", "image/png");
      const downloadUrl = download.payload.url;
      if (typeof downloadUrl !== "string") {
        throw new Error("The ticketed thumbnail fixture must return an HTTP download URL");
      }
      expect(fixture.assets.get(downloadUrl)?.headers?.["Cache-Control"]).toBe("private, no-store");
      expect(fixture.assets.get("/__openclaw__/assistant-media")?.headers?.["Cache-Control"]).toBe(
        "private, no-cache",
      );
      for (const path of [downloadUrl, "/__openclaw__/assistant-media"]) {
        const body = fixture.assets.get(path)?.body;
        if (!Buffer.isBuffer(body)) {
          throw new Error("The late-row fixture must serve native PNG bytes");
        }
        expect(body.readUInt32BE(16)).toBe(480);
        expect(body.readUInt32BE(20)).toBe(240);
        expect(body.length).toBeGreaterThanOrEqual(32 * 1024);
        expect(body.length).toBeLessThanOrEqual(96 * 1024);
      }
      const preview = await request("controlUi.sessionPreview", {
        sessionKey: "agent:main:synthetic-late-row-reference",
      });
      expect(preview.payload).toHaveProperty("title", "Synthetic linked research");
      const pr = await request("forge.preview", { url: fixture.lateRowFacts!.prUrl });
      expect(pr.payload).toHaveProperty("badge", { label: "Open", tone: "positive" });
    },
  );

  sessionGatewayTest.for(["normal", "large"] as const)(
    "revalidates the selected %s transcript without retransmitting cached messages",
    async (mode, { connect }) => {
      const fixture = createControlUiTeamScaleFixture({
        now,
        largeSnapshot: mode === "large",
      });
      const { request } = await connect(fixture.scenario);
      const key = fixture.selectedSessionKey;
      const cold = await request("sessions.messages.subscribe", {
        key,
        initialHistory: { knownState: {} },
      });
      const full = asOptionalRecord(asOptionalRecord(cold.payload.initialHistory)?.payload);
      expect(full).toMatchObject({
        deltaCursor: expect.any(String),
        sessionId: "team-session-271",
        sessionInfo: { key, sessionId: "team-session-271" },
        pendingInputs: { items: [], total: 0, queuedCount: 0 },
        metadata: { commands: [] },
        stateRevision: {
          sessionInfo: "fixture-session-v1",
          commands: "fixture-commands-v1",
          pendingInputs: "fixture-pending-inputs-v1",
        },
      });
      if (mode === "normal") {
        const catalog = await request("models.list", {});
        expect(catalog.payload.models).toContainEqual(
          expect.objectContaining({ id: fixture.scenario.agentModel, reasoning: true }),
        );
        expect(full).toHaveProperty("metadata.models", catalog.payload.models);
      }
      const messageCount = mode === "large" ? 1_100 : 240;
      expect(full?.messages).toHaveLength(messageCount);
      expect(full?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ __openclaw: { id: "team-message-1", seq: 1 } }),
          expect.objectContaining({
            __openclaw: { id: `team-message-${messageCount}`, seq: messageCount },
          }),
        ]),
      );
      const cursor = full?.deltaCursor;
      if (typeof cursor !== "string") {
        throw new Error("The selected fixture transcript must emit a cursor");
      }
      const windowed = await request("sessions.messages.subscribe", {
        key,
        initialHistory: { limit: 80, maxBytes: 256 * 1024, knownState: {} },
      });
      const tail = asOptionalRecord(asOptionalRecord(windowed.payload.initialHistory)?.payload);
      expect(tail).toMatchObject({
        deltaCursor: cursor,
        hasMore: true,
        nextOffset: 80,
        totalMessages: messageCount,
        metadata: { commands: [] },
        pendingInputs: { items: [], total: 0, queuedCount: 0 },
        stateRevision: {
          sessionInfo: "fixture-session-v1",
          commands: "fixture-commands-v1",
          pendingInputs: "fixture-pending-inputs-v1",
        },
      });
      expect(tail?.messages).toHaveLength(80);
      expect(tail).toHaveProperty("messages.0.__openclaw", {
        id: `team-message-${messageCount - 79}`,
        seq: messageCount - 79,
      });
      expect(tail).toHaveProperty("messages.79.__openclaw", {
        id: `team-message-${messageCount}`,
        seq: messageCount,
      });
      expect(Buffer.byteLength(JSON.stringify(windowed))).toBeLessThanOrEqual(256 * 1024);
      const older = await request("chat.history", { sessionKey: key, limit: 80, offset: 80 });
      expect(older.payload.messages).toHaveLength(messageCount);
      expect(older.payload).not.toHaveProperty("nextOffset", 80);
      const warm = await request("sessions.messages.subscribe", {
        key,
        initialHistory: { cursor, limit: 80, maxBytes: 256 * 1024, knownState: {} },
      });
      const delta = asOptionalRecord(warm.payload.initialHistory)?.payload;
      expect(delta).toMatchObject({
        kind: "delta",
        messages: [],
        deltaCursor: cursor,
        sessionInfo: { key, sessionId: "team-session-271" },
        pendingInputs: { items: [], total: 0, queuedCount: 0 },
        metadata: { commands: [] },
        stateRevision: {
          sessionInfo: "fixture-session-v1",
          commands: "fixture-commands-v1",
          pendingInputs: "fixture-pending-inputs-v1",
        },
      });
      expect(Value.Check(ChatHistoryDeltaResultSchema, delta)).toBe(true);
      expect((await request("chat.history", { sessionKey: key, cursor })).payload).toMatchObject({
        kind: "delta",
        messages: [],
      });
      for (const params of [
        { sessionKey: key, cursor: "retired-cursor" },
        { sessionKey: "agent:main:main", cursor },
      ]) {
        const result = (await request("chat.history", params)).payload;
        expect(result).not.toHaveProperty("kind");
        expect(result.messages).toHaveLength(messageCount);
        expect(result.sessionInfo).toMatchObject({ key: params.sessionKey });
      }
    },
  );

  it("seeds scoped display preferences independently of the full editable config", () => {
    const { scenario } = createControlUiTeamScaleFixture({ now });
    expect(scenario.bootstrapPreferences).toMatchObject({
      profileId: "team-person-001",
      config: { tts: { maxTextLength: 4096 } },
    });
    expect(scenario.bootstrapPreferences?.config).not.toHaveProperty("models");
    expect(scenario.methodResponses?.["config.get"]).toMatchObject({
      hash: "synthetic-config-v1",
      configRevisionHash: "synthetic-config-v1",
      appliedConfigHash: "synthetic-config-v1",
    });
    const bytes = Buffer.byteLength(JSON.stringify(scenario.methodResponses?.["config.get"]));
    expect(bytes).toBeGreaterThanOrEqual(152_000);
    expect(bytes).toBeLessThanOrEqual(169_000);
  });
  it("sustains certified ancestor churn past the minute fallback and preserves the raw delta baseline", () => {
    const fixture = createControlUiTeamScaleFixture({
      now,
      sessionEventChurn: true,
      sessionEventDurationMs: 135_000,
      sessionEventAncestorRefs: true,
    });
    expect(fixture.liveEvents).toHaveLength(1081);
    expect(fixture.liveEvents[0]?.atMs).toBe(125);
    expect(fixture.liveEvents.at(-1)?.atMs).toBe(135_125);
    const childQuery = { spawnedBy: "agent:main:main", limit: 100 };
    const children = createTeamScaleSidebarListOwner(fixture.sidebarListInput).list({
      ...childQuery,
      rowMode: "compact",
    }).result;
    expect(canApplySessionListSnapshot(children, fixture.liveEvents[0]!.payload, childQuery)).toBe(
      true,
    );
    const decoder = new GatewaySessionRowEvents();
    let references = 0;
    for (const event of fixture.liveEvents) {
      const projected = decoder.project(event);
      expect(projected.missingBaseline).toBe(false);
      if (event.kind === "sessions.changed.child-parent-reference") {
        references++;
        expect(projected.event.payload).not.toHaveProperty("ancestorSessionRefs");
        expect(projected.event.payload).toMatchObject({
          ancestorSessions: [
            {
              key: fixture.selectedSessionKey,
              ancestorRevision: "team-scale-parent-v1",
              snapshotAt: now + event.atMs,
            },
          ],
        });
      }
      if (event.kind === "sessions.changed.parent-raw-baseline-check") {
        expect(projected.event.payload).toMatchObject({
          session: {
            key: fixture.selectedSessionKey,
            derivedTitle: "Synthetic ancestor baseline verified",
            snapshotAt: now + 135_125,
          },
        });
      }
    }
    expect(references).toBe(539);
  });

  it("pages session lists using pin placement, stable key ties, and the requested activity clock", () => {
    const fixture = createControlUiTeamScaleFixture({ now });
    const rows: GatewaySessionRow[] = [
      session("newest", 900, { lastInteractionAt: 100, lastActivityAt: 200 }),
      pinned("pin-old", 100, 10, { parentSessionKey: "agent:main:main", lastInteractionAt: 800 }),
      pinned("pin-new", 50, 20, { lastInteractionAt: 200 }),
      session("tie-a", 700, { lastInteractionAt: 300, lastActivityAt: 500 }),
      session("tie-B", 700, { lastInteractionAt: 300, lastActivityAt: 500 }),
      pinned("subagent:nested", 800, 1_000, { spawnedBy: "agent:main:main" }),
      pinned("promoted", 600, 30, { spawnedBy: "agent:main:main", sidebarRoot: true }),
      session("false-pin", 650, {
        pinned: false,
        pinnedAt: 10_000,
        lastInteractionAt: 900,
        lastActivityAt: 800,
      }),
      session("created", null, { createdAt: 1_000 }),
    ];
    const owner = createTeamScaleSidebarListOwner({ ...fixture.sidebarListInput, rows });
    for (const [sortBy, expected] of [
      [undefined, "promoted pin-new pin-old newest subagent:nested tie-B tie-a false-pin created"],
      [
        "lastInteractionAt",
        "false-pin pin-old tie-B tie-a pin-new newest created promoted subagent:nested",
      ],
      ["activity", "created false-pin pin-old subagent:nested promoted tie-B tie-a newest pin-new"],
    ] as const) {
      const pages = [0, 3, 6].map((offset) => owner.list({ sortBy, offset, limit: 3 }).result);
      expect(
        pages.flatMap((page) => page.sessions.map((row) => row.key)),
        sortBy ?? "updatedAt",
      ).toEqual(expected.split(" ").map((id) => `agent:main:${id}`));
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
      ...rootOnly,
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

    const secondPage = owner.list({ limit: 100, offset: 200, ...rootOnly }).result;
    expect(secondPage.sessions).toHaveLength(100);
    expect(secondPage.sessions[0]?.sessionId).toBe("team-session-171");
    expect(secondPage).toMatchObject({ offset: 200, nextOffset: null, hasMore: false });
  });

  it("keeps persistent child details outside both boot root windows", () => {
    const fixture = createControlUiTeamScaleFixture({ now, sidebarPersistentChildren: true });
    const { parentKey, childKeys } = fixture.sidebarPersistentChildren!;
    const owner = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
    const roots = [
      owner.list({ rowMode: "sidebar", limit: 200, ownerFirst: true }).result,
      owner.list({ rowMode: "sidebar", limit: 200, involvingMe: true }).result,
    ];
    expect(childKeys).toHaveLength(4);
    for (const root of roots) {
      expect(root.sessions.some((row) => row.key === parentKey)).toBe(true);
      expect(root.sessions.some((row) => childKeys.includes(row.key))).toBe(false);
    }
    const children = owner.list({ spawnedBy: parentKey, limit: 100 }).result;
    expect(children.sessions.map((row) => row.key)).toEqual(childKeys);
    expect(children.sessions.every((row) => !row.key.includes(":subagent:"))).toBe(true);
  });

  sessionGatewayTest(
    "resolves an off-roster short deep link outside both boot windows and pins",
    async ({ connect }) => {
      const fixture = createControlUiTeamScaleFixture({ now, offRosterSession: true });
      const owner = createTeamScaleSidebarListOwner(fixture.sidebarListInput);
      for (const query of [{ ownerFirst: true }, { involvingMe: true }]) {
        const result = owner.list({ rowMode: "sidebar", limit: 200, ...query }).result;
        expect(result.sessions.some((row) => row.key === fixture.selectedSessionKey)).toBe(false);
      }
      expect(fixture.pinnedKeys).not.toContain(fixture.selectedSessionKey);
      expect(fixture.scenario.sessions?.some((row) => row.key === fixture.selectedSessionKey)).toBe(
        true,
      );
      const { request } = await connect(fixture.scenario);
      expect(
        await request("sessions.resolve", { shortId: "f00dcafe", agentId: "main" }),
      ).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          key: "agent:main:dashboard:f00dcafe-0000-4000-8000-000000000271",
          agentId: "main",
          displayName: "Project dashboard 1",
          boardFace: "dashboard",
        },
      });
    },
  );

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
    expectAbsent(first.sessions[0], "thinkingLevels model");
    expect(first.sessions[99]).toHaveProperty("derivedTitle");
    expectAbsent(first.sessions[100], "derivedTitle lastMessagePreview");
    expect(owner.list(params).result.sessions).toBe(first.sessions);

    const compact = owner.list({ rowMode: "compact", limit: 1 }).result.sessions[0];
    expect(compact).toMatchObject({ rowMode: "compact", model: "gpt-5-mini" });
    expectAbsent(compact, "thinkingLevels derivedTitle lastMessagePreview");
    const dashboard = owner.list({ rowMode: "dashboard", limit: 1 }).result.sessions[0];
    expect(dashboard).toMatchObject({ rowMode: "dashboard", owner: expect.any(Object) });
    expectAbsent(dashboard, "participants hasActiveRun");
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
    expect(catalog.jobs.slice(0, 4).map((job) => job.id)).toEqual(
      [1, 10, 100, 101].map((id) => `team-cron-${id}`),
    );
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
