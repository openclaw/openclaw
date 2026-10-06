import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { resolveBoardWidgetContentKindResourceUrls } from "./board-widget-content-kinds.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
  type TempPlugin,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

function updateDashboardManifest(plugin: TempPlugin, dashboard: Record<string, unknown>): void {
  const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, dashboard }, null, 2), "utf8");
}

function loadFixture(...plugins: [TempPlugin, ...TempPlugin[]]) {
  return loadOpenClawPlugins({
    cache: false,
    workspaceDir: plugins[0].dir,
    config: {
      plugins: {
        load: { paths: plugins.map((plugin) => plugin.file) },
        allow: plugins.map((plugin) => plugin.id),
      },
    },
    onlyPluginIds: plugins.map((plugin) => plugin.id),
  });
}

function writeWidgetPlugin(params: {
  id: string;
  resourcePath: string;
  kind?: string;
  surface?: string;
  publicReader?: boolean;
}): TempPlugin {
  return writePlugin({
    id: params.id,
    registration: `api.registerBoardWidgetContentKind({
      kind: ${JSON.stringify(params.kind ?? "diagram")},
      label: "Diagram",
      resources: {
        surface: ${JSON.stringify(params.surface ?? "diagram")},
        paths: [${JSON.stringify(params.resourcePath)}],
        ${params.publicReader ? "async readPublicResource() { return undefined; }," : ""}
      },
      validateSource(source) { if (!source.trim()) throw new Error("source required"); },
      composeDocument({ source }) { return "<main>" + source + "</main>"; },
    });`,
  });
}

function writeDashboardPlugin(
  id: string,
  methods: Record<string, "operator.read" | "operator.write">,
  dashboard: Record<string, unknown>,
): TempPlugin {
  const plugin = writePlugin({
    id,
    filename: "dashboard.cjs",
    registration: Object.entries(methods)
      .map(
        ([method, scope]) => `api.registerGatewayMethod(
      ${JSON.stringify(method)},
      ({ respond }) => respond(true, { ok: true }),
      { scope: ${JSON.stringify(scope)} },
    );`,
      )
      .join("\n"),
  });
  updateDashboardManifest(plugin, dashboard);
  return plugin;
}

