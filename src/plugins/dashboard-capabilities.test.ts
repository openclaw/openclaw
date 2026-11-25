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
  const ids = plugins.map((plugin) => plugin.id);
  return loadOpenClawPlugins({
    cache: false,
    workspaceDir: plugins[0].dir,
    config: {
      plugins: { load: { paths: plugins.map((plugin) => plugin.file) }, allow: ids },
    },
    onlyPluginIds: ids,
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

function writeDashboardPlugin(id: string, [kind, capabilityId, method, options = {}]: Capability) {
  const dashboard = { [kind]: [{ id: capabilityId, method, description: "Fixture capability" }] };
  const scope = options.scope ?? (kind === "dataBindings" ? "operator.read" : "operator.write");
  const plugin = writePlugin({
    id,
    filename: "dashboard.cjs",
    registration: `api.registerGatewayMethod(${JSON.stringify(options.registeredMethod ?? method)},
      ({ respond }) => respond(true, { ok: true }), { scope: ${JSON.stringify(scope)} });`,
  });
  const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, dashboard }), "utf8");
  return plugin;
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
    const registry = loadFixture(writeDashboardPlugin(id, capability));
    expect(registry.plugins.find((entry) => entry.id === id)).toMatchObject({
      status: "error",
      failurePhase: "register",
      error: expect.stringContaining(message),
    });
    const surface =
      capability[0] === "dataBindings" ? "dashboardDataBindings" : "dashboardActionVerbs";
    expect(registry[surface].size).toBe(0);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({ pluginId: id, code: "dashboard-declaration-invalid" }),
    );
  },
);

it("keeps dotted plugin owners and literal escape markers distinct", () => {
  const registry = loadFixture(
    writeDashboardPlugin("a", ["dataBindings", "b.c", "a.read"]),
    writeDashboardPlugin("a.b", ["actionVerbs", "c", "b.write"]),
    writeDashboardPlugin("a%2Eb", ["dataBindings", "c", "literal.read"]),
  );

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
