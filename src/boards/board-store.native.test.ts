import { afterEach, describe, expect, it } from "vitest";
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

describe("SqliteBoardStore native widgets", () => {
  const createStore = createTestBoardStore;
  const boardSession = { sessionKey: "agent:main:board" };

  it("replaces omitted plugin props without changing unrelated layout state", async () => {
    const store = createStore();
    const initial = await store.putWidget({
      ...boardSession,
      name: "work-item",
      content: {
        kind: "plugin",
        pluginKind: "workboard:card",
        props: { cardId: "card-123", compact: true },
      },
    });
    await store.putWidget({
      ...boardSession,
      name: "left",
      content: { kind: "plugin", pluginKind: "workboard:card", props: { side: "left" } },
    });
    await store.putWidget({
      ...boardSession,
      name: "right",
      content: { kind: "plugin", pluginKind: "workboard:card", props: { side: "right" } },
    });

    expect(initial.widgets[0]).toMatchObject({
      name: "work-item",
      contentKind: "plugin",
      pluginKind: "workboard:card",
      props: { cardId: "card-123", compact: true },
      grantState: "none",
    });
    const instanceId = initial.widgets[0]?.instanceId;
    expect(instanceId).toMatch(/^[a-f0-9]{32}$/u);
    expect(await readBoardHtml(store, boardSession, "work-item")).toBeUndefined();
    expect(await store.readWidgetMcpApp(boardSession, "work-item")).toBeUndefined();

    const moved = await store.applyOps(boardSession, [
      { kind: "widget_move", name: "work-item", after: "right" },
    ]);
    expect(moved.widgets.map((widget) => widget.name)).toEqual(["left", "right", "work-item"]);
    expect(moved.widgets[2]?.props).toEqual({ cardId: "card-123", compact: true });
    expect(moved.widgets[2]?.instanceId).toBe(instanceId);
    const [left, right] = moved.widgets;

    const put = await store.putWidget({
      ...boardSession,
      name: "work-item",
      content: { kind: "plugin", pluginKind: "workboard:card" },
    });

    expect(put.widgets.map((widget) => widget.name)).toEqual(["left", "right", "work-item"]);
    expect(put.widgets[0]).toEqual(left);
    expect(put.widgets[1]).toEqual(right);
    expect(put.widgets[2]).not.toHaveProperty("props");
    expect(put.widgets[2]?.instanceId).toBe(instanceId);
    const { resolvedWidgetName: putName, ...putSnapshot } = put;
    expect(putName).toBe("work-item");
    expect(await store.getSnapshot(boardSession)).toEqual(putSnapshot);

    const placed = await store.putWidget({
      ...boardSession,
      name: "work-item",
      content: { kind: "plugin", pluginKind: "workboard:card" },
      placement: { after: "left" },
    });
    expect(placed.widgets.map((widget) => widget.name)).toEqual(["left", "work-item", "right"]);
    expect(placed.widgets[0]).toEqual(left);
    expect(placed.widgets[1]).not.toHaveProperty("props");
    expect(placed.widgets[1]?.instanceId).toBe(instanceId);
    expect(placed.widgets[2]).toEqual({ ...right, position: 2 });
    const { resolvedWidgetName: placedName, ...placedSnapshot } = placed;
    expect(placedName).toBe("work-item");
    expect(await store.getSnapshot(boardSession)).toEqual(placedSnapshot);
  });

  it("rejects oversized plugin props and capability declarations", async () => {
    const store = createStore();
    await expect(
      store.putWidget({
        ...boardSession,
        name: "too-large",
        content: {
          kind: "plugin",
          pluginKind: "workboard:mini",
          props: { value: "x".repeat(8 * 1024) },
        },
      }),
    ).rejects.toThrow("props exceed 8192 UTF-8 bytes");
    await expect(
      store.putWidget({
        ...boardSession,
        name: "declared",
        content: { kind: "plugin", pluginKind: "workboard:card" },
        declared: { tools: ["workboard.cards.move"] },
      }),
    ).rejects.toThrow("do not accept sandbox capability declarations");
  });

  it("adopts a legacy native identity only on put without backfilling reads or layout edits", async () => {
    const stateDir = tempDirs.make("openclaw-board-legacy-native-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const store = createTestBoardStore({ stateDir });
    const target = { sessionKey: "agent:main:legacy-native" };
    const content = {
      kind: "plugin" as const,
      pluginKind: "workboard:card",
      props: { cardId: "legacy-card", compact: true },
    };
    await store.applyOps(target, [{ kind: "tab_create", tabId: "status", title: "Status" }]);
    const initial = await store.putWidget({
      ...target,
      name: "legacy",
      title: "Legacy status",
      content,
      presentation: "full-bleed",
      heightMode: "auto",
      placement: { tabId: "status", size: "lg" },
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    database.db
      .prepare(
        "UPDATE board_widgets SET manifest = json_remove(manifest, '$.pluginInstanceId') WHERE session_key = ? AND name = 'legacy'",
      )
      .run(target.sessionKey);
    const readPersistedWidget = () =>
      openOpenClawAgentDatabase({ agentId: "main", env })
        .db.prepare("SELECT * FROM board_widgets WHERE session_key = ? AND name = 'legacy'")
        .get(target.sessionKey);
    const persistedLegacy = readPersistedWidget();
    const expectedLegacy = { ...initial.widgets[0]! };
    delete expectedLegacy.instanceId;

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const reopened = createTestBoardStore({ stateDir });
    expect((await reopened.getSnapshot(target)).widgets).toEqual([expectedLegacy]);
    expect(readPersistedWidget()).toEqual(persistedLegacy);

    const resized = await reopened.applyOps(target, [
      { kind: "widget_resize", name: "legacy", sizeW: 9, sizeH: 7 },
    ]);
    expect(resized.widgets).toEqual([
      { ...expectedLegacy, sizeW: 9, sizeH: 7, heightMode: "fixed" },
    ]);
    expect((await reopened.getSnapshot(target)).widgets).toEqual(resized.widgets);
    expect(readPersistedWidget()?.manifest).not.toContain("pluginInstanceId");

    const adopted = await reopened.putWidget({ ...target, name: "legacy", content });
    const instanceId = adopted.widgets[0]?.instanceId;
    expect(instanceId).toMatch(/^[a-f0-9]{32}$/u);
    expect(instanceId).not.toBe(initial.widgets[0]?.instanceId);
    expect(adopted.widgets).toEqual([{ ...resized.widgets[0], revision: 2, instanceId }]);

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    expect((await createTestBoardStore({ stateDir }).getSnapshot(target)).widgets).toEqual(
      adopted.widgets,
    );
  });

  it("keeps native widget identity across edits and reopen, but renews it after removal", async () => {
    const stateDir = tempDirs.make("openclaw-board-plugin-identity-");
    const store = createTestBoardStore({ stateDir });
    const target = { sessionKey: "agent:main:native-identity" };
    const content = { kind: "plugin" as const, pluginKind: "workboard:card" };
    const initial = await store.putWidget({ ...target, name: "status", content });
    const instanceId = initial.widgets[0]?.instanceId;
    expect(instanceId).toMatch(/^[a-f0-9]{32}$/u);

    const edited = await store.putWidget({
      ...target,
      name: "status",
      title: "Updated status",
      content: {
        ...content,
        props: { instanceId: "caller-selected", pluginInstanceId: "caller-selected" },
      },
    });
    expect(edited.widgets[0]).toMatchObject({ title: "Updated status", instanceId });
    await store.applyOps(target, [{ kind: "widget_resize", name: "status", sizeW: 8, sizeH: 6 }]);

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const reopened = createTestBoardStore({ stateDir });
    expect((await reopened.getSnapshot(target)).widgets[0]).toMatchObject({
      title: "Updated status",
      instanceId,
      sizeW: 8,
      sizeH: 6,
    });
    expect((await reopened.getSnapshotWithHtmlViewMetadata(target)).htmlViewMetadata.size).toBe(0);

    await reopened.applyOps(target, [{ kind: "widget_remove", name: "status" }]);
    const replacement = await reopened.putWidget({ ...target, name: "status", content });
    expect(replacement.widgets[0]?.instanceId).toMatch(/^[a-f0-9]{32}$/u);
    expect(replacement.widgets[0]?.instanceId).not.toBe(instanceId);
    expect((await reopened.getSnapshot(target)).widgets[0]).toEqual(replacement.widgets[0]);
  });
});