describe("plugin dashboard declarations", () => {
  it.each([
    ["/__openclaw__/diagram/app.js", "/__openclaw__/diagram/app.js"],
    ["/mcp-app-sandbox", "/mcp-app-sandbox"],
    ["/renderer/app.js?v=1#asset", "/renderer/app.js%3Fv=1%23asset"],
  ])("publishes private renderer path %s through its capability", (resourcePath, resolvedPath) => {
    useNoBundledPlugins();
    const plugin = writeWidgetPlugin({ id: "diagram", resourcePath });

    const registry = loadFixture(plugin);

    expect(registry.plugins.find((entry) => entry.id === plugin.id)?.status).toBe("loaded");
    expect(registry.boardWidgetContentKinds.get("diagram")).toMatchObject({
      pluginId: "diagram",
      pluginKind: "diagram:diagram",
      definition: { kind: "diagram", label: "Diagram" },
    });
    const registration = registry.boardWidgetContentKinds.get("diagram");
    expect(
      registration &&
        resolveBoardWidgetContentKindResourceUrls(
          registration,
          "https://gateway.test/__openclaw__/cap/token",
        ),
    ).toEqual({ [resourcePath]: `https://gateway.test/__openclaw__/cap/token${resolvedPath}` });
  });

  it("fails plugin load atomically for invalid board widget content kinds", () => {
    useNoBundledPlugins();
    const plugin = writeWidgetPlugin({
      id: "invalid-widget-kind",
      kind: "html",
      surface: "canvas",
      resourcePath: "/__openclaw__/invalid/app.js",
    });

    const registry = loadFixture(plugin);
    const record = registry.plugins.find((entry) => entry.id === plugin.id);

    expect(record).toMatchObject({ status: "error", failurePhase: "register" });
    expect(record?.error).toContain('kind "html" is invalid or reserved');
    expect(registry.boardWidgetContentKinds.size).toBe(0);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: plugin.id,
        code: "dashboard-declaration-invalid",
      }),
    );
  });

  it.each([
    "/mcp-app-sandbox",
    "/renderer/../app.js",
    "/renderer/%2e%2e/app.js",
    "/renderer/./app.js",
    "/renderer/app.js?v=1",
    "/renderer/app.js#v1",
    "/renderer\\app.js",
  ])("rejects an unservable public resource path %s", (resourcePath) => {
    useNoBundledPlugins();
    const plugin = writeWidgetPlugin({
      id: "invalid-renderer-path",
      surface: "renderer",
      resourcePath,
      publicReader: true,
    });

    const registry = loadFixture(plugin);
    const record = registry.plugins.find((entry) => entry.id === plugin.id);
    expect(record).toMatchObject({ status: "error", failurePhase: "register" });
    expect(record?.error).toContain("resource path");
    expect(registry.boardWidgetContentKinds.size).toBe(0);
  });

  it.each([
    { firstPublic: false, secondPublic: true, sharedPath: true },
    { firstPublic: true, secondPublic: false, sharedPath: true },
    { firstPublic: false, secondPublic: false, sharedPath: true },
    { firstPublic: true, secondPublic: true, sharedPath: false },
  ])(
    "enforces resource path ownership (firstPublic=$firstPublic, secondPublic=$secondPublic, sharedPath=$sharedPath)",
    ({ firstPublic, secondPublic, sharedPath }) => {
      useNoBundledPlugins();
      const createRenderer = (isPublic: boolean, kind: "first" | "second") => {
        const resourceName = kind === "first" || sharedPath ? "shared" : "other";
        return writeWidgetPlugin({
          id: `renderer-${kind}`,
          kind,
          surface: kind,
          resourcePath: `/__openclaw__/renderer/${resourceName}.js`,
          publicReader: isPublic,
        });
      };
      const firstPlugin = createRenderer(firstPublic, "first");
      const secondPlugin = createRenderer(secondPublic, "second");
      const registry = loadFixture(firstPlugin, secondPlugin);
      expect(registry.plugins.find((entry) => entry.id === firstPlugin.id)?.status).toBe("loaded");
      const second = registry.plugins.find((entry) => entry.id === secondPlugin.id);
      if (sharedPath && (firstPublic || secondPublic)) {
        expect(second).toMatchObject({ status: "error", failurePhase: "register" });
        expect(second?.error).toContain("public resource paths must be unique");
        expect([...registry.boardWidgetContentKinds.keys()]).toEqual(["first"]);
      } else {
        expect(second?.status).toBe("loaded");
        expect([...registry.boardWidgetContentKinds.keys()]).toEqual(["first", "second"]);
      }
    },
  );

  it("rejects gateway methods owned outside the declaring plugin", () => {
    useNoBundledPlugins();
    const plugin = writeDashboardPlugin(
      "dashboard-foreign-method",
      { "dashboard-foreign-method.read": "operator.read" },
      {
        dataBindings: [{ id: "foreign", method: "sessions.list", description: "Foreign method" }],
      },
    );

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
    const plugin = writeDashboardPlugin(
      "dashboard-wrong-scope",
      { "dashboard-wrong-scope.read": "operator.write" },
      {
        dataBindings: [
          {
            id: "read",
            method: "dashboard-wrong-scope.read",
            description: "Wrong-scope method",
          },
        ],
      },
    );

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
    const plugin = writeDashboardPlugin(
      "sessions",
      { "sessions.pluginWrite": "operator.write" },
      {
        actionVerbs: [
          {
            id: "list",
            method: "sessions.pluginWrite",
            description: "Colliding write action",
          },
        ],
      },
    );

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

  it("escapes plugin ids that would otherwise overlap dynamic cron grants", () => {
    useNoBundledPlugins();
    const plugin = writeDashboardPlugin(
      "cron.trigger:nightly",
      { "plugin.nightly.read": "operator.read" },
      {
        dataBindings: [
          {
            id: "run",
            method: "plugin.nightly.read",
            description: "Colliding cron binding",
          },
        ],
      },
    );

    const registry = loadFixture(plugin);
    const record = registry.plugins.find((entry) => entry.id === plugin.id);
    expect(record?.status).toBe("loaded");
    expect(registry.dashboardDataBindings.has("cron%2Etrigger:nightly.run")).toBe(true);
  });

  it("keeps dotted plugin owners and literal escape markers distinct", () => {
    useNoBundledPlugins();
    const dataPlugin = writeDashboardPlugin(
      "dashboard",
      { "dashboard.items": "operator.read" },
      {
        dataBindings: [
          {
            id: "segmented.refresh",
            method: "dashboard.items",
            description: "Read segmented items",
          },
        ],
      },
    );
    const actionPlugin = writeDashboardPlugin(
      "dashboard.segmented",
      { "dashboard.segmented.refresh": "operator.write" },
      {
        actionVerbs: [
          {
            id: "refresh",
            method: "dashboard.segmented.refresh",
            description: "Refresh segmented items",
          },
        ],
      },
    );
    const literalEscapePlugin = writeDashboardPlugin(
      "dashboard%2Esegmented",
      { "dashboard.literal-escape.items": "operator.read" },
      {
        dataBindings: [
          {
            id: "refresh",
            method: "dashboard.literal-escape.items",
            description: "Read literal-escape items",
          },
        ],
      },
    );

    const registry = loadFixture(dataPlugin, actionPlugin, literalEscapePlugin);

    expect(registry.plugins.filter((entry) => entry.status === "loaded")).toHaveLength(3);
    expect(registry.dashboardDataBindings.has("dashboard.segmented.refresh")).toBe(true);
    expect(registry.dashboardActionVerbs.has("dashboard%2Esegmented.refresh")).toBe(true);
    expect(registry.dashboardDataBindings.has("dashboard%252Esegmented.refresh")).toBe(true);
  });

  it("publishes validated dashboard bindings and action verbs", () => {
    useNoBundledPlugins();
    const plugin = writeDashboardPlugin(
      "dashboard-valid",
      { "dashboard-valid.items": "operator.read", "dashboard-valid.refresh": "operator.write" },
      {
        dataBindings: [{ id: "items", method: "dashboard-valid.items", description: "List items" }],
        actionVerbs: [
          {
            id: "refresh",
            method: "dashboard-valid.refresh",
            description: "Refresh items",
            paramShape: { type: "object", additionalProperties: false },
          },
        ],
      },
    );

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
