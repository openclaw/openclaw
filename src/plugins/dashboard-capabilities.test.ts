import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
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

type Capability = readonly [
  kind: "dataBindings" | "actionVerbs",
  id: string,
  method: string,
  options?: {
    scope?: "operator.read" | "operator.write";
    registeredMethod?: string;
  },
];

function writeDashboardPlugin(id: string, ...capabilities: Capability[]): TempPlugin {
  const dashboard: Record<string, object[]> = {};
  const registrations = capabilities.map(([kind, capabilityId, method, options = {}]) => {
    (dashboard[kind] ??= []).push({
      id: capabilityId,
      method,
      description: "Fixture capability",
    });
    const scope = options.scope ?? (kind === "dataBindings" ? "operator.read" : "operator.write");
    return `api.registerGatewayMethod(${JSON.stringify(options.registeredMethod ?? method)},
      ({ respond }) => respond(true, { ok: true }), { scope: ${JSON.stringify(scope)} });`;
  });
  const plugin = writePlugin({
    id,
    filename: "dashboard.cjs",
    registration: registrations.join("\n"),
  });
  const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, dashboard }), "utf8");
  return plugin;
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

it.each([
  [
    "foreign",
    ["dataBindings", "foreign", "sessions.list", { registeredMethod: "foreign.read" }],
    "must be registered by the declaring plugin",
  ],
  [
    "wrong-scope",
    ["dataBindings", "read", "wrong-scope.read", { scope: "operator.write" }],
    "must use operator.read, got operator.write",
  ],
  [
    "sessions",
    ["actionVerbs", "list", "sessions.pluginWrite"],
    'capability id "sessions.list" is reserved by core',
  ],
] satisfies Array<[string, Capability, string]>)(
  "rejects invalid %s declarations",
  (id, capability, message) => {
    expectRejected(
      writeDashboardPlugin(id, capability),
      message,
      capability[0] === "dataBindings" ? "dashboardDataBindings" : "dashboardActionVerbs",
    );
  },
);

it("keeps dotted plugin owners and literal escape markers distinct", () => {
  const dataPlugin = writeDashboardPlugin("a", ["dataBindings", "b.c", "a.read"]);
  const actionPlugin = writeDashboardPlugin("a.b", ["actionVerbs", "c", "b.write"]);
  const literalEscapePlugin = writeDashboardPlugin("a%2Eb", ["dataBindings", "c", "literal.read"]);

  const registry = loadFixture(dataPlugin, actionPlugin, literalEscapePlugin);

  expect(registry.plugins.filter((entry) => entry.status === "loaded")).toHaveLength(3);
  expect(registry.dashboardDataBindings.get("a.b.c")).toMatchObject({
    pluginId: "a",
    method: "a.read",
  });
  expect(registry.dashboardActionVerbs.get("a%2Eb.c")).toMatchObject({
    pluginId: "a.b",
    method: "b.write",
  });
  expect(registry.dashboardDataBindings.has("a%252Eb.c")).toBe(true);
});
