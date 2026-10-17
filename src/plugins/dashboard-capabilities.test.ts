import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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
beforeEach(useNoBundledPlugins);

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

function writeCapabilityPlugin(
  id: string,
  kind: "dataBindings" | "actionVerbs",
  capabilityId: string,
  method: string,
  scope: "operator.read" | "operator.write" = kind === "dataBindings"
    ? "operator.read"
    : "operator.write",
  registeredMethod = method,
) {
  return writeDashboardPlugin(
    id,
    { [registeredMethod]: scope },
    {
      [kind]: [{ id: capabilityId, method, description: "Fixture capability" }],
    },
  );
}

function expectRejected(
  plugin: TempPlugin,
  message: string,
  surface: "boardWidgetContentKinds" | "dashboardDataBindings" | "dashboardActionVerbs",
  diagnostic = true,
) {
  const registry = loadFixture(plugin);
  expect(registry.plugins.find((entry) => entry.id === plugin.id)).toMatchObject({
    status: "error",
    failurePhase: "register",
    error: expect.stringContaining(message),
  });
  expect(registry[surface].size).toBe(0);
  if (diagnostic) {
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({ pluginId: plugin.id, code: "dashboard-declaration-invalid" }),
    );
  }
}

describe("plugin dashboard declarations", () => {
  it("publishes encoded private renderer paths through their capability", () => {
    const resourcePath = "/renderer/app.js?v=1#asset";
    const resolvedPath = "/renderer/app.js%3Fv=1%23asset";
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
    const plugin = writeWidgetPlugin({
      id: "invalid-widget-kind",
      kind: "html",
      surface: "canvas",
      resourcePath: "/__openclaw__/invalid/app.js",
    });

    expectRejected(plugin, 'kind "html" is invalid or reserved', "boardWidgetContentKinds");
  });

  it.each(["/mcp-app-sandbox", "/renderer/../app.js"])(
    "rejects an unservable public resource path %s",
    (resourcePath) => {
      const plugin = writeWidgetPlugin({
        id: "invalid-renderer-path",
        surface: "renderer",
        resourcePath,
        publicReader: true,
      });

      expectRejected(plugin, "resource path", "boardWidgetContentKinds", false);
    },
  );

  it.each([
    { firstPublic: false, secondPublic: true, sharedPath: true },
    { firstPublic: true, secondPublic: false, sharedPath: true },
    { firstPublic: false, secondPublic: false, sharedPath: true },
    { firstPublic: true, secondPublic: true, sharedPath: false },
  ])(
    "enforces resource path ownership (firstPublic=$firstPublic, secondPublic=$secondPublic, sharedPath=$sharedPath)",
    ({ firstPublic, secondPublic, sharedPath }) => {
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
    const plugin = writeCapabilityPlugin(
      "foreign",
      "dataBindings",
      "foreign",
      "sessions.list",
      "operator.read",
      "foreign.read",
    );
    expectRejected(plugin, "must be registered by the declaring plugin", "dashboardDataBindings");
  });

  it("rejects dashboard data bindings registered with the wrong scope", () => {
    const plugin = writeCapabilityPlugin(
      "wrong-scope",
      "dataBindings",
      "read",
      "wrong-scope.read",
      "operator.write",
    );
    expectRejected(plugin, "must use operator.read, got operator.write", "dashboardDataBindings");
  });

  it("rejects action verbs that collide with core data-binding grants", () => {
    const plugin = writeCapabilityPlugin("sessions", "actionVerbs", "list", "sessions.pluginWrite");
    expectRejected(
      plugin,
      'capability id "sessions.list" is reserved by core',
      "dashboardActionVerbs",
    );
  });

  it("keeps dotted plugin owners and literal escape markers distinct", () => {
    const dataPlugin = writeCapabilityPlugin(
      "dashboard",
      "dataBindings",
      "segmented.refresh",
      "dashboard.items",
    );
    const actionPlugin = writeCapabilityPlugin(
      "dashboard.segmented",
      "actionVerbs",
      "refresh",
      "dashboard.segmented.refresh",
    );
    const literalEscapePlugin = writeCapabilityPlugin(
      "dashboard%2Esegmented",
      "dataBindings",
      "refresh",
      "dashboard.literal-escape.items",
    );

    const registry = loadFixture(dataPlugin, actionPlugin, literalEscapePlugin);

    expect(registry.plugins.filter((entry) => entry.status === "loaded")).toHaveLength(3);
    expect(registry.dashboardDataBindings.has("dashboard.segmented.refresh")).toBe(true);
    expect(registry.dashboardActionVerbs.has("dashboard%2Esegmented.refresh")).toBe(true);
    expect(registry.dashboardDataBindings.has("dashboard%252Esegmented.refresh")).toBe(true);
  });

  it("publishes validated dashboard bindings and action verbs", () => {
    const plugin = writeDashboardPlugin(
      "valid",
      { "valid.items": "operator.read", "valid.refresh": "operator.write" },
      {
        dataBindings: [{ id: "items", method: "valid.items", description: "List items" }],
        actionVerbs: [
          {
            id: "refresh",
            method: "valid.refresh",
            description: "Refresh items",
            paramShape: { type: "object", additionalProperties: false },
          },
        ],
      },
    );

    const registry = loadFixture(plugin);
    expect(registry.plugins.find((entry) => entry.id === plugin.id)?.status).toBe("loaded");
    expect(registry.dashboardDataBindings.get("valid.items")).toMatchObject({
      pluginId: plugin.id,
      method: "valid.items",
    });
    expect(registry.dashboardActionVerbs.get("valid.refresh")).toMatchObject({
      pluginId: plugin.id,
      method: "valid.refresh",
    });
  });
});
