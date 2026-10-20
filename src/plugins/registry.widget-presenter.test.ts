import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { WidgetPresenter } from "./plugin-registration.types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-fixtures.js";
import {
  adoptRuntimeWidgetPresenterRegistrations,
  resolveWidgetPresenters,
} from "./widget-presenters.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

function currentPresenter(
  description: string,
  match: Extract<WidgetPresenter, { target: "current_channel" }>["match"] = () => true,
): WidgetPresenter {
  return {
    target: "current_channel",
    description,
    capabilities: { sourceKinds: ["html"] },
    match,
    availability: async () => ({ ok: true, value: { available: true } }),
    present: async () => ({
      ok: false,
      error: { code: "unavailable", message: "not used" },
    }),
  };
}

function fixture() {
  const { config, registry } = createPluginRegistryFixture();
  const register = (id: string, presenter: WidgetPresenter) =>
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id }),
      register: (api) => api.registerWidgetPresenter(presenter),
    });
  return { registry: registry.registry, register };
}

describe("plugin widget presenter registry", () => {
  it("registers one presenter for a target and rejects a competing owner", async () => {
    const { registry, register } = fixture();
    const presenter: WidgetPresenter = {
      target: "node_panel",
      description: "Show on a connected device panel",
      availability: async () => ({ ok: true, value: { available: true } }),
      present: async () => ({
        ok: false,
        error: { code: "no_eligible_node", message: "none" },
      }),
    };
    register("first-presenter", presenter);
    register("second-presenter", presenter);

    expect(registry.widgetPresenters).toHaveLength(1);
    const selected = registry.widgetPresenters[0]!;
    expect(selected).toMatchObject({
      pluginId: "first-presenter",
      presenter: { target: "node_panel", description: "Show on a connected device panel" },
    });
    await expect(selected.presenter.availability({})).resolves.toEqual({
      ok: true,
      value: { available: true },
    });
    await expect(
      selected.presenter.present({
        context: {},
        document: { kind: "html", html: "<p>Panel</p>" },
        title: "Panel",
      }),
    ).resolves.toEqual({ ok: false, error: { code: "no_eligible_node", message: "none" } });
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: "second-presenter",
        message: "widget presenter already registered for node_panel (first-presenter)",
      }),
    );
  });

  it("allows multiple contextual presenters while keeping explicit targets unique", () => {
    const { registry, register } = fixture();
    for (const id of ["discord-presenter", "slack-presenter"]) {
      register(
        id,
        currentPresenter(
          `Present through ${id}`,
          (context) => context.messageChannel === id.split("-")[0],
        ),
      );
    }

    expect(registry.widgetPresenters.map(({ pluginId }) => pluginId)).toEqual([
      "discord-presenter",
      "slack-presenter",
    ]);
    expect(registry.diagnostics).toEqual([]);
  });

  it("adopts full-only presenters only from the matching lifecycle owner", () => {
    const source = "/tmp/discord/index.ts";
    const target = createEmptyPluginRegistry();
    const runtime = createEmptyPluginRegistry();
    target.plugins.push(createPluginRecord({ id: "discord", source }));
    runtime.plugins.push(createPluginRecord({ id: "discord", source }));
    runtime.widgetPresenters.push({
      pluginId: "discord",
      presenter: currentPresenter("Runtime Discord"),
      source,
    });

    const adopted = adoptRuntimeWidgetPresenterRegistrations(target, runtime);
    expect(adopted.widgetPresenters).toEqual(runtime.widgetPresenters);

    target.plugins[0] = createPluginRecord({ id: "discord", source: "/tmp/other/index.ts" });
    expect(adoptRuntimeWidgetPresenterRegistrations(target, runtime)).toBe(target);
  });

  it("keeps request-scoped presenters ahead of the active lifecycle registry", () => {
    const active = createEmptyPluginRegistry();
    const scoped = createEmptyPluginRegistry();
    for (const [registry, pluginId, description] of [
      [active, "active", "Active"],
      [scoped, "scoped", "Scoped"],
    ] as const) {
      registry.widgetPresenters.push({
        pluginId,
        presenter: currentPresenter(description),
        source: `/tmp/${pluginId}/index.ts`,
      });
    }
    setActivePluginRegistry(active);

    expect(
      withPluginRuntimeRegistryScope(scoped, () =>
        resolveWidgetPresenters().map(({ pluginId }) => pluginId),
      ),
    ).toEqual(["scoped"]);
  });
});
