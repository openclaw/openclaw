/** Exact public projection expected from the host-hook fixture plugin. */
export function hostHookUiProjection(generation: number) {
  return {
    ok: true,
    generation,
    methods: ["plugins.uiDescriptors", "plugins.sessionAction"],
    controlUiTabs: [],
    controlUiLinkReaders: [],
    controlUiWidgetKinds: [
      { pluginId: "session", kind: "session:report", label: "Report" },
      { pluginId: "session", kind: "session:progress", label: "Session progress" },
      { pluginId: "session", kind: "session:website", label: "Website" },
    ],
    pluginSurfaceUrls: {},
    descriptors: [
      {
        id: "admin-panel",
        pluginId: "host-hook-fixture",
        pluginName: "Host Hook Fixture",
        surface: "settings",
        label: "Admin panel",
        requiredScopes: ["operator.admin"],
      },
      {
        id: "approval-panel",
        pluginId: "host-hook-fixture",
        pluginName: "Host Hook Fixture",
        surface: "session",
        label: "Approval panel",
      },
    ],
  };
}
