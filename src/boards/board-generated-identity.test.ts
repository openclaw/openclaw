import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { BoardStore } from "./board-store.js";
import { readBoardHtml, createTestBoardStore } from "./board-store.test-support.js";
import { SqliteBoardStore } from "./sqlite-board-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function seedSession(env: NodeJS.ProcessEnv, sessionKey: string): void {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  replaceSessionEntrySync(
    { agentId: "main", sessionKey, storePath: database.path },
    { sessionId: `session-${sessionKey.replaceAll(":", "-")}`, updatedAt: Date.now() },
  );
}

function createSqliteStore(): BoardStore {
  return createTestBoardStore();
}

function generatedIdentity(key: string, fallbackName: string) {
  return {
    source: "show_widget" as const,
    key: key.repeat(64),
    fallbackName,
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("generated BoardStore identity", () => {
  const createStore = createSqliteStore;
  it("keeps colliding titles distinct and canonical spellings stable", async () => {
    const store = createStore();
    const composed = await store.putWidget({
      sessionKey: "agent:main:board",
      name: "cafe-menu",
      title: "Café Menu",
      content: { kind: "html", html: "<p>accented</p>" },
      generatedIdentity: generatedIdentity("a", "cafe-menu-aaaaaaaa"),
    });
    expect(composed.resolvedWidgetName).toBe("cafe-menu");

    const decomposed = await store.putWidget({
      sessionKey: "agent:main:board",
      name: "cafe-menu",
      title: "Cafe\u0301 Menu",
      content: { kind: "html", html: "<p>accented revised</p>" },
      generatedIdentity: generatedIdentity("a", "cafe-menu-aaaaaaaa"),
    });
    expect(decomposed).toMatchObject({
      resolvedWidgetName: "cafe-menu",
      widgets: [{ name: "cafe-menu", revision: 2 }],
    });

    const plain = await store.putWidget({
      sessionKey: "agent:main:board",
      name: "cafe-menu",
      title: "Cafe Menu",
      content: { kind: "html", html: "<p>plain</p>" },
      generatedIdentity: generatedIdentity("b", "cafe-menu-bbbbbbbb"),
    });
    expect(plain.resolvedWidgetName).toBe("cafe-menu-bbbbbbbb");
    expect(plain.widgets.map((widget) => widget.name)).toEqual(["cafe-menu", "cafe-menu-bbbbbbbb"]);
    expect(
      (await readBoardHtml(store, { sessionKey: "agent:main:board" }, "cafe-menu"))?.html,
    ).toContain("accented revised");

    const plainUpdate = await store.putWidget({
      sessionKey: "agent:main:board",
      name: "cafe-menu",
      title: "Cafe Menu",
      content: { kind: "html", html: "<p>plain revised</p>" },
      generatedIdentity: generatedIdentity("b", "cafe-menu-bbbbbbbb"),
    });
    expect(plainUpdate).toMatchObject({
      resolvedWidgetName: "cafe-menu-bbbbbbbb",
      widgets: [
        { name: "cafe-menu", revision: 2 },
        { name: "cafe-menu-bbbbbbbb", revision: 2 },
      ],
    });
  });

  it("keeps same-title explicit takeovers distinct from later generated pins", async () => {
    const store = createStore();
    await store.putWidget({
      sessionKey: "agent:main:board",
      name: "release-status",
      title: "Release Status",
      content: { kind: "html", html: "<p>generated</p>" },
      generatedIdentity: generatedIdentity("c", "release-status-cccccccc"),
    });
    await store.putWidget({
      sessionKey: "agent:main:board",
      name: "release-status",
      title: "Release Status",
      content: { kind: "html", html: "<p>manual</p>" },
    });
    const generatedAfterTakeover = await store.putWidget({
      sessionKey: "agent:main:board",
      name: "release-status",
      title: "Release Status",
      content: { kind: "html", html: "<p>generated</p>" },
      generatedIdentity: generatedIdentity("c", "release-status-cccccccc"),
    });
    expect(generatedAfterTakeover.resolvedWidgetName).toBe("release-status-cccccccc");
    expect(generatedAfterTakeover.widgets).toHaveLength(2);
    expect(
      (await readBoardHtml(store, { sessionKey: "agent:main:board" }, "release-status"))?.html,
    ).toContain("manual");
  });

  it("fails closed instead of overwriting an occupied deterministic fallback", async () => {
    const store = createStore();
    await store.putWidget({
      sessionKey: "agent:main:board",
      name: "status",
      title: "Manual",
      content: { kind: "html", html: "manual" },
    });
    await store.putWidget({
      sessionKey: "agent:main:board",
      name: "status-dddddddd",
      title: "Reserved",
      content: { kind: "html", html: "reserved" },
    });

    await expect(
      store.putWidget({
        sessionKey: "agent:main:board",
        name: "status",
        title: "Generated",
        content: { kind: "html", html: "generated" },
        generatedIdentity: generatedIdentity("d", "status-dddddddd"),
      }),
    ).rejects.toThrow("generated widget fallback name is already in use");
    expect((await store.getSnapshot({ sessionKey: "agent:main:board" })).widgets).toHaveLength(2);
  });

  it("rejects a fallback that is not distinct even on an empty board", async () => {
    const store = createStore();
    await expect(
      store.putWidget({
        sessionKey: "agent:main:board",
        name: "status",
        title: "Status",
        content: { kind: "html", html: "generated" },
        generatedIdentity: generatedIdentity("f", "status"),
      }),
    ).rejects.toThrow("generated widget fallback name must differ from its preferred name");
  });
});

it("preserves a beta.5-format unmarked explicit row and reuses the generated fallback", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-board-beta5-identity-") };
  const sessionKey = "agent:main:beta5-identity";
  seedSession(env, sessionKey);
  const options = {
    resolveSession: () => ({ agentId: "main", sessionKey }),
    env,
  };
  const store = new SqliteBoardStore(options);
  await store.putWidget({
    sessionKey,
    name: "anchor",
    title: "Anchor",
    content: { kind: "html", html: "<p>anchor</p>" },
  });
  const legacy = await store.putWidget({
    sessionKey,
    name: "cafe-menu",
    title: "Café Menu",
    content: { kind: "html", html: "<p>approved</p>" },
    declared: { tools: ["menu.refresh"] },
  });
  await store.grant(
    { sessionKey },
    "cafe-menu",
    "granted",
    1,
    legacy.widgets.find((widget) => widget.name === "cafe-menu")?.instanceId,
  );
  await store.applyOps({ sessionKey }, [
    { kind: "widget_resize", name: "cafe-menu", sizeW: 8, sizeH: 6 },
  ]);
  const seededDatabase = openOpenClawAgentDatabase({ agentId: "main", env });
  seededDatabase.db
    .prepare(
      "UPDATE board_widgets SET manifest = json_remove(manifest, '$.nameIdentity') WHERE session_key = ? AND name = ?",
    )
    .run(sessionKey, "cafe-menu");

  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  const reopened = new SqliteBoardStore(options);
  const generated = await reopened.putWidget({
    sessionKey,
    name: "cafe-menu",
    title: "Cafe\u0301 Menu",
    content: { kind: "html", html: "<p>generated</p>" },
    generatedIdentity: generatedIdentity("e", "cafe-menu-eeeeeeee"),
  });
  expect(generated.resolvedWidgetName).toBe("cafe-menu-eeeeeeee");
  expect(generated.widgets.find((widget) => widget.name === "cafe-menu")).toMatchObject({
    name: "cafe-menu",
    revision: 1,
    grantState: "granted",
    sizeW: 8,
    sizeH: 6,
    position: 1,
  });
  expect((await readBoardHtml(reopened, { sessionKey }, "cafe-menu"))?.html).toContain("approved");

  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  const durable = new SqliteBoardStore(options);
  const reused = await durable.putWidget({
    sessionKey,
    name: "cafe-menu",
    title: "Café Menu",
    content: { kind: "html", html: "<p>generated revised</p>" },
    generatedIdentity: generatedIdentity("e", "cafe-menu-eeeeeeee"),
  });
  expect(reused.resolvedWidgetName).toBe("cafe-menu-eeeeeeee");
  expect(reused.widgets.find((widget) => widget.name === "cafe-menu-eeeeeeee")).toMatchObject({
    revision: 2,
  });
  expect((await readBoardHtml(durable, { sessionKey }, "cafe-menu"))?.html).toContain("approved");
  closeOpenClawAgentDatabasesForTest();

  expect(
    (await new SqliteBoardStore(options).getSnapshot({ sessionKey })).widgets.find(
      (widget) => widget.name === "cafe-menu",
    ),
  ).toMatchObject({
    name: "cafe-menu",
    revision: 1,
    grantState: "granted",
    sizeW: 8,
    sizeH: 6,
    position: 1,
  });
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const row = database.db
    .prepare("SELECT manifest FROM board_widgets WHERE session_key = ? AND name = ?")
    .get(sessionKey, "cafe-menu-eeeeeeee") as { manifest: string };
  expect(JSON.parse(row.manifest)).toMatchObject({
    nameIdentity: { kind: "generated", source: "show_widget", key: "e".repeat(64) },
  });
});

it("does not infer generated ownership from a canonical unmarked title match", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-board-canonical-legacy-") };
  const sessionKey = "agent:main:canonical-legacy";
  seedSession(env, sessionKey);
  const options = {
    resolveSession: () => ({ agentId: "main", sessionKey }),
    env,
  };
  const store = new SqliteBoardStore(options);
  await store.putWidget({
    sessionKey,
    name: "widget-e3b21956",
    title: "が",
    content: { kind: "html", html: "<p>legacy</p>" },
  });
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  database.db
    .prepare(
      "UPDATE board_widgets SET manifest = json_remove(manifest, '$.nameIdentity') WHERE session_key = ? AND name = ?",
    )
    .run(sessionKey, "widget-e3b21956");
  closeOpenClawAgentDatabasesForTest();

  const reopened = new SqliteBoardStore(options);
  const generated = await reopened.putWidget({
    sessionKey,
    name: "widget-f62b28f7",
    title: "が",
    content: { kind: "html", html: "<p>updated</p>" },
    generatedIdentity: generatedIdentity("a", "widget-aaaaaaaa"),
  });
  expect(generated.resolvedWidgetName).toBe("widget-f62b28f7");
  expect(generated.widgets).toHaveLength(2);
  expect((await readBoardHtml(reopened, { sessionKey }, "widget-e3b21956"))?.html).toContain(
    "legacy",
  );
});

