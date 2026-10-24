import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
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
  surface: "dashboardDataBindings" | "dashboardActionVerbs",
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
