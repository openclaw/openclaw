/* @vitest-environment jsdom */
import { expect } from "vitest";
import { sessionGatewayTest as it } from "./control-ui-e2e.sessions.test-support.ts";

it("excludes a running parent from child queries", async ({ connect }) => {
  const parent = { key: "agent:main:main", sessionId: "parent-session" };
  const rows = [parent, { key: "agent:main:unrelated", sessionId: "unrelated-session" }];
  const { request } = await connect({
    sessionKey: parent.key,
    sessions: rows,
  });
  await request("chat.send", {
    sessionKey: parent.key,
    message: "Start the parent turn",
    idempotencyKey: "parent-run",
  });

  expect((await request("sessions.list", { spawnedBy: parent.key })).payload).toMatchObject({
    count: 0,
    sessions: [],
  });
  expect((await request("sessions.list")).payload.sessions).toEqual([
    expect.objectContaining({ ...parent, status: "running", hasActiveRun: true }),
    expect.objectContaining(rows[1]!),
  ]);
});

it("uses current child ownership before archive partitioning", async ({ connect }) => {
  const parent = "agent:main:parent";
  const spawned = { key: "agent:main:spawned", spawnedBy: parent };
  const navigation = { key: "agent:main:navigation", parentSessionKey: parent };
  const controlled = {
    key: "agent:main:controlled",
    spawnedBy: "agent:main:old-owner",
    controlOwnerSessionKey: parent,
  };
  const archived = { key: "agent:main:archived-child", spawnedBy: parent, archived: true };
  const rows = [
    { key: parent, spawnedBy: parent },
    spawned,
    navigation,
    controlled,
    archived,
    { key: "agent:main:moved", spawnedBy: parent, controlOwnerSessionKey: "agent:main:other" },
    { key: "agent:main:unrelated" },
  ];
  const { request } = await connect({
    sessionKey: parent,
    sessionArchiveFiltering: true,
    methodResponses: { "sessions.list": { sessions: rows, count: rows.length } },
  });
  for (const [filter, expected] of [
    [false, [spawned, navigation, controlled]],
    [true, [archived]],
    ["all", [spawned, navigation, controlled, archived]],
  ] as const) {
    expect(
      (await request("sessions.list", { spawnedBy: ` ${parent} `, archived: filter })).payload,
    ).toMatchObject({
      count: expected.length,
      sessions: expected.map((row) => expect.objectContaining(row)),
    });
  }
  expect((await request("sessions.list", { archived: "all" })).payload.count).toBe(rows.length);
});

it.for(["empty", "materialized", "scoped"])(
  "preserves child pagination for a %s fixture",
  async (kind, { connect }) => {
    const parent = "agent:main:parent";
    const child = {
      key: "agent:main:child",
      sessionId: "session:agent:main:child",
      spawnedBy: parent,
      archived: false,
      pinned: false,
    };
    const scoped = kind === "scoped";
    const page = {
      sessions: scoped ? [child] : [{ key: parent }],
      count: 1,
      totalCount: scoped ? 200 : 1,
      offset: 0,
      hasMore: scoped,
      nextOffset: scoped ? 1 : null,
    };
    const { request, controls } = await connect({
      methodResponses: { "sessions.list": page },
    });
    const children =
      kind === "materialized" ? ["agent:main:child-one", "agent:main:child-two"] : [];
    for (const key of children) {
      controls.setMethodResponse("sessions.create", { key, entry: { spawnedBy: parent } });
      await request("sessions.create", {});
    }

    const result = (
      await request("sessions.list", { spawnedBy: parent, ...(scoped ? { limit: 1 } : {}) })
    ).payload;
    if (scoped) {
      expect(result).toEqual({ ...page, sessions: [{ ...child, snapshotAt: expect.any(Number) }] });
    } else {
      expect(result).toMatchObject({
        count: children.length,
        totalCount: children.length,
        hasMore: false,
        nextOffset: null,
      });
      expect(result.sessions).toEqual(children.map((key) => expect.objectContaining({ key })));
    }
  },
);
