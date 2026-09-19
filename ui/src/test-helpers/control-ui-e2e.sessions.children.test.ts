/* @vitest-environment jsdom */
import { expect } from "vitest";
import { sessionGatewayTest as it } from "./control-ui-e2e.sessions.test-support.ts";

it.for(["rows", "static list"])(
  "excludes a running parent from child queries (%s)",
  async (source, { connect }) => {
    const parent = { key: "agent:main:main", sessionId: "parent-session" };
    const rows = [parent, { key: "agent:main:unrelated", sessionId: "unrelated-session" }];
    const { request } = await connect({
      sessionKey: parent.key,
      ...(source === "rows"
        ? { sessions: rows }
        : { methodResponses: { "sessions.list": { sessions: rows, count: rows.length } } }),
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
  },
);

it.for(["rows", "static list"])(
  "uses current child ownership before archive partitioning (%s)",
  async (source, { connect }) => {
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
      ...(source === "rows"
        ? { sessions: rows }
        : { methodResponses: { "sessions.list": { sessions: rows, count: rows.length } } }),
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
  },
);

it.for([false, true])(
  "returns a complete child total after filtering a complete fixture (materialized: %s)",
  async (materialized, { connect }) => {
    const parent = "agent:main:parent";
    const { request, controls } = await connect({
      methodResponses: {
        "sessions.list": {
          sessions: [{ key: parent }],
          count: 1,
          totalCount: 1,
          offset: 0,
          hasMore: false,
          nextOffset: null,
        },
      },
    });
    const children = materialized ? ["agent:main:child-one", "agent:main:child-two"] : [];
    for (const key of children) {
      controls.setMethodResponse("sessions.create", { key, entry: { spawnedBy: parent } });
      await request("sessions.create", {});
    }

    const result = (await request("sessions.list", { spawnedBy: parent })).payload;
    expect(result).toMatchObject({
      count: children.length,
      totalCount: children.length,
      hasMore: false,
      nextOffset: null,
    });
    expect(result.sessions).toEqual(children.map((key) => expect.objectContaining({ key })));
  },
);

it("preserves metadata for an already scoped child page", async ({ connect }) => {
  const child = {
    key: "agent:main:child",
    sessionId: "session:agent:main:child",
    spawnedBy: "agent:main:parent",
    archived: false,
    pinned: false,
  };
  const page = {
    sessions: [child],
    count: 1,
    totalCount: 200,
    hasMore: true,
    offset: 0,
    nextOffset: 1,
  };
  const { request } = await connect({ methodResponses: { "sessions.list": page } });

  expect(
    (await request("sessions.list", { spawnedBy: child.spawnedBy, limit: 1 })).payload,
  ).toEqual(page);
});