it("preserves unmarked rows whose absent or capped titles are ambiguous", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-board-ambiguous-legacy-") };
  const sessionKey = "agent:main:ambiguous-legacy";
  seedSession(env, sessionKey);
  const options = {
    resolveSession: () => ({ agentId: "main", sessionKey }),
    env,
  };
  const store = new SqliteBoardStore(options);
  const cappedTitle = `${"!".repeat(79)}a`;
  await store.putWidget({
    sessionKey,
    name: "status",
    content: { kind: "html", html: "<p>manual untitled</p>" },
  });
  await store.putWidget({
    sessionKey,
    name: "report",
    title: cappedTitle,
    content: { kind: "html", html: "<p>legacy long</p>" },
  });
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  database.db
    .prepare(
      "UPDATE board_widgets SET manifest = json_remove(manifest, '$.nameIdentity') WHERE session_key = ?",
    )
    .run(sessionKey);
  closeOpenClawAgentDatabasesForTest();

  const reopened = new SqliteBoardStore(options);
  const untitled = await reopened.putWidget({
    sessionKey,
    name: "status",
    content: { kind: "html", html: "<p>generated untitled</p>" },
    generatedIdentity: generatedIdentity("b", "status-bbbbbbbb"),
  });
  const long = await reopened.putWidget({
    sessionKey,
    name: "report",
    title: cappedTitle,
    content: { kind: "html", html: "<p>generated long</p>" },
    generatedIdentity: generatedIdentity("c", "report-cccccccc"),
  });

  expect(untitled.resolvedWidgetName).toBe("status-bbbbbbbb");
  expect(long.resolvedWidgetName).toBe("report-cccccccc");
  expect((await readBoardHtml(reopened, { sessionKey }, "status"))?.html).toContain(
    "manual untitled",
  );
  expect((await readBoardHtml(reopened, { sessionKey }, "report"))?.html).toContain("legacy long");
});

it("persists explicit ownership across restart", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-board-explicit-owner-") };
  const sessionKey = "agent:main:explicit-owner";
  seedSession(env, sessionKey);
  const options = {
    resolveSession: () => ({ agentId: "main", sessionKey }),
    env,
  };
  await new SqliteBoardStore(options).putWidget({
    sessionKey,
    name: "status",
    title: "Status",
    content: { kind: "html", html: "<p>manual</p>" },
  });
  closeOpenClawAgentDatabasesForTest();

  const reopened = new SqliteBoardStore(options);
  const generated = await reopened.putWidget({
    sessionKey,
    name: "status",
    title: "Status",
    content: { kind: "html", html: "<p>generated</p>" },
    generatedIdentity: generatedIdentity("d", "status-dddddddd"),
  });
  expect(generated.resolvedWidgetName).toBe("status-dddddddd");
  expect((await readBoardHtml(reopened, { sessionKey }, "status"))?.html).toContain("manual");
});
