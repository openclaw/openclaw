import type { ChannelsPairingListResult, ChannelsStatusSnapshot } from "../../api/types.ts";
import type { ChannelsState } from "../../lib/channels/index.ts";
import { createInitialConfigState } from "../../lib/config/config-state-model.ts";
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
      setTextValue: () => {},
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
