import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import type { ChannelsPairingListResult, ChannelsStatusSnapshot } from "../../api/types.ts";
import { createChannelCapability, type ChannelCapability } from "../../lib/channels/index.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { ChannelsProps } from "./view.types.ts";

export function channelSnapshot(
  channels: ChannelsStatusSnapshot["channels"] = {},
  overrides: Partial<ChannelsStatusSnapshot> = {},
): ChannelsStatusSnapshot {
  return {
    ts: 1,
    channelOrder: Object.keys(channels),
    channelLabels: Object.fromEntries(Object.keys(channels).map((id) => [id, id])),
    channels,
    channelAccounts: {},
    channelDefaultAccountId: {},
    ...overrides,
  };
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
  return {
    channels: createChannelsState(snapshot, pairingSnapshot, channels),
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
  // SAFETY: The proxy forwards property reads to the current T input; its empty target is never exposed.
  const reactiveProps = new Proxy({} as T, {
    get: (_target, key) => Reflect.get(read(), key),
    has: (_target, key) => Reflect.has(read(), key),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
  });
  const { unmount: dispose } = mountSolid(() => component(reactiveProps), { container });
  mountedViews.set(container, { component, update: (next) => write(() => next), dispose });
  flush();
}

export function disposeChannelViews(): void {
  for (const view of mountedViews.values()) {
    view.dispose();
  }
  mountedViews.clear();
}
