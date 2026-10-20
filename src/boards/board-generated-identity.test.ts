import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  boardFixture,
  closeBoardDatabases,
  htmlWidget,
} from "./board-store.fixtures.test-support.js";
import { readBoardHtml, createTestBoardStore } from "./board-store.test-support.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function identityWidget(
  name: string,
  title: string,
  html: string,
  key?: string,
  fallbackName = key ? `${name}-${key.repeat(8)}` : "",
) {
  return {
    ...htmlWidget("agent:main:board", name, html),
    title,
    ...(key ? { generatedIdentity: generatedIdentity(key, fallbackName) } : {}),
  };
}

function generatedIdentity(key: string, fallbackName: string) {
  return { source: "show_widget" as const, key: key.repeat(64), fallbackName };
}

afterEach(closeBoardDatabases);

describe("generated BoardStore identity", () => {
  it("keeps colliding titles distinct and canonical spellings stable", async () => {
    const store = createTestBoardStore();
    const composed = await store.putWidget(
      identityWidget("cafe-menu", "Café Menu", "<p>accented</p>", "a"),
    );
    expect(composed.resolvedWidgetName).toBe("cafe-menu");

    const decomposed = await store.putWidget(
      identityWidget("cafe-menu", "Cafe\u0301 Menu", "<p>accented revised</p>", "a"),
    );
    expect(decomposed).toMatchObject({
      resolvedWidgetName: "cafe-menu",
      widgets: [{ name: "cafe-menu", revision: 2 }],
    });

    const plain = await store.putWidget(
      identityWidget("cafe-menu", "Cafe Menu", "<p>plain</p>", "b"),
    );
    expect(plain.resolvedWidgetName).toBe("cafe-menu-bbbbbbbb");
    expect(plain.widgets.map((widget) => widget.name)).toEqual(["cafe-menu", "cafe-menu-bbbbbbbb"]);
    expect(
      (await readBoardHtml(store, { sessionKey: "agent:main:board" }, "cafe-menu"))?.html,
    ).toContain("accented revised");

    const plainUpdate = await store.putWidget(
      identityWidget("cafe-menu", "Cafe Menu", "<p>plain revised</p>", "b"),
    );
    expect(plainUpdate).toMatchObject({
      resolvedWidgetName: "cafe-menu-bbbbbbbb",
      widgets: [
        { name: "cafe-menu", revision: 2 },
        { name: "cafe-menu-bbbbbbbb", revision: 2 },
      ],
    });
  });

  it("keeps same-title explicit takeovers distinct from later generated pins", async () => {
    const store = createTestBoardStore();
    const generated = identityWidget("release-status", "Release Status", "<p>generated</p>", "c");
    await store.putWidget(generated);
    await store.putWidget(identityWidget("release-status", "Release Status", "<p>manual</p>"));
    const generatedAfterTakeover = await store.putWidget(generated);
    expect(generatedAfterTakeover.resolvedWidgetName).toBe("release-status-cccccccc");
    expect(generatedAfterTakeover.widgets).toHaveLength(2);
    expect(
      (await readBoardHtml(store, { sessionKey: "agent:main:board" }, "release-status"))?.html,
    ).toContain("manual");
  });

  it("fails closed instead of overwriting an occupied deterministic fallback", async () => {
    const store = createTestBoardStore();
    await store.putWidget(identityWidget("status", "Manual", "manual"));
    await store.putWidget(identityWidget("status-dddddddd", "Reserved", "reserved"));

    await expect(
      store.putWidget(identityWidget("status", "Generated", "generated", "d")),
    ).rejects.toThrow("generated widget fallback name is already in use");
    expect((await store.getSnapshot({ sessionKey: "agent:main:board" })).widgets).toHaveLength(2);
  });

  it("rejects a fallback that is not distinct even on an empty board", async () => {
    const store = createTestBoardStore();
    await expect(
      store.putWidget(identityWidget("status", "Status", "generated", "f", "status")),
    ).rejects.toThrow("generated widget fallback name must differ from its preferred name");
  });
});

