import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDashboardTool } from "../../agents/tools/dashboard-tool.js";
import * as inProcessGateway from "../../agents/tools/in-process-gateway.js";
import { boardFixture, htmlWidget } from "../../boards/board-store.fixtures.test-support.js";
import { closeBoardDatabases } from "../../boards/board-store.test-support.js";
import { parseComponentConversation } from "../../boards/component-conversation.js";
import { createShowWidgetTool } from "../../canvas/widget-tool.js";
import { createBoardHarness } from "./board.test-support.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeBoardDatabases();
    cleanup();
  }),
);
const parent = "agent:main:lobby-11111111-1111-4111-8111-111111111111";

it("keeps separate component conversations on their original board and refuses stale or different targets", async () => {
  const fixture = boardFixture(dirs.make("component-conversation-"), parent);
  await fixture.store.putWidget(htmlWidget(parent, "first", "<p>First</p>"));
  await fixture.store.putWidget(htmlWidget(parent, "second", "<p>Second</p>"));
  const harness = createBoardHarness(undefined, {}, fixture.store);
  const gateway: inProcessGateway.InProcessGatewayCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
  ) => {
    const response = await harness.invoke(method, params);
    const [ok, result, error] = response.mock.calls[0]!;
    if (!ok) {
      throw new Error(error?.message);
    }
    return result as T;
  };
  vi.spyOn(inProcessGateway, "callInProcessGatewayTool").mockImplementation(gateway);
  const reserve = async (name: string) => {
    const widget = (await fixture.snapshot()).widgets.find((candidate) => candidate.name === name)!;
    return gateway<{ key: string; title: string }>("board.widget.conversation", {
      sessionKey: parent,
      name,
      instanceId: widget.instanceId,
    });
  };
  const first = await reserve("first");
  const second = await reserve("second");
  expect(first.key).not.toBe(second.key);
  expect(await reserve("first")).toEqual(first);
  const dashboard = createDashboardTool({ agentSessionKey: first.key, callGateway: gateway });
  const reading = await dashboard.execute("read", { action: "read" });
  expect(reading.details).toMatchObject({ widgets: [{ name: "first" }] });
  expect(JSON.stringify(reading.details)).not.toContain('"name":"second"');
  const author = createShowWidgetTool({ agentSessionKey: first.key });
  await author.execute("edit", {
    title: "Updated first",
    pin: true,
    widget_code: "<p>Updated first</p>",
  });
  expect(await fixture.document("first")).toMatchObject({
    html: expect.stringContaining("Updated first"),
  });
  expect(await fixture.document("second")).toMatchObject({ html: "<p>Second</p>" });
  expect((await reserve("first")).key).toBe(first.key);
  await expect(
    dashboard.execute("wrong-name", { action: "widget_remove", name: "second" }),
  ).rejects.toThrow("only its own");
  await expect(dashboard.execute("tab", { action: "tab_delete", tabId: "main" })).rejects.toThrow(
    "only its own",
  );
  const target = parseComponentConversation(first.key)!;
  // The persistence owner also checks the scope, independently of tool-side guidance.
  await expect(
    fixture.store.putWidget({
      ...htmlWidget(parent, "second", "bad"),
      component: target.component,
    }),
  ).rejects.toThrow("only its own");
  await fixture.ops({ kind: "widget_remove", name: "first" });
  await fixture.store.putWidget(htmlWidget(parent, "first", "<p>Replacement</p>"));
  expect((await reserve("first")).key).not.toBe(first.key);
  await expect(
    author.execute("stale-edit", { title: "Stale", pin: true, widget_code: "<p>Do not write</p>" }),
  ).rejects.toThrow("removed or replaced");
  await expect(dashboard.execute("stale-read", { action: "read" })).rejects.toThrow(
    "removed or replaced",
  );
  expect(await fixture.document("first")).toMatchObject({ html: "<p>Replacement</p>" });
});

it("backfills an existing component without changing content, grants, revision or layout", async () => {
  const fixture = boardFixture(dirs.make("component-legacy-"), parent);
  const result = await fixture.store.putWidget({
    ...htmlWidget(parent, "legacy", "<p>Legacy</p>"),
    declared: { tools: ["health"] },
  });
  const widget = result.widgets[0]!;
  await fixture.store.grant(
    { sessionKey: parent },
    widget.name,
    "granted",
    widget.revision,
    widget.instanceId,
  );
  fixture.database.db
    .prepare(
      "UPDATE board_widgets SET manifest = json_remove(manifest, '$.componentId') WHERE session_key = ? AND name = ?",
    )
    .run(parent, widget.name);
  const before = await fixture.snapshot();
  const harness = createBoardHarness(undefined, {}, fixture.store);
  const reserved = await harness.invoke("board.widget.conversation", {
    sessionKey: parent,
    name: widget.name,
    instanceId: widget.instanceId,
  });
  expect(reserved.mock.calls[0]?.[0]).toBe(true);
  const identity = await fixture.store.ensureComponentIdentity(
    { sessionKey: parent },
    widget.name,
    widget.instanceId!,
  );
  expect(reserved.mock.calls[0]?.[1]).toMatchObject({ key: expect.stringContaining(identity.id) });
  expect(harness.broadcast).toHaveBeenCalledWith(
    "board.changed",
    expect.objectContaining({ widget: widget.name }),
    expect.anything(),
  );
  expect(
    await fixture.store.ensureComponentIdentity(
      { sessionKey: parent },
      widget.name,
      widget.instanceId!,
    ),
  ).toEqual(identity);
  expect(await fixture.snapshot()).toEqual({
    ...before,
    widgets: [{ ...before.widgets[0], componentId: identity.id }],
  });
  expect(await fixture.document(widget.name)).toMatchObject({ html: "<p>Legacy</p>" });
  await expect(
    fixture.store.ensureComponentIdentity({ sessionKey: parent }, widget.name, "old-frame"),
  ).rejects.toThrow("Component changed");
});
