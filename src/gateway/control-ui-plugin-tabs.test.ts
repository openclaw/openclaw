import { Value } from "typebox/value";
import { afterEach, expect, it } from "vitest";
import { HelloOkSchema } from "../../packages/gateway-protocol/src/schema/frames.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { PluginControlUiDescriptor } from "../plugins/host-hooks.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  listControlUiPluginDescriptors,
  listControlUiPluginTabAuthGrants,
  listControlUiPluginTabs,
  listControlUiPluginWidgetKinds,
} from "./control-ui-plugin-tabs.js";

function tab(pluginId: string, overrides: Partial<PluginControlUiDescriptor> = {}) {
  const descriptor: PluginControlUiDescriptor = {
    id: "logbook",
    surface: "tab",
    label: "Logbook",
    ...overrides,
  };
  return { pluginId, descriptor };
}

function grant(pluginId: string, path = `/plugins/${pluginId}`, match = "prefix") {
  return { pluginId, path, match, scopes: ["operator.read"] };
}

function activateDescriptors(
  entries: Array<{ pluginId: string; descriptor: PluginControlUiDescriptor }>,
  routes: Array<{
    pluginId: string;
    path: string;
    auth?: "gateway" | "plugin";
    match?: "exact" | "prefix";
  }> = [],
) {
  const registry = createTestRegistry([]);
  registry.controlUiDescriptors = entries.map((entry) => ({
    ...entry,
    source: `test:${entry.pluginId}`,
  }));
  registry.httpRoutes = routes.map((route) => ({
    ...route,
    auth: route.auth ?? "gateway",
    match: route.match ?? "prefix",
    source: `test:${route.pluginId}`,
    handler: async () => true,
  }));
  setActivePluginRegistry(registry);
  return registry;
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createTestRegistry([]));
});

it("advertises a tab slug in the hello contract without altering its frame path", () => {
  activateDescriptors([
    tab("reports-fixture", { slug: "reports", path: "/plugins/reports-fixture" }),
  ]);
  const tabs = listControlUiPluginTabs(["operator.read"]);
  expect(tabs).toEqual([
    expect.objectContaining({ slug: "reports", path: "/plugins/reports-fixture" }),
  ]);
  expect(Value.Check(HelloOkSchema.properties.controlUiTabs, tabs)).toBe(true);
});

it.each([
  { basePath: "", path: "/reports", match: "exact" as const, auth: "gateway" as const },
  { basePath: "/team", path: "/team", match: "prefix" as const, auth: "gateway" as const },
])(
  "drops a slug shadowed by $auth $match route $path under $basePath once",
  ({ basePath, ...route }) => {
    setRuntimeConfigSnapshot({ gateway: { controlUi: { basePath } } });
    const registry = activateDescriptors([
      tab("reports-fixture", { slug: "reports", path: "/plugins/reports-fixture" }),
    ]);
    // HTTP registration after the descriptor must produce the same projection.
    registry.httpRoutes.push({
      ...route,
      pluginId: "other",
      source: "test:other",
      handler: async () => true,
    });
    for (let connect = 0; connect < 2; connect += 1) {
      const [projected] = listControlUiPluginTabs(["operator.read"]);
      expect(projected).toMatchObject({
        pluginId: "reports-fixture",
        path: "/plugins/reports-fixture",
      });
      expect(projected).not.toHaveProperty("slug");
    }
    expect(registry.diagnostics).toEqual([
      expect.objectContaining({
        level: "warn",
        pluginId: "reports-fixture",
        message: expect.stringContaining("shadowed by plugin HTTP route"),
      }),
    ]);
    expect(registry.controlUiDescriptors[0]?.descriptor.slug).toBe("reports");
  },
);

it("projects only tab descriptors", () => {
  activateDescriptors([
    tab("workboard", { placement: "route:workboard" }),
    tab("other", { id: "run-panel", surface: "run" }),
  ]);

  const tabs = listControlUiPluginTabs(["operator.admin"]);
  expect(tabs).toMatchObject([
    { id: "logbook", placement: "route:workboard", pluginId: "workboard" },
  ]);
});

it("hides tabs whose required scopes are not granted", () => {
  activateDescriptors([
    tab("logbook", { requiredScopes: ["operator.write"] }),
    tab("adminy", { id: "adminy", label: "Admin", requiredScopes: ["operator.admin"] }),
  ]);

  expect(listControlUiPluginTabs(["operator.read"])).toEqual([]);
  expect(listControlUiPluginDescriptors(["operator.read"])).toEqual([]);
  expect(listControlUiPluginTabs(["operator.write"]).map((row) => row.id)).toEqual(["logbook"]);
  expect(listControlUiPluginDescriptors(["operator.write"]).map((entry) => entry.id)).toEqual([
    "logbook",
  ]);
  expect(listControlUiPluginTabs(["operator.admin"]).map((row) => row.id)).toEqual([
    "adminy",
    "logbook",
  ]);
});

