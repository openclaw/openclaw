import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  boardFixture,
  closeBoardDatabases,
  htmlWidget,
} from "./board-store.fixtures.test-support.js";
import type { BoardStore } from "./board-store.js";
import { readBoardHtml, createTestBoardStore } from "./board-store.test-support.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const target = { sessionKey: "agent:main:board" };
const readHtml = (store: BoardStore, name: string) => readBoardHtml(store, target, name);

function fixture() {
  const context = boardFixture(tempDirs.make("board-identity-"));
  return {
    ...context,
    reopen: () => new SqliteBoardStore(context.storeOptions),
    unmark(name: string) {
      context.database.db
        .prepare(
          "UPDATE board_widgets SET manifest = json_remove(manifest, '$.nameIdentity') WHERE session_key = ? AND name = ?",
        )
        .run(context.sessionKey, name);
    },
  };
}

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
    expect((await readHtml(store, "cafe-menu"))?.html).toContain("accented revised");

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
    expect((await readHtml(store, "release-status"))?.html).toContain("manual");
  });

  it("fails closed instead of overwriting an occupied deterministic fallback", async () => {
    const store = createTestBoardStore();
    await store.putWidget(identityWidget("status", "Manual", "manual"));
    await store.putWidget(identityWidget("status-dddddddd", "Reserved", "reserved"));

    await expect(
      store.putWidget(identityWidget("status", "Generated", "generated", "d")),
    ).rejects.toThrow("generated widget fallback name is already in use");
    expect((await store.getSnapshot(target)).widgets).toHaveLength(2);
  });

  it("rejects a fallback that is not distinct even on an empty board", async () => {
    const store = createTestBoardStore();
    await expect(
      store.putWidget(identityWidget("status", "Status", "generated", "f", "status")),
    ).rejects.toThrow("generated widget fallback name must differ from its preferred name");
  });
});

it("preserves a beta.5-format unmarked explicit row and reuses the generated fallback", async () => {
  const { env, sessionKey, store, reopen, unmark, grant, ops } = fixture();
  await store.putWidget(identityWidget("anchor", "Anchor", "<p>anchor</p>"));
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
  unmark("cafe-menu");

  await closeBoardDatabases();

  const reopened = reopen();
  const generated = await reopened.putWidget(
    identityWidget("cafe-menu", "Cafe\u0301 Menu", "<p>generated</p>", "e"),
  );
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
  expect((await readHtml(reopened, "cafe-menu"))?.html).toContain("approved");

  await closeBoardDatabases();

  const durable = reopen();
  const reused = await durable.putWidget(
    identityWidget("cafe-menu", "Café Menu", "<p>generated revised</p>", "e"),
  );
  expect(reused.resolvedWidgetName).toBe("cafe-menu-eeeeeeee");
  expect(reused.widgets.find((widget) => widget.name === "cafe-menu-eeeeeeee")).toMatchObject({
    revision: 2,
  });
  expect((await readHtml(durable, "cafe-menu"))?.html).toContain("approved");
  await closeBoardDatabases();

  expect(
    (await reopen().getSnapshot(target)).widgets.find((widget) => widget.name === "cafe-menu"),
  ).toMatchObject(preserved);
  const row = openOpenClawAgentDatabase({ agentId: "main", env })
    .db.prepare("SELECT manifest FROM board_widgets WHERE session_key = ? AND name = ?")
    .get(sessionKey, "cafe-menu-eeeeeeee") as { manifest: string };
  expect(JSON.parse(row.manifest)).toMatchObject({
    nameIdentity: { kind: "generated", source: "show_widget", key: "e".repeat(64) },
  });
});

it("does not infer generated ownership from a canonical unmarked title match", async () => {
  const { store, reopen, unmark } = fixture();
  await store.putWidget(identityWidget("widget-e3b21956", "が", "<p>legacy</p>"));
  unmark("widget-e3b21956");
  await closeBoardDatabases();

  const reopened = reopen();
  const generated = await reopened.putWidget(
    identityWidget("widget-f62b28f7", "が", "<p>updated</p>", "a", "widget-aaaaaaaa"),
  );
  expect(generated.resolvedWidgetName).toBe("widget-f62b28f7");
  expect(generated.widgets).toHaveLength(2);
  expect((await readHtml(reopened, "widget-e3b21956"))?.html).toContain("legacy");
});

it("persists explicit ownership across restart", async () => {
  const { store, reopen } = fixture();
  await store.putWidget(identityWidget("status", "Status", "<p>manual</p>"));
  await closeBoardDatabases();

  const reopened = reopen();
  const generated = await reopened.putWidget(
    identityWidget("status", "Status", "<p>generated</p>", "d"),
  );
  expect(generated.resolvedWidgetName).toBe("status-dddddddd");
  expect((await readHtml(reopened, "status"))?.html).toContain("manual");
});
