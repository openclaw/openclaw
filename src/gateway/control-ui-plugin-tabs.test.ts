import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { HelloOkSchema } from "../../packages/gateway-protocol/src/schema/frames.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { PluginControlUiDescriptor } from "../plugins/host-hooks.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  listControlUiPluginTabAuthGrants,
  listControlUiPluginTabs,
  listControlUiPluginWidgetKinds,
} from "./control-ui-plugin-tabs.js";

function tabDescriptor(
  overrides: Partial<PluginControlUiDescriptor> = {},
): PluginControlUiDescriptor {
  return {
    id: "logbook",
    surface: "tab",
    label: "Logbook",
    ...overrides,
  };
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

describe("listControlUiPluginTabs", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("advertises a tab slug in the hello contract without altering its frame path", () => {
    activateDescriptors([
      {
        pluginId: "reports-fixture",
        descriptor: tabDescriptor({ slug: "reports", path: "/plugins/reports-fixture" }),
      },
    ]);
    const tabs = listControlUiPluginTabs(["operator.read"]);
    expect(tabs).toEqual([
      expect.objectContaining({ slug: "reports", path: "/plugins/reports-fixture" }),
    ]);
    expect(Value.Check(HelloOkSchema.properties.controlUiTabs, tabs)).toBe(true);
  });

  it.each([
    { basePath: "", path: "/reports", match: "exact" as const, auth: "gateway" as const },
    { basePath: "", path: "/reports", match: "prefix" as const, auth: "plugin" as const },
    { basePath: "/team/", path: "/team/reports", match: "exact" as const, auth: "plugin" as const },
    { basePath: "/team", path: "/team", match: "prefix" as const, auth: "gateway" as const },
  ])(
    "drops a slug shadowed by $auth $match route $path under $basePath once",
    ({ basePath, ...route }) => {
      setRuntimeConfigSnapshot({ gateway: { controlUi: { basePath } } });
      const registry = activateDescriptors([
        {
          pluginId: "reports-fixture",
          descriptor: tabDescriptor({ slug: "reports", path: "/plugins/reports-fixture" }),
        },
      ]);
      // HTTP registration after the descriptor must produce the same projection.
      registry.httpRoutes.push({
        ...route,
        pluginId: "other",
        source: "test:other",
        handler: async () => true,
      });
      for (let connect = 0; connect < 2; connect += 1) {
        const [tab] = listControlUiPluginTabs(["operator.read"]);
        expect(tab).toMatchObject({
          pluginId: "reports-fixture",
          path: "/plugins/reports-fixture",
        });
        expect(tab).not.toHaveProperty("slug");
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

  it.each([
    { basePath: "", path: "/report", match: "prefix" as const },
    { basePath: "", path: "/reports/child", match: "prefix" as const },
    { basePath: "/team", path: "/reports", match: "exact" as const },
    { basePath: "/team", path: "/team", match: "exact" as const },
  ])(
    "keeps slugs when $match route $path does not shadow mount $basePath",
    ({ basePath, ...route }) => {
      setRuntimeConfigSnapshot({ gateway: { controlUi: { basePath } } });
      const registry = activateDescriptors(
        [{ pluginId: "reports-fixture", descriptor: tabDescriptor({ slug: "reports" }) }],
        [{ ...route, pluginId: "other" }],
      );
      expect(listControlUiPluginTabs(["operator.read"])[0]?.slug).toBe("reports");
      expect(registry.diagnostics).toEqual([]);
    },
  );

  it("projects only tab descriptors", () => {
    activateDescriptors([
      {
        pluginId: "workboard",
        descriptor: tabDescriptor({ placement: "route:workboard" }),
      },
      { pluginId: "other", descriptor: tabDescriptor({ id: "run-panel", surface: "run" }) },
    ]);

    const tabs = listControlUiPluginTabs(["operator.admin"]);
    expect(tabs.map((tab) => tab.id)).toEqual(["logbook"]);
    expect(expectDefined(tabs[0], "tabs[0] test invariant")).toMatchObject({
      placement: "route:workboard",
      pluginId: "workboard",
    });
  });

  it("hides tabs whose required scopes are not granted", () => {
    activateDescriptors([
      {
        pluginId: "logbook",
        descriptor: tabDescriptor({ requiredScopes: ["operator.write"] }),
      },
      {
        pluginId: "adminy",
        descriptor: tabDescriptor({
          id: "adminy",
          label: "Admin",
          requiredScopes: ["operator.admin"],
        }),
      },
    ]);

    expect(listControlUiPluginTabs(["operator.read"])).toEqual([]);
    expect(listControlUiPluginTabs(["operator.write"]).map((tab) => tab.id)).toEqual(["logbook"]);
    expect(listControlUiPluginTabs(["operator.admin"]).map((tab) => tab.id)).toEqual([
      "adminy",
      "logbook",
    ]);
  });

  it("orders deterministically by order, label, then id", () => {
    activateDescriptors([
      { pluginId: "b", descriptor: tabDescriptor({ id: "beta", label: "Beta" }) },
      { pluginId: "a", descriptor: tabDescriptor({ id: "alpha", label: "Alpha", order: 5 }) },
      { pluginId: "c", descriptor: tabDescriptor({ id: "zed", label: "Beta" }) },
    ]);

    expect(listControlUiPluginTabs([]).map((tab) => tab.id)).toEqual(["beta", "zed", "alpha"]);
  });

  it("merges the read-scoped core kind into deterministic plugin ordering", () => {
    activateDescriptors([
      {
        pluginId: "workboard",
        descriptor: tabDescriptor({
          id: "card",
          surface: "widget",
          label: "Workboard card",
          requiredScopes: ["operator.read"],
        }),
      },
      {
        pluginId: "workboard",
        descriptor: tabDescriptor({
          id: "mini",
          surface: "widget",
          label: "Workboard summary",
          requiredScopes: ["operator.read"],
        }),
      },
    ]);

    expect(listControlUiPluginWidgetKinds([])).toEqual([]);
    expect(listControlUiPluginWidgetKinds(["operator.read"])).toEqual([
      { pluginId: "session", kind: "session:report", label: "Report" },
      { pluginId: "session", kind: "session:progress", label: "Session progress" },
      { pluginId: "workboard", kind: "workboard:card", label: "Workboard card" },
      { pluginId: "workboard", kind: "workboard:mini", label: "Workboard summary" },
    ]);
  });

  it("grants only same-plugin gateway routes with least-privilege scopes", () => {
    activateDescriptors(
      [
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({ path: "/plugins/logbook/panel" }),
        },
        {
          pluginId: "adminy",
          descriptor: tabDescriptor({
            id: "adminy",
            path: "/plugins/adminy/panel",
            requiredScopes: ["operator.admin"],
          }),
        },
        {
          pluginId: "publicish",
          descriptor: tabDescriptor({ id: "publicish", path: "/plugins/publicish/panel" }),
        },
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
      {
        pluginId: "adminy",
        path: "/plugins/adminy",
        match: "prefix",
        scopes: ["operator.read"],
      },
      {
        pluginId: "logbook",
        path: "/plugins/logbook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
    const adminTabs = listControlUiPluginTabs(["operator.admin"]);
    expect(adminTabs).toEqual([
      expect.objectContaining({
        pluginId: "adminy",
        requiresGatewayAuth: true,
      }),
      expect.objectContaining({
        pluginId: "logbook",
        requiresGatewayAuth: true,
      }),
      expect.objectContaining({
        pluginId: "publicish",
      }),
    ]);
    expect(adminTabs[2]).not.toHaveProperty("requiresGatewayAuth");
    expect(listControlUiPluginTabAuthGrants(["operator.read"])).toEqual([
      {
        pluginId: "logbook",
        path: "/plugins/logbook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
  });

  it("matches gateway routes against descriptor URL pathnames", () => {
    const path = "/plugins/logbook/panel?view=activity#settings";
    activateDescriptors(
      [{ pluginId: "logbook", descriptor: tabDescriptor({ path }) }],
      [{ pluginId: "logbook", path: "/plugins/logbook/panel", match: "exact" }],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.read"])).toEqual([
      {
        pluginId: "logbook",
        path: "/plugins/logbook/panel",
        match: "exact",
        scopes: ["operator.read"],
      },
    ]);
    expect(listControlUiPluginTabs(["operator.read"])).toEqual([
      expect.objectContaining({ path, requiresGatewayAuth: true }),
    ]);
  });

  it("does not grant a matching route owned by another plugin", () => {
    activateDescriptors(
      [{ pluginId: "logbook", descriptor: tabDescriptor({ path: "/shared/panel" }) }],
      [{ pluginId: "other", path: "/shared", match: "prefix" }],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([]);
    expect(listControlUiPluginTabs(["operator.admin"])).toEqual([]);
  });

  it("uses the first dispatched gateway route as descriptor owner", () => {
    activateDescriptors(
      [{ pluginId: "outer", descriptor: tabDescriptor({ path: "/shared/panel" }) }],
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
      [{ pluginId: "logbook", descriptor: tabDescriptor({ path: "/plugins/logbook/panel" }) }],
      [{ pluginId: "logbook", path: "/plugins/logbook", match: "prefix" }],
    );

    const [tab] = listControlUiPluginTabs(["operator.admin"], {
      requireGatewayAuthGrant: false,
    });
    expect(tab).toMatchObject({ pluginId: "logbook" });
    expect(tab).not.toHaveProperty("requiresGatewayAuth");
  });

  it("coalesces same-plugin tabs that share one read-only cookie path", () => {
    activateDescriptors(
      [
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({ path: "/plugins/logbook/read" }),
        },
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({
            id: "admin",
            path: "/plugins/logbook/admin",
            requiredScopes: ["operator.admin"],
          }),
        },
      ],
      [{ pluginId: "logbook", path: "/plugins/logbook", match: "prefix" }],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "logbook",
        path: "/plugins/logbook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
  });

  it("widens a shared exact cookie path when another visible tab needs prefix matching", () => {
    activateDescriptors(
      [
        { pluginId: "logbook", descriptor: tabDescriptor({ path: "/plugins/logbook" }) },
        {
          pluginId: "logbook",
          descriptor: tabDescriptor({ id: "child", path: "/plugins/logbook/child" }),
        },
      ],
      [
        { pluginId: "logbook", path: "/plugins/logbook", match: "exact" },
        { pluginId: "logbook", path: "/plugins/logbook", match: "prefix" },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "logbook",
        path: "/plugins/logbook",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
  });

  it("keeps separate grants for different plugins that share a cookie path", () => {
    activateDescriptors(
      [
        { pluginId: "alpha", descriptor: tabDescriptor({ id: "alpha", path: "/shared" }) },
        {
          pluginId: "beta",
          descriptor: tabDescriptor({ id: "beta", path: "/shared/child" }),
        },
      ],
      [
        { pluginId: "alpha", path: "/shared", match: "exact" },
        { pluginId: "beta", path: "/shared", match: "prefix" },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "alpha",
        path: "/shared",
        match: "exact",
        scopes: ["operator.read"],
      },
      {
        pluginId: "beta",
        path: "/shared",
        match: "prefix",
        scopes: ["operator.read"],
      },
    ]);
    expect(listControlUiPluginTabs(["operator.admin"]).map((tab) => tab.pluginId)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("uses only the first route owner when plugins declare the same path", () => {
    activateDescriptors(
      [
        { pluginId: "alpha", descriptor: tabDescriptor({ id: "alpha", path: "/shared" }) },
        { pluginId: "beta", descriptor: tabDescriptor({ id: "beta", path: "/shared" }) },
      ],
      [
        { pluginId: "alpha", path: "/shared", match: "exact" },
        { pluginId: "beta", path: "/shared", match: "prefix" },
      ],
    );

    expect(listControlUiPluginTabAuthGrants(["operator.admin"])).toEqual([
      {
        pluginId: "alpha",
        path: "/shared",
        match: "exact",
        scopes: ["operator.read"],
      },
    ]);
    expect(listControlUiPluginTabs(["operator.admin"]).map((tab) => tab.pluginId)).toEqual([
      "alpha",
    ]);
  });
});
