import type {
  PluginControlUiDiagnostic,
  PluginControlUiModule,
} from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type {
  ControlUiAction,
  ControlUiAccessoryRegistration,
  ControlUiDisposer,
  ControlUiHost,
  ControlUiNavigationItem,
  ControlUiPage,
  ControlUiPanel,
  ControlUiReplacement,
  ControlUiSurface,
  ControlUiWidget,
} from "../../../src/plugin-sdk/control-ui.js";

export type ControlUiRegistration<T> = {
  key: `${string}/${string}`;
  pluginId: string;
  /** Display name from the owning module descriptor. */
  pluginName?: string;
  /** Host-admitted passive SVG data URL from the owning plugin manifest. */
  panelIcon?: string;
  value: T;
  host: ControlUiHost;
  signal: AbortSignal;
};

export type ControlUiContributions = {
  pages: ControlUiPage;
  navigation: ControlUiNavigationItem;
  panels: ControlUiPanel;
  actions: ControlUiAction;
  accessories: ControlUiAccessoryRegistration;
  widgets: ControlUiWidget;
  inlineViews: Parameters<ControlUiHost["ui"]["registerInlineView"]>[0];
  replacements: ControlUiReplacement;
};

// Application consumers use the registry contract; construction and activation
// ownership stay in the runtime without a dependency back through app context.
export type ControlUiPluginCapability = {
  loadSettingsView: {
    (
      placement: import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiSettingsView["placement"],
      signal: AbortSignal,
    ): Promise<{
      view: import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiSettingsView;
      signal: AbortSignal;
      dispose: () => void;
    }>;
    (
      placement: import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiChannelSettingsView["placement"],
      signal: AbortSignal,
    ): Promise<{
      view: import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiChannelSettingsView;
      signal: AbortSignal;
      dispose: () => void;
    }>;
  };
  readonly errors: readonly PluginControlUiDiagnostic[];
  readonly hasPlugins: boolean;
  /** Advances before notifications, including plugin-owned presentation mutations. */
  readonly revision: number;
  readonly registryStatus: "pending" | "complete" | "failed";
  readonly canReload: boolean;
  isLoading: (pluginId: string) => boolean;
  inlineViewLabel: (key: string) => string | undefined;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
  subscribe: (listener: () => void) => ControlUiDisposer;
  registrations: <K extends keyof ControlUiContributions>(
    kind: K,
  ) => ControlUiRegistration<ControlUiContributions[K]>[];
  selectedReplacement: (
    surface: ControlUiSurface,
  ) => ControlUiRegistration<ControlUiReplacement> | undefined;
  selectReplacement: (surface: ControlUiSurface, key: string | null) => void;
  reportError: (pluginId: string, error: unknown) => void;
};

const UI_CAPABILITY_BY_CONTRIBUTION = {
  pages: "page",
  navigation: "navigation",
  panels: "panel",
  actions: "action",
  accessories: "accessory",
  widgets: "widget",
  inlineViews: "inline",
  replacements: "replacement",
} as const satisfies Record<
  keyof ControlUiContributions,
  import("../../../packages/gateway-protocol/src/plugin-ui-capabilities.ts").PluginUiCapability
>;

/** Diagnostics follow live contributions, not catalog refreshes or activation receipts. */
export function controlUiCapabilityWarnings(owner: {
  descriptor: Pick<PluginControlUiModule, "pluginId" | "uiCapabilities">;
  contributions: { [K in keyof ControlUiContributions]: { size: number } };
}): PluginControlUiDiagnostic[] {
  // SAFETY: the canonical mapping satisfies exactly the contribution registry keys.
  return (Object.keys(UI_CAPABILITY_BY_CONTRIBUTION) as (keyof ControlUiContributions)[])
    .filter(
      (kind) =>
        owner.contributions[kind].size > 0 &&
        owner.descriptor.uiCapabilities &&
        !owner.descriptor.uiCapabilities.includes(UI_CAPABILITY_BY_CONTRIBUTION[kind]),
    )
    .map((kind) => ({
      pluginId: owner.descriptor.pluginId,
      message: `Registered UI capability "${UI_CAPABILITY_BY_CONTRIBUTION[kind]}" is missing from uiCapabilities in openclaw.plugin.json.`,
    }));
}