it("preserves a beta.5-format unmarked explicit row and reuses the generated fallback", async () => {
  const {
    env,
    sessionKey,
    store,
    storeOptions: options,
    grant,
    ops,
  } = boardFixture(tempDirs.make("board-beta5-identity-"));
  await store.putWidget({
    ...htmlWidget(sessionKey, "anchor", "<p>anchor</p>"),
    title: "Anchor",
  });
  const legacy = await store.putWidget({
    ...htmlWidget(sessionKey, "cafe-menu", "<p>approved</p>"),
    title: "Café Menu",
    declared: { tools: ["menu.refresh"] },
  });
  await grant(
    "cafe-menu",
    1,
    legacy.widgets.find((widget) => widget.name === "cafe-menu")?.instanceId,
  );
  await ops({ kind: "widget_resize", name: "cafe-menu", sizeW: 8, sizeH: 6 });
  const seededDatabase = openOpenClawAgentDatabase({ agentId: "main", env });
  seededDatabase.db
    .prepare(
      "UPDATE board_widgets SET manifest = json_remove(manifest, '$.nameIdentity') WHERE session_key = ? AND name = ?",
    )
    .run(sessionKey, "cafe-menu");

  await closeBoardDatabases();

  const reopened = new SqliteBoardStore(options);
  const generated = await reopened.putWidget({
    ...htmlWidget(sessionKey, "cafe-menu", "<p>generated</p>"),
    title: "Cafe\u0301 Menu",
    generatedIdentity: generatedIdentity("e", "cafe-menu-eeeeeeee"),
  });
  expect(generated.resolvedWidgetName).toBe("cafe-menu-eeeeeeee");
  const preserved = {
    name: "cafe-menu",
    revision: 1,
    grantState: "granted",
    sizeW: 8,
    sizeH: 6,
    position: 1,
  };
  expect(generated.widgets.find((widget) => widget.name === "cafe-menu")).toMatchObject(preserved);
  expect((await readBoardHtml(reopened, { sessionKey }, "cafe-menu"))?.html).toContain("approved");

  await closeBoardDatabases();

  const durable = new SqliteBoardStore(options);
  const reused = await durable.putWidget({
    ...htmlWidget(sessionKey, "cafe-menu", "<p>generated revised</p>"),
    title: "Café Menu",
    generatedIdentity: generatedIdentity("e", "cafe-menu-eeeeeeee"),
  });
  expect(reused.resolvedWidgetName).toBe("cafe-menu-eeeeeeee");
  expect(reused.widgets.find((widget) => widget.name === "cafe-menu-eeeeeeee")).toMatchObject({
    revision: 2,
  });
  expect((await readBoardHtml(durable, { sessionKey }, "cafe-menu"))?.html).toContain("approved");
  await closeBoardDatabases();

  expect(
    (await new SqliteBoardStore(options).getSnapshot({ sessionKey })).widgets.find(
      (widget) => widget.name === "cafe-menu",
    ),
  ).toMatchObject(preserved);
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const row = database.db
    .prepare("SELECT manifest FROM board_widgets WHERE session_key = ? AND name = ?")
    .get(sessionKey, "cafe-menu-eeeeeeee") as { manifest: string };
  expect(JSON.parse(row.manifest)).toMatchObject({
    nameIdentity: { kind: "generated", source: "show_widget", key: "e".repeat(64) },
  });
});

it("does not infer generated ownership from a canonical unmarked title match", async () => {
  const {
    env,
    sessionKey,
    store,
    storeOptions: options,
  } = boardFixture(tempDirs.make("board-canonical-legacy-"));
  await store.putWidget({
    ...htmlWidget(sessionKey, "widget-e3b21956", "<p>legacy</p>"),
    title: "が",
  });
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  database.db
    .prepare(
      "UPDATE board_widgets SET manifest = json_remove(manifest, '$.nameIdentity') WHERE session_key = ? AND name = ?",
    )
    .run(sessionKey, "widget-e3b21956");
  await closeBoardDatabases();

  const reopened = new SqliteBoardStore(options);
  const generated = await reopened.putWidget({
    ...htmlWidget(sessionKey, "widget-f62b28f7", "<p>updated</p>"),
    title: "が",
    generatedIdentity: generatedIdentity("a", "widget-aaaaaaaa"),
  });
  expect(generated.resolvedWidgetName).toBe("widget-f62b28f7");
  expect(generated.widgets).toHaveLength(2);
  expect((await readBoardHtml(reopened, { sessionKey }, "widget-e3b21956"))?.html).toContain(
    "legacy",
  );
});

it("persists explicit ownership across restart", async () => {
  const { sessionKey, storeOptions: options } = boardFixture(
    tempDirs.make("board-explicit-owner-"),
  );
  await new SqliteBoardStore(options).putWidget({
    ...htmlWidget(sessionKey, "status", "<p>manual</p>"),
    title: "Status",
  });
  await closeBoardDatabases();

  const reopened = new SqliteBoardStore(options);
  const generated = await reopened.putWidget({
    ...htmlWidget(sessionKey, "status", "<p>generated</p>"),
    title: "Status",
    generatedIdentity: generatedIdentity("d", "status-dddddddd"),
  });
  expect(generated.resolvedWidgetName).toBe("status-dddddddd");
  expect((await readBoardHtml(reopened, { sessionKey }, "status"))?.html).toContain("manual");
});
