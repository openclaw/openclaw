import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  type TempPlugin,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { loadPluginManifest } from "./manifest.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

function updateDashboardManifest(plugin: TempPlugin, dashboard: Record<string, unknown>): void {
  const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, dashboard }, null, 2), "utf8");
}

function loadFixture(plugin: TempPlugin) {
  return loadOpenClawPlugins({
    cache: false,
    workspaceDir: plugin.dir,
    config: {
      plugins: {
        load: { paths: [plugin.file] },
        allow: [plugin.id],
      },
    },
    onlyPluginIds: [plugin.id],
  });
}

describe("plugin dashboard declarations", () => {
  it("loads the Workboard bindings and dispatch action from its manifest", () => {
    const result = loadPluginManifest(path.join(process.cwd(), "extensions", "workboard"));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.dashboard).toEqual({
      dataBindings: [
        {
          id: "cards.list",
          method: "workboard.cards.list",
          description: "List Workboard cards and statuses.",
        },
        {
          id: "stats",
          method: "workboard.cards.stats",
          description: "Read Workboard card statistics.",
        },
        {
          id: "boards.list",
          method: "workboard.boards.list",
          description: "List Workboard boards.",
        },
      ],
      actionVerbs: [
        {
          id: "dispatch",
          method: "workboard.cards.dispatch",
          description: "Dispatch ready Workboard cards.",
          paramShape: {
            type: "object",
            additionalProperties: false,
            properties: { boardId: { type: "string", minLength: 1 } },
          },
        },
      ],
    });
  });

  it("rejects gateway methods owned outside the declaring plugin", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "dashboard-foreign-method",
      body: `module.exports = {
        id: "dashboard-foreign-method",
        register(api) {
          api.registerGatewayMethod(
            "dashboard-foreign-method.read",
            ({ respond }) => respond(true, { ok: true }),
            { scope: "operator.read" },
          );
        },
      };`,
    });
    updateDashboardManifest(plugin, {
      dataBindings: [{ id: "foreign", method: "sessions.list", description: "Foreign method" }],
    });

    const registry = loadFixture(plugin);
    const record = registry.plugins.find((entry) => entry.id === plugin.id);
    expect(record).toMatchObject({ status: "error", failurePhase: "register" });
    expect(record?.error).toContain("must be registered by the declaring plugin");
    expect(registry.dashboardDataBindings.size).toBe(0);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.id,
        code: "dashboard-declaration-invalid",
      }),
    );
  });

  it("rejects dashboard data bindings registered with the wrong scope", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "dashboard-wrong-scope",
      body: `module.exports = {
        id: "dashboard-wrong-scope",
        register(api) {
          api.registerGatewayMethod(
            "dashboard-wrong-scope.read",
            ({ respond }) => respond(true, { ok: true }),
            { scope: "operator.write" },
          );
        },
      };`,
    });
    updateDashboardManifest(plugin, {
      dataBindings: [
        {
          id: "read",
          method: "dashboard-wrong-scope.read",
          description: "Wrong-scope method",
        },
      ],
    });

    const registry = loadFixture(plugin);
    const record = registry.plugins.find((entry) => entry.id === plugin.id);
    expect(record).toMatchObject({ status: "error", failurePhase: "register" });
    expect(record?.error).toContain("must use operator.read, got operator.write");
    expect(registry.dashboardDataBindings.size).toBe(0);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.id,
        code: "dashboard-declaration-invalid",
      }),
    );
  });

  it("rejects action verbs that collide with core data-binding grants", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "sessions",
      body: `module.exports = {
        id: "sessions",
        register(api) {
          api.registerGatewayMethod(
            "sessions.pluginWrite",
            ({ respond }) => respond(true, { ok: true }),
            { scope: "operator.write" },
          );
        },
      };`,
    });
    updateDashboardManifest(plugin, {
      actionVerbs: [
        {
          id: "list",
          method: "sessions.pluginWrite",
          description: "Colliding write action",
        },
      ],
    });

    const registry = loadFixture(plugin);
    const record = registry.plugins.find((entry) => entry.id === plugin.id);
    expect(record).toMatchObject({ status: "error", failurePhase: "register" });
    expect(record?.error).toContain('capability id "sessions.list" is reserved by core');
    expect(registry.dashboardActionVerbs.size).toBe(0);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.id,
        code: "dashboard-declaration-invalid",
      }),
    );
  });

  it("rejects data bindings that collide with dynamic cron grants", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cron.trigger:nightly",
      filename: "cron-trigger-nightly.cjs",
      body: `module.exports = {
        id: "cron.trigger:nightly",
        register(api) {
          api.registerGatewayMethod(
            "plugin.nightly.read",
            ({ respond }) => respond(true, { ok: true }),
            { scope: "operator.read" },
          );
        },
      };`,
    });
    updateDashboardManifest(plugin, {
      dataBindings: [
        {
          id: "run",
          method: "plugin.nightly.read",
          description: "Colliding cron binding",
        },
      ],
    });

    const registry = loadFixture(plugin);
    const record = registry.plugins.find((entry) => entry.id === plugin.id);
    expect(record).toMatchObject({ status: "error", failurePhase: "register" });
    expect(record?.error).toContain('capability id "cron.trigger:nightly.run" is reserved by core');
    expect(registry.dashboardDataBindings.size).toBe(0);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.id,
        code: "dashboard-declaration-invalid",
      }),
    );
  });

  it("publishes validated dashboard bindings and action verbs", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "dashboard-valid",
      body: `module.exports = {
        id: "dashboard-valid",
        register(api) {
          api.registerGatewayMethod(
            "dashboard-valid.items",
            ({ respond }) => respond(true, { items: [] }),
            { scope: "operator.read" },
          );
          api.registerGatewayMethod(
            "dashboard-valid.refresh",
            ({ respond }) => respond(true, { ok: true }),
            { scope: "operator.write" },
          );
        },
      };`,
    });
    updateDashboardManifest(plugin, {
      dataBindings: [{ id: "items", method: "dashboard-valid.items", description: "List items" }],
      actionVerbs: [
        {
          id: "refresh",
          method: "dashboard-valid.refresh",
          description: "Refresh items",
          paramShape: { type: "object", additionalProperties: false },
        },
      ],
    });

    const registry = loadFixture(plugin);
    expect(registry.plugins.find((entry) => entry.id === plugin.id)?.status).toBe("loaded");
    expect(registry.dashboardDataBindings.get("dashboard-valid.items")).toMatchObject({
      pluginId: plugin.id,
      method: "dashboard-valid.items",
    });
    expect(registry.dashboardActionVerbs.get("dashboard-valid.refresh")).toMatchObject({
      pluginId: plugin.id,
      method: "dashboard-valid.refresh",
    });
  });
});
