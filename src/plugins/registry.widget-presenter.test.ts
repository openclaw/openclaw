import { afterEach, describe, expect, it } from "vitest";
import type { WidgetPresenter } from "./plugin-registration.types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { expectDiagnostic, registrationFixture } from "./registry-registration.test-support.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-fixtures.js";
import {
  adoptRuntimeWidgetPresenterRegistrations,
  resolveWidgetPresenters,
} from "./widget-presenters.js";

afterEach(resetPluginRuntimeStateForTest);

function currentPresenter(
  description: string,
): Extract<WidgetPresenter, { target: "current_channel" }> {
  return {
    target: "current_channel",
    description,
    capabilities: { sourceKinds: ["html"] },
    match: () => true,
    availability: async () => ({ ok: true, value: { available: true } }),
    present: async () => ({ ok: false, error: { code: "unavailable", message: "not used" } }),
  };
}
function presenterRegistry(pluginId: string, description: string) {
  const registry = createEmptyPluginRegistry();
  registry.widgetPresenters.push({
    pluginId,
    presenter: currentPresenter(description),
    source: `/tmp/${pluginId}/index.ts`,
  });
  return registry;
}

describe("plugin widget presenter registry", () => {
  it.each(["node_panel", "current_channel"] as const)(
    "enforces %s target ownership",
    async (target) => {
      const { registry, register } = registrationFixture();
      const panel: WidgetPresenter = {
        target: "node_panel",
        description: "Show on a connected device panel",
        availability: async () => ({ ok: true, value: { available: true } }),
        present: async () => ({ ok: false, error: { code: "no_eligible_node", message: "none" } }),
      };
      const ids =
        target === "node_panel"
          ? ["first-presenter", "second-presenter"]
          : ["discord-presenter", "slack-presenter"];
      for (const id of ids) {
        const presenter =
          target === "node_panel"
            ? panel
            : {
                ...currentPresenter(`Present through ${id}`),
                match: (context: Parameters<WidgetPresenter["availability"]>[0]) =>
                  context.messageChannel === id.split("-")[0],
              };
        register({ id }, (api) => api.registerWidgetPresenter(presenter));
      }
      if (target === "current_channel") {
        expect(registry.widgetPresenters.map(({ pluginId }) => pluginId)).toEqual(ids);
        expect(registry.diagnostics).toEqual([]);
      } else {
        expect(registry.widgetPresenters).toMatchObject([
          {
            pluginId: "first-presenter",
            presenter: { target, description: "Show on a connected device panel" },
          },
        ]);
        const selected = registry.widgetPresenters[0]!.presenter;
        await expect(selected.availability({})).resolves.toEqual({
          ok: true,
          value: { available: true },
        });
        await expect(
          selected.present({
            context: {},
            document: { kind: "html", html: "<p>Panel</p>" },
            title: "Panel",
          }),
        ).resolves.toEqual({ ok: false, error: { code: "no_eligible_node", message: "none" } });
        expectDiagnostic(registry, {
          pluginId: "second-presenter",
          message: "widget presenter already registered for node_panel (first-presenter)",
        });
      }
    },
  );

  it("adopts full-only presenters only from the matching lifecycle owner", () => {
    const runtime = presenterRegistry("discord", "Runtime Discord");
    const target = createEmptyPluginRegistry();
    const source = "/tmp/discord/index.ts";
    target.plugins.push(createPluginRecord({ id: "discord", source }));
    runtime.plugins.push(createPluginRecord({ id: "discord", source }));
    expect(adoptRuntimeWidgetPresenterRegistrations(target, runtime).widgetPresenters).toEqual(
      runtime.widgetPresenters,
    );
    target.plugins[0] = createPluginRecord({ id: "discord", source: "/tmp/other/index.ts" });
    expect(adoptRuntimeWidgetPresenterRegistrations(target, runtime)).toBe(target);
  });

  it("keeps request-scoped presenters ahead of the active lifecycle registry", () => {
    setActivePluginRegistry(presenterRegistry("active", "Active"));
    const scoped = presenterRegistry("scoped", "Scoped");
    expect(
      withPluginRuntimeRegistryScope(scoped, () =>
        resolveWidgetPresenters().map(({ pluginId }) => pluginId),
      ),
    ).toEqual(["scoped"]);
  });
});
