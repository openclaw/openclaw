import { afterEach, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { listControlUiPluginWidgetKinds } from "./control-ui-plugin-tabs.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createTestRegistry([]));
});

it("projects session-writer widgets for broad and narrow write scopes only", () => {
  const registry = createTestRegistry([]);
  registry.controlUiDescriptors = [
    {
      pluginId: "session-widget-fixture",
      source: "test:session-widget",
      descriptor: {
        id: "preview",
        surface: "widget",
        label: "Preview",
        requiredScopes: ["operator.sessions.write"],
      },
    },
  ];
  setActivePluginRegistry(registry);

  for (const scope of ["operator.admin", "operator.write", "operator.sessions.write"]) {
    expect(
      listControlUiPluginWidgetKinds([scope]).filter(
        (widget) => widget.pluginId === "session-widget-fixture",
      ),
    ).toEqual([
      {
        pluginId: "session-widget-fixture",
        kind: "session-widget-fixture:preview",
        label: "Preview",
      },
    ]);
  }
  for (const scopes of [[], ["operator.read"], ["operator.sessions.read"]]) {
    expect(
      listControlUiPluginWidgetKinds(scopes).filter(
        (widget) => widget.pluginId === "session-widget-fixture",
      ),
    ).toEqual([]);
  }
});
