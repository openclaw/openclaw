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

function tab(
  pluginId: string,
  overrides: Partial<PluginControlUiDescriptor & { surface: "tab" | "run" | "widget" }> = {},
) {
  return {
    pluginId,
    descriptor: { id: "logbook", surface: "tab" as const, label: "Logbook", ...overrides },
  };
}

function grant(pluginId: string, path = `/plugins/${pluginId}`, match = "prefix") {
  return { pluginId, path, match, scopes: ["operator.read"] };
}

function route(
  pluginId: string,
  path = `/plugins/${pluginId}`,
  match: "exact" | "prefix" = "prefix",
  auth: "gateway" | "plugin" = "gateway",
) {
  return { pluginId, path, match, auth };
}

function activateDescriptors(
  entries: Array<{ pluginId: string; descriptor: PluginControlUiDescriptor }>,
  routes: ReturnType<typeof route>[] = [],
) {
  const registry = createTestRegistry([]);
  registry.controlUiDescriptors = entries.map((entry) => ({
    ...entry,
    source: `test:${entry.pluginId}`,
  }));
  registry.httpRoutes = routes.map((entry) => ({
    ...entry,
    source: `test:${entry.pluginId}`,
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

it.each([
  ["", undefined, "exact"],
  ["", "/reports", "exact"],
  ["/team", "/team", "prefix"],
] as const)("projects hello slugs under %s with route %s (%s)", (basePath, path, match) => {
  setRuntimeConfigSnapshot({ gateway: { controlUi: { basePath } } });
  const registry = activateDescriptors([
    tab("reports-fixture", { slug: "reports", path: "/plugins/reports-fixture" }),
  ]);
  // HTTP registration after the descriptor must produce the same projection.
  if (path) {
    registry.httpRoutes.push({
      ...route("other", path, match),
      source: "test:other",
      handler: async () => true,
    });
  }
  for (let connect = 0; connect < 2; connect += 1) {
    const tabs = listControlUiPluginTabs(["operator.read"]);
    expect(Value.Check(HelloOkSchema.properties.controlUiTabs, tabs)).toBe(true);
    expect(tabs).toMatchObject([
      {
        pluginId: "reports-fixture",
        path: "/plugins/reports-fixture",
      },
    ]);
    if (path) {
      expect(tabs[0]).not.toHaveProperty("slug");
    } else {
      expect(tabs[0]).toHaveProperty("slug", "reports");
    }
  }
  expect(registry.diagnostics.map(({ level, pluginId }) => ({ level, pluginId }))).toEqual(
    path ? [{ level: "warn", pluginId: "reports-fixture" }] : [],
  );
  expect(registry.controlUiDescriptors[0]?.descriptor.slug).toBe("reports");
});

it("hides tabs whose required scopes are not granted", () => {
  activateDescriptors([
    tab("logbook", { requiredScopes: ["operator.write"] }),
    tab("adminy", { id: "adminy", label: "Admin", requiredScopes: ["operator.admin"] }),
  ]);

  for (const [scope, ids] of [
    ["operator.read", []],
    ["operator.write", ["logbook"]],
    ["operator.admin", ["adminy", "logbook"]],
  ] as const) {
    expect(listControlUiPluginTabs([scope]).map((row) => row.id)).toEqual(ids);
    expect(listControlUiPluginDescriptors([scope]).map((row) => row.id)).toEqual(ids);
  }
});

it("projects only tabs, ordered by order, label, then id", () => {
  activateDescriptors([
    tab("b", { id: "beta", label: "Beta", placement: "route:workboard" }),
    tab("a", { id: "alpha", label: "Alpha", order: 5 }),
    tab("c", { id: "zed", label: "Beta" }),
    tab("other", { id: "run-panel", surface: "run" }),
  ]);

  const tabs = listControlUiPluginTabs([]);
  expect(tabs.map((row) => row.id)).toEqual(["beta", "zed", "alpha"]);
  expect(tabs[0]).toMatchObject({ pluginId: "b", placement: "route:workboard" });
  expect(listControlUiPluginDescriptors([]).map((entry) => entry.pluginId)).toEqual([
    "a",
    "b",
    "c",
    "other",
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
  const widgets = listControlUiPluginWidgetKinds(["operator.read"]);
  expect(widgets.map(({ kind }) => kind)).toEqual([
    "session:report",
    "session:progress",
    "session:website",
    "workboard:card",
    "workboard:mini",
  ]);
  expect(widgets[3]).toEqual({
    pluginId: "workboard",
    kind: "workboard:card",
    label: "Workboard card",
  });
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
    [route("logbook"), route("adminy"), route("publicish", undefined, "prefix", "plugin")],
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
    [route("nested", "/shared/panel", "exact"), route("outer", "/shared")],
  );

  expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([]);
  expect(listControlUiPluginTabs(["operator.admin"])).toEqual([]);
});

it("does not require a cookie grant when gateway auth is disabled", () => {
  activateDescriptors([tab("logbook", { path: "/plugins/logbook/panel" })], [route("logbook")]);

  const [projected] = listControlUiPluginTabs(["operator.admin"], {
    requireGatewayAuthGrant: false,
  });
  expect(projected).toMatchObject({ pluginId: "logbook" });
  expect(projected).not.toHaveProperty("requiresGatewayAuth");
});

it.each([false, true])("coalesces read grants and widens an exact path: %s", (widen) => {
  const root = "/plugins/logbook";
  activateDescriptors(
    [
      tab("logbook", { path: widen ? root : `${root}/read` }),
      tab("logbook", { path: `${root}/admin`, id: "admin", requiredScopes: ["operator.admin"] }),
    ],
    [...(widen ? [route("logbook", root, "exact")] : []), route("logbook", root)],
  );
  expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([grant("logbook")]);
});

it("keeps separate grants for different plugins that share a cookie path", () => {
  activateDescriptors(
    [
      tab("alpha", { path: "/shared", id: "alpha" }),
      tab("beta", { path: "/shared/child", id: "beta" }),
    ],
    [route("alpha", "/shared", "exact"), route("beta", "/shared")],
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
