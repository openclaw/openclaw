import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestBoardStore, readBoardHtml } from "./board-store.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("round-trips and removes a board with many tabs", async () => {
  const store = createTestBoardStore();
  const target = { sessionKey: "agent:main:many-tabs" };
  const tabIds = Array.from({ length: 130 }, (_, index) => `tab-${index}`);
  const created = await store.applyOps(
    target,
    tabIds.map((tabId) => ({ kind: "tab_create", tabId, title: tabId })),
  );
  expect(created.tabs.map((tab) => tab.tabId)).toEqual(tabIds);
  expect(await store.getSnapshot(target)).toEqual(created);
  expect(
    await store.applyOps(
      target,
      tabIds.map((tabId) => ({ kind: "tab_delete", tabId })),
    ),
  ).toEqual({
    ...target,
    revision: 2,
    tabs: [],
    widgets: [],
  });
  expect(await store.getSnapshot(target)).toEqual({
    ...target,
    revision: 0,
    tabs: [],
    widgets: [],
  });
});

it("rolls back late board writes and preserves surviving widget documents", async () => {
  const stateDir = tempDirs.make("openclaw-board-batch-rollback-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const sessionKey = "agent:main:batch-rollback";
  const store = createTestBoardStore({ stateDir });

  const tabIds = Array.from({ length: 130 }, (_, index) => `tab-${index}`);
  await store.applyOps(
    { sessionKey },
    tabIds.map((tabId) => ({
      kind: "tab_create",
      tabId,
      title: tabId,
    })),
  );
  const widgetNames = tabIds.slice(0, 48);
  for (const name of widgetNames) {
    await store.putWidget({ sessionKey, name, content: { kind: "html", html: name } });
  }
  const before = await store.getSnapshot({ sessionKey });
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const readRows = () => ({
    tabs: database.db.prepare("SELECT * FROM board_tabs ORDER BY session_key, tab_id").all(),
    widgets: database.db.prepare("SELECT * FROM board_widgets ORDER BY session_key, name").all(),
  });
  const beforeRows = readRows();
  database.db.exec(`CREATE TEMP TRIGGER reject_late_tab_write BEFORE UPDATE ON board_tabs
      WHEN NEW.tab_id = 'tab-129' BEGIN SELECT RAISE(ABORT, 'late tab write'); END;`);
  await expect(
    store.applyOps({ sessionKey }, [
      {
        kind: "tab_update",
        tabId: "tab-0",
        title: "changed",
      },
    ]),
  ).rejects.toThrow("late tab write");
  expect(readRows()).toEqual(beforeRows);
  database.db.exec("DROP TRIGGER reject_late_tab_write");
  expect(await store.getSnapshot({ sessionKey })).toEqual(before);

  const removedNames = widgetNames.slice(0, -1);
  const removeOps = removedNames.map((name) => ({ kind: "widget_remove" as const, name }));
  database.db.exec(`CREATE TEMP TRIGGER reject_late_widget_delete BEFORE DELETE ON board_widgets
      WHEN OLD.name = 'tab-46' BEGIN SELECT RAISE(ABORT, 'late widget delete'); END;`);
  await expect(store.applyOps({ sessionKey }, removeOps)).rejects.toThrow("late widget delete");
  expect(readRows()).toEqual(beforeRows);
  database.db.exec("DROP TRIGGER reject_late_widget_delete");
  const removed = await store.applyOps({ sessionKey }, removeOps);
  expect(removed.widgets.map((widget) => widget.name)).toEqual(["tab-47"]);
  expect(await store.getSnapshot({ sessionKey })).toEqual(removed);
  expect(await readBoardHtml(store, { sessionKey }, "tab-47")).toMatchObject({
    html: "tab-47",
  });
  expect(await readBoardHtml(store, { sessionKey }, "tab-46")).toBeUndefined();
});
