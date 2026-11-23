import type { PluginControlUiModule } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type {
  ControlUiDisposer,
  ControlUiHost,
  ControlUiSurface,
} from "../../../src/plugin-sdk/control-ui.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { controlUiPluginDeliveryIdentity } from "./control-ui-assets.ts";
import type { ControlUiContributions } from "./control-ui-capability.ts";
export type ControlUiPluginOwner = {
  packagedLocal?: boolean;
  descriptor: PluginControlUiModule;
  deliveryIdentity?: string;
  client: GatewayBrowserClient | null;
  /** Local presentations bind to a Gateway selection, never an authenticated client. */
  localGatewayUrl?: string;
  abort: AbortController;
  disposers: Set<ControlUiDisposer>;
  contributions: {
    [K in keyof ControlUiContributions]: Map<
      string,
      { value: ControlUiContributions[K]; signal: AbortSignal }
    >;
  };
  selections: Map<ControlUiSurface, string | null>;
  host: ControlUiHost;
};

/** Construct the entire staging lifetime before any plugin code can run. */
export function createPluginUiOwner(
  descriptor: PluginControlUiModule,
  client: GatewayBrowserClient | null,
  gatewayUrl: string,
  packagedLocal: boolean,
): Omit<ControlUiPluginOwner, "host"> {
  return {
    descriptor,
    packagedLocal,
    deliveryIdentity: controlUiPluginDeliveryIdentity(descriptor),
    client: descriptor.activation === "browser-local" ? null : client,
    ...(descriptor.activation === "browser-local" ? { localGatewayUrl: gatewayUrl } : {}),
    abort: new AbortController(),
    disposers: new Set<ControlUiDisposer>(),
    contributions: {
      pages: new Map(),
      navigation: new Map(),
      panels: new Map(),
      actions: new Map(),
      replacements: new Map(),
      accessories: new Map(),
      widgets: new Map(),
      inlineViews: new Map(),
    },
    selections: new Map<ControlUiSurface, string | null>(),
  };
}
