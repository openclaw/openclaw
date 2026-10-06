import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { readBoardRegistered } from "../../boards/board-store.test-support.js";
import { createPluginBoardWidgetContentKindRegistrar } from "../../plugins/board-widget-content-kinds.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withAuthorizedBoardWidgetView } from "../board-widget-view.js";
import { createBoardHarness } from "./board.test-support.js";

function registeredWidgetRegistry() {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "diagram",
    source: "diagram-fixture",
    origin: "bundled",
    enabled: true,
    configSchema: false,
  });
  const validateSource = vi.fn((source: string) => {
    if (!source.startsWith("diagram:")) {
      throw new Error("diagram prefix required");
    }
  });
  const composeDocument = vi.fn(
    ({
      source,
      resourceUrls,
    }: {
      source: string;
      resourceUrls: Readonly<Record<string, string>>;
    }) =>
      `<main>${source}</main><script src="${resourceUrls["/__openclaw__/diagram/app.js"]}"></script>`,
  );
  createPluginBoardWidgetContentKindRegistrar(registry)(record, {
    kind: "diagram",
    label: "Diagram",
    resources: {
      surface: "diagram",
      paths: ["/__openclaw__/diagram/app.js"],
    },
    validateSource,
    composeDocument,
  });
  registry.plugins.push(record);
  return { registry, validateSource, composeDocument };
}

afterEach(() => resetPluginRuntimeStateForTest());

function widgetHarness() {
  const plugin = registeredWidgetRegistry();
  setActivePluginRegistry(plugin.registry);
  const harness = createBoardHarness(
    undefined,
    {},
    undefined,
    {},
    {
      connect: {} as never,
      pluginSurfaceUrls: { diagram: "https://gateway.test/__openclaw__/cap/diagram-token" },
    },
  );
  const put = (source: string, declared?: { tools: string[] }) =>
    harness.invoke("board.widget.put", {
      sessionKey: "session",
      name: "status",
      content: { kind: "registered", contentKind: "diagram", source },
      ...(declared ? { declared } : {}),
    });
  return { ...harness, ...plugin, put };
}

describe("board registered widget content kinds", () => {
  it("validates, persists, composes, and updates registered source by name", async () => {
    const { context, invoke, store, put, validateSource, composeDocument } = widgetHarness();
    await put("diagram:first");
    const updated = await put("diagram:second");
    expect(validateSource).toHaveBeenCalledTimes(2);
    expect(updated.mock.calls[0]?.[1]).toMatchObject({
      widgets: [
        {
          name: "status",
          contentKind: "plugin",
          contentOwner: "registered",
          registeredContentKind: "diagram",
          pluginKind: "diagram:diagram",
          revision: 2,
        },
      ],
    });
    expect(
      await readBoardRegistered(store, { sessionKey: "session", agentId: "main" }, "status"),
    ).toMatchObject({ source: "diagram:second", pluginKind: "diagram:diagram", revision: 2 });
    const board = await invoke("board.get", { sessionKey: "session" });
    const widget = (board.mock.calls[0]![1] as BoardSnapshot).widgets[0]!;
    expect(widget).toMatchObject({
      contentOwner: "registered",
      registeredContentKind: "diagram",
      kindLabel: "Diagram",
      frameUrl: expect.stringContaining("/__openclaw__/board/"),
      sandboxUrl: expect.stringContaining("/mcp-app-sandbox"),
    });
    await withAuthorizedBoardWidgetView(
      store,
      widget.viewTicket!,
      (authorized) => {
        expect(authorized.document.html).toContain("<main>diagram:second</main>");
        expect(authorized.document.html).toContain(
          "https://gateway.test/__openclaw__/cap/diagram-token/__openclaw__/diagram/app.js",
        );
      },
      { gatewayContext: context },
    );
    expect(composeDocument).toHaveBeenCalledOnce();
  });

  it("returns an actionable error when the providing plugin is unavailable", async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const { invoke } = createBoardHarness();
    const response = await invoke("board.widget.put", {
      sessionKey: "session",
      name: "status",
      content: { kind: "registered", contentKind: "diagram", source: "diagram:first" },
    });
    expect(response.mock.calls[0]?.[0]).toBe(false);
    expect(response.mock.calls[0]?.[2]?.message).toContain(
      'widget kind "diagram" is unavailable; enable the plugin that provides it and retry',
    );
  });

  it("composes registered widget prompt actions after an explicit grant", async () => {
    const { context, invoke, store, put, composeDocument } = widgetHarness();
    const response = await put("diagram:prompt", { tools: ["prompt"] });
    const pending = (response.mock.calls[0]![1] as BoardSnapshot).widgets[0]!;
    expect(pending.grantState).toBe("pending");
    await invoke("board.widget.grant", {
      sessionKey: "session",
      name: "status",
      decision: "granted",
      revision: pending.revision,
      instanceId: pending.instanceId,
    });
    const board = await invoke("board.get", { sessionKey: "session" });
    const widget = (board.mock.calls[0]![1] as BoardSnapshot).widgets[0]!;
    await withAuthorizedBoardWidgetView(store, widget.viewTicket!, () => {}, {
      gatewayContext: context,
    });
    expect(composeDocument).toHaveBeenCalledWith(expect.objectContaining({ promptGranted: true }));
  });
});
