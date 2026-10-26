import type { JSX } from "@solidjs/web";
import { createSignal, flush, merge } from "solid-js";
import { onTestFinished, vi } from "vitest";
import type { ChannelsPairingListResult, ChannelsStatusSnapshot } from "../../api/types.ts";
import { createChannelCapability, type ChannelCapability } from "../../lib/channels/index.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { ChannelsProps } from "./view.types.ts";

export function mountChannelSource(
  reads: { promise: Promise<unknown> }[],
  method: string,
  scope: string,
  render: (
    channels: ChannelCapability,
    fixture: ReturnType<typeof createApplicationGateway>,
  ) => JSX.Element,
) {
  const request = vi.fn();
  for (const read of reads) {
    request.mockReturnValueOnce(read.promise);
  }
  const fixture = createApplicationGateway();
  fixture.publish({
    ...fixture.gateway.snapshot,
    client: createTestGatewayClient(request),
    phase: "connected",
    hello: gatewayHelloForMethods([method], [scope]),
  });
  const channels = createChannelCapability(fixture.gateway);
  const mounted = mountSolid(() => render(channels, fixture));
  onTestFinished(() => {
    mounted.unmount();
    channels.dispose();
    document.body.replaceChildren();
  });
  const query = <T extends Element = HTMLElement>(selector: string) =>
    mounted.container.querySelector<T>(selector);
  const queryAll = <T extends Element = HTMLElement>(selector: string) =>
    mounted.container.querySelectorAll<T>(selector);
  return { ...fixture, channels, container: mounted.container, query, queryAll };
}
export type ChannelsViewTestOverrides = Partial<
  Omit<ChannelsProps, "channels" | "config" | "presentation" | "wizardHost">
> & {
  channels?: Partial<ChannelsProps["channels"]>;
  config?: Partial<ChannelsProps["config"]>;
  presentation?: Partial<ChannelsProps["presentation"]>;
  wizardHost?: Partial<ChannelsProps["wizardHost"]>;
};

export function createChannelsState(
  snapshot: ChannelsStatusSnapshot | null,
  pairingSnapshot: ChannelsPairingListResult | null,
  overrides: Partial<ChannelCapability["state"]> = {},
): ChannelCapability["state"] {
  const channels = createChannelCapability(createApplicationGateway().gateway);
  const state = {
    ...channels.state,
    connected: true,
    channelsSnapshot: snapshot,
    pairingSnapshot,
    ...overrides,
  };
  channels.dispose();
  return state;
}

export function createChannelsViewProps(
  snapshot: ChannelsStatusSnapshot | null,
  pairingSnapshot: ChannelsPairingListResult | null,
  overrides: ChannelsViewTestOverrides = {},
): ChannelsProps {
  const { channels, config, presentation, wizardHost, ...props } = overrides;
  const channelState = createChannelsState(snapshot, pairingSnapshot, channels);
  return {
    channels: channelState,
    config: { ...createInitialConfigState(), ...config },
    presentation: {
      pluginCatalog: null,
      pluginIconUrls: {},
      details: { has: () => false, sync: () => {}, reset: () => {}, attach: () => () => {} },
      ...presentation,
    },
    wizardHost: {
      state: () => ({ phase: "idle" }),
      draft: { multiselect: [], textValue: "", secretVisible: false },
      setTextValue: () => {},
      blockedByDirtyConfig: createSignal(false)[0],
      whatsappAccountId: () => undefined,
      startSetup: () => {},
      toggleMultiselect: () => {},
      toggleSecretVisibility: () => {},
      answer: () => {},
      close: () => {},
      ...wizardHost,
    },
    pairingChannelFilter: null,
    pairingAccountFilter: null,
    pairingPrompt: null,
    pairingNotice: null,
    canManagePairing: true,
    canAdmin: true,
    showAdvancedSettings: false,
    selectedChannel: null,
    onShowDetail: () => {},
    onCloseDetail: () => {},
    onStartSetup: () => {},
    onRefresh: () => {},
    onPairingRefresh: () => {},
    onPairingRoot: () => {},
    onPairingFilterChange: () => {},
    onPairingReviewAccount: () => {},
    onPairingApprove: () => {},
    onPairingDismiss: () => {},
    onPairingPromptChange: () => {},
    onPairingPromptCancel: () => {},
    onPairingPromptConfirm: () => {},
    onWhatsAppStart: () => {},
    onWhatsAppWait: () => {},
    onWhatsAppLogout: () => {},
    onShowAdvancedSettings: () => {},
    onConfigPatch: () => {},
    onConfigSave: () => {},
    onConfigReload: () => {},
    ...props,
  };
}

const mountedViews = new Map<
  HTMLElement,
  {
    component: unknown;
    update: (props: object) => void;
    dispose: () => void;
  }
>();

/** Keep the same component mounted while replacing its caller-owned props. */
export function renderChannelView<T extends object>(
  component: (props: T) => JSX.Element,
  props: T,
  container: HTMLElement,
): void {
  const current = mountedViews.get(container);
  if (current?.component === component) {
    current.update(props);
    flush();
    return;
  }
  current?.dispose();
  const [read, write] = createSignal<object>(props, { equals: false });
  // The live view preserves the same generic props contract as the original proxy.
  const { unmount: dispose } = mountSolid(() => component(merge(() => read() as T)), { container });
  mountedViews.set(container, { component, update: (next) => write(() => next), dispose });
  flush();
}

export function disposeChannelViews(): void {
  for (const view of mountedViews.values()) {
    view.dispose();
  }
  mountedViews.clear();
}
