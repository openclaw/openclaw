import { afterEach, expect, it } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  boardFixture,
  closeBoardDatabases,
} from "../../boards/board-store.fixtures.test-support.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createBoardHarness } from "./board.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  resetPluginRuntimeStateForTest();
  await closeBoardDatabases();
});

it("serializes in-flight generated-name collisions and reuses both names after reload", async () => {
  resetPluginRuntimeStateForTest();
  const {
    sessionKey,
    storeOptions: options,
    store,
  } = boardFixture(tempDirs.make("openclaw-board-generated-race-"), "agent:main:generated-race");
  let arrivals = 0;
  const { promise: readersReady, resolve: releaseReaders } = createDeferred();
  const readCanvasDocument = async (docId: string) => {
    arrivals += 1;
    if (arrivals === 2) {
      releaseReaders?.();
    }
    await readersReady;
    return { html: `<p>${docId}</p>`, cspSandbox: "scripts" as const };
  };
  const { invoke, broadcast } = createBoardHarness(readCanvasDocument, {}, store);
  const widgets = [
    { title: "売上レポート 2024", docId: "sales", key: "a" },
    { title: "在庫レポート 2024", docId: "inventory", key: "b" },
  ];
  const put = (call: typeof invoke, widget: (typeof widgets)[number], revised = false) =>
    call("board.widget.put", {
      sessionKey,
      name: "2024",
      title: widget.title,
      content: revised
        ? { kind: "html", html: `<p>${widget.docId} revised</p>` }
        : { kind: "canvas-doc", docId: widget.docId },
      generatedIdentity: {
        source: "show_widget",
        key: widget.key.repeat(64),
        fallbackName: `2024-${widget.key.repeat(8)}`,
      },
    });
  const resolvedName = (respond: Awaited<ReturnType<typeof invoke>>) => {
    const payload = respond.mock.calls[0]?.[1];
    expect(payload).toBeDefined();
    return (payload as BoardSnapshot & { resolvedWidgetName: string }).resolvedWidgetName;
  };
  const committedNames = (await Promise.all(widgets.map((widget) => put(invoke, widget)))).map(
    resolvedName,
  );
  expect(committedNames.toSorted()).toEqual(["2024", expect.stringMatching(/^2024-(a{8}|b{8})$/)]);
  const expectBroadcast = (events: typeof broadcast) =>
    expect(
      events.mock.calls.map(([, event]) => (event as { widget?: string }).widget).filter(Boolean),
    ).toEqual(expect.arrayContaining(committedNames));
  expectBroadcast(broadcast);

  await closeBoardDatabases();
  const reloaded = createBoardHarness(undefined, {}, new SqliteBoardStore(options));
  const snapshot = (await reloaded.invoke("board.get", { sessionKey })).mock
    .calls[0]?.[1] as BoardSnapshot;
  expect(new Set(snapshot.widgets.map((widget) => widget.name))).toEqual(new Set(committedNames));

  const reloads = [];
  for (const widget of widgets) {
    reloads.push(await put(reloaded.invoke, widget, true));
  }
  expect(new Set(reloads.map(resolvedName))).toEqual(new Set(committedNames));
  expectBroadcast(reloaded.broadcast);
});
