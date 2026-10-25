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
  ({ basePath, ...shadow }) => {
    setRuntimeConfigSnapshot({ gateway: { controlUi: { basePath } } });
    const registry = activateDescriptors([
      tab("reports-fixture", { slug: "reports", path: "/plugins/reports-fixture" }),
    ]);
    // HTTP registration after the descriptor must produce the same projection.
    registry.httpRoutes.push({
      ...shadow,
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
