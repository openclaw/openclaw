import type { PluginControlUiDiagnostic } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type {
  ControlUiActionV2 as ControlUiAction,
  ControlUiAccessory,
  ControlUiSessionAccessory,
  ControlUiDisposer,
  ControlUiHostV2 as ControlUiHost,
  ControlUiNavigationItem,
  ControlUiPageV2 as ControlUiPage,
  ControlUiPanelV2 as ControlUiPanel,
  ControlUiReplacementV2 as ControlUiReplacement,
  ControlUiSurface,
  ControlUiTextReferenceProvider,
  ControlUiWidgetV2 as ControlUiWidget,
} from "../../../src/plugin-sdk/control-ui.js";

export type ControlUiRegistration<T> = {
  key: `${string}/${string}`;
  pluginId: string;
  value: T;
  host: ControlUiHost;
  signal: AbortSignal;
};

export type ControlUiContributions = {
  pages: ControlUiPage;
  navigation: ControlUiNavigationItem;
  panels: ControlUiPanel;
  actions: ControlUiAction;
  accessories: ControlUiAccessory | ControlUiSessionAccessory;
  textReferences: ControlUiTextReferenceProvider;
  widgets: ControlUiWidget;
  inlineViews: Parameters<ControlUiHost["ui"]["registerInlineView"]>[0];
  replacements: ControlUiReplacement;
};

// Application consumers use the registry contract; construction and activation
// ownership stay in the runtime without a dependency back through app context.
export type ControlUiPluginCapability = {
  readonly settingsContributions: readonly import("./control-ui-metadata.ts").ControlUiSettingsContribution[];
  loadSettingsView: {
    (
      placement:
        | import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiSettingsView["placement"]
        | import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiContributedSettingsView["placement"],
      signal: AbortSignal,
      pluginId?: string,
    ): Promise<{
      view:
        | import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiSettingsView
        | import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiContributedSettingsView;
      signal: AbortSignal;
      dispose: () => void;
    }>;
    (
      placement: import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiChannelSettingsView["placement"],
      signal: AbortSignal,
      pluginId?: string,
    ): Promise<{
      view: import("../../../src/plugin-sdk/control-ui-settings.js").ControlUiChannelSettingsView;
      signal: AbortSignal;
      dispose: () => void;
    }>;
  };
  readonly repositorySources: readonly import("./control-ui-metadata.ts").ControlUiRepositorySourceContribution[];
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