it("orders deterministically by order, label, then id", () => {
  activateDescriptors([
    tab("b", { id: "beta", label: "Beta" }),
    tab("a", { id: "alpha", label: "Alpha", order: 5 }),
    tab("c", { id: "zed", label: "Beta" }),
  ]);

  expect(listControlUiPluginTabs([]).map((row) => row.id)).toEqual(["beta", "zed", "alpha"]);
  expect(listControlUiPluginDescriptors([]).map((entry) => entry.pluginId)).toEqual([
    "a",
    "b",
    "c",
  ]);
});

it("merges the read-scoped core kind into deterministic plugin ordering", () => {
  activateDescriptors(
    [
      ["card", "Workboard card"],
      ["mini", "Workboard summary"],
    ].map(([id, label]) =>
      tab("workboard", { id, label, surface: "widget", requiredScopes: ["operator.read"] }),
    ),
  );

  expect(listControlUiPluginWidgetKinds([])).toEqual([]);
  expect(listControlUiPluginWidgetKinds(["operator.read"])).toEqual([
    { pluginId: "session", kind: "session:report", label: "Report" },
    { pluginId: "session", kind: "session:progress", label: "Session progress" },
    { pluginId: "session", kind: "session:website", label: "Website" },
    { pluginId: "workboard", kind: "workboard:card", label: "Workboard card" },
    { pluginId: "workboard", kind: "workboard:mini", label: "Workboard summary" },
  ]);
});

it("grants only same-plugin gateway routes with least-privilege scopes", () => {
  activateDescriptors(
    [
      tab("logbook", { path: "/plugins/logbook/panel" }),
      tab("adminy", {
        id: "adminy",
        path: "/plugins/adminy/panel",
        requiredScopes: ["operator.admin"],
      }),
      tab("publicish", { id: "publicish", path: "/plugins/publicish/panel" }),
    ],
    [
      { pluginId: "logbook", path: "/plugins/logbook", match: "prefix" },
      { pluginId: "adminy", path: "/plugins/adminy", match: "prefix" },
      {
        pluginId: "publicish",
        path: "/plugins/publicish",
        auth: "plugin",
        match: "prefix",
      },
    ],
  );

  expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
    grant("adminy"),
    grant("logbook"),
  ]);
  const adminTabs = listControlUiPluginTabs(["operator.admin"]);
  expect(adminTabs).toEqual([
    expect.objectContaining({ pluginId: "adminy", requiresGatewayAuth: true }),
    expect.objectContaining({ pluginId: "logbook", requiresGatewayAuth: true }),
    expect.objectContaining({ pluginId: "publicish" }),
  ]);
  expect(adminTabs[2]).not.toHaveProperty("requiresGatewayAuth");
  expect(listControlUiPluginTabAuthGrants(["operator.read"])).toEqual([grant("logbook")]);
});

it("uses the first dispatched gateway route as descriptor owner", () => {
  activateDescriptors(
    [tab("outer", { path: "/shared/panel" })],
    [
      { pluginId: "nested", path: "/shared/panel", match: "exact" },
      { pluginId: "outer", path: "/shared", match: "prefix" },
    ],
  );

  expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([]);
  expect(listControlUiPluginTabs(["operator.admin"])).toEqual([]);
});

it("does not require a cookie grant when gateway auth is disabled", () => {
  activateDescriptors(
    [tab("logbook", { path: "/plugins/logbook/panel" })],
    [{ pluginId: "logbook", path: "/plugins/logbook", match: "prefix" }],
  );

  const [projected] = listControlUiPluginTabs(["operator.admin"], {
    requireGatewayAuthGrant: false,
  });
  expect(projected).toMatchObject({ pluginId: "logbook" });
  expect(projected).not.toHaveProperty("requiresGatewayAuth");
});

it("coalesces same-plugin tabs that share one read-only cookie path", () => {
  activateDescriptors(
    [
      tab("logbook", { path: "/plugins/logbook/read" }),
      tab("logbook", {
        id: "admin",
        path: "/plugins/logbook/admin",
        requiredScopes: ["operator.admin"],
      }),
    ],
    [{ pluginId: "logbook", path: "/plugins/logbook", match: "prefix" }],
  );

  expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([grant("logbook")]);
});

it("widens a shared exact cookie path when another visible tab needs prefix matching", () => {
  activateDescriptors(
    [
      tab("logbook", { path: "/plugins/logbook" }),
      tab("logbook", { id: "child", path: "/plugins/logbook/child" }),
    ],
    [
      { pluginId: "logbook", path: "/plugins/logbook", match: "exact" },
      { pluginId: "logbook", path: "/plugins/logbook", match: "prefix" },
    ],
  );

  expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([grant("logbook")]);
});

it("keeps separate grants for different plugins that share a cookie path", () => {
  activateDescriptors(
    [
      tab("alpha", { id: "alpha", path: "/shared" }),
      tab("beta", { id: "beta", path: "/shared/child" }),
    ],
    [
      { pluginId: "alpha", path: "/shared", match: "exact" },
      { pluginId: "beta", path: "/shared", match: "prefix" },
    ],
  );

  expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
    grant("alpha", "/shared", "exact"),
    grant("beta", "/shared"),
  ]);
  expect(listControlUiPluginTabs(["operator.admin"]).map((row) => row.pluginId)).toEqual([
    "alpha",
    "beta",
  ]);
});
