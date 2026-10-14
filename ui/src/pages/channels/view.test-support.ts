import type { JSX } from "@solidjs/web";
import { createSignal, flush } from "solid-js";
import type { ChannelsPairingListResult, ChannelsStatusSnapshot } from "../../api/types.ts";
import type { ChannelsState } from "../../lib/channels/index.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import type { ChannelsProps } from "./view.types.ts";

export type ChannelsViewTestOverrides = Partial<
  Omit<ChannelsProps, "channels" | "config" | "presentation" | "wizardHost">
> & {
  channels?: Partial<ChannelsProps["channels"]>;
  config?: Partial<ChannelsProps["config"]>;
  presentation?: Partial<ChannelsProps["presentation"]>;
  wizardHost?: Partial<ChannelsProps["wizardHost"]>;
};

export function createChannelsViewProps(
  snapshot: ChannelsStatusSnapshot | null,
  pairingSnapshot: ChannelsPairingListResult | null,
  overrides: ChannelsViewTestOverrides = {},
): ChannelsProps {
  const { channels, config, presentation, wizardHost, ...props } = overrides;
  const channelState: ChannelsState = {
    client: null,
    connected: true,
    channelsLoading: false,
    channelsLoadingProbe: null,
    channelsRefreshSeq: 0,
    channelsSnapshot: snapshot,
    channelsError: null,
    channelsLastSuccess: null,
    pairingLoading: false,
    pairingRefreshSeq: 0,
    pairingSnapshot,
    pairingError: null,
    pairingLastSuccess: null,
    pairingBusyRequestId: null,
    whatsappLoginMessage: null,
    whatsappLoginQrDataUrl: null,
    whatsappLoginSessionKey: null,
    whatsappLoginConnected: null,
    whatsappBusy: false,
    ...channels,
  };
  return {
    channels: channelState,
    config: { ...createInitialConfigState(), ...config },
    presentation: {
      pluginCatalog: null,
      pluginIconUrls: {},
      ...presentation,
    } as ChannelsProps["presentation"],
    wizardHost: {
      state: { phase: "idle" },
      multiselect: [],
      textValue: "",
      secretVisible: false,
      blockedByDirtyConfig: false,
      toggleMultiselect: () => {},
      toggleSecretVisibility: () => {},
      answer: () => {},
      close: () => {},
      ...wizardHost,
    } as ChannelsProps["wizardHost"],
    pairingChannelFilter: null,
    pairingAccountFilter: null,
    pairingPrompt: null,
    pairingNotice: null,
    canManagePairing: true,
    canAdmin: true,
    showAdvancedSettings: false,
    nostrProfileFormState: null,
    nostrProfileAccountId: null,
    selectedChannel: null,
    onShowDetail: () => {},
    onCloseDetail: () => {},
    onStartSetup: () => {},
    onRefresh: () => {},
    onPairingRefresh: () => {},
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
    onNostrProfileEdit: () => {},
    onNostrProfileCancel: () => {},
    onNostrProfileFieldChange: () => {},
    onNostrProfileSave: () => {},
    onNostrProfileImport: () => {},
    onNostrProfileToggleAdvanced: () => {},
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
