import type { ChannelsPairingRequest, NostrProfile } from "../../api/types.ts";
import type { ChannelsState } from "../../lib/channels/index.ts";
import type { RuntimeConfigState } from "../../lib/config/config-state-model.ts";
import type { ChannelPluginPresentation } from "./plugin-presentation-loader.ts";
import type { NostrProfileFormState } from "./view.nostr-profile-form.tsx";
import type { ChannelSetup } from "./wizard-setup.ts";

export type ChannelPairingPrompt = {
  kind: "approve" | "dismiss";
  request: ChannelsPairingRequest;
  notify: boolean;
  bootstrapCommandOwner: boolean;
};

export type ChannelsProps = {
  channels: ChannelsState;
  config: RuntimeConfigState;
  presentation: Pick<ChannelPluginPresentation, "pluginCatalog" | "pluginIconUrls">;
  wizardHost: ChannelSetup;
  pairingChannelFilter: string | null;
  pairingAccountFilter: string | null;
  pairingPrompt: ChannelPairingPrompt | null;
  pairingNotice: string | null;
  canManagePairing: boolean;
  canAdmin: boolean;
  showAdvancedSettings: boolean;
  nostrProfileFormState: NostrProfileFormState | null;
  nostrProfileAccountId: string | null;
  selectedChannel: string | null;
  onShowDetail: (channelId: string) => void;
  onCloseDetail: () => void;
  onStartSetup: (channelId: string | null) => void;
  onRefresh: (probe: boolean) => void;
  onPairingRefresh: () => void;
  onPairingRoot: (element: HTMLDivElement) => void;
  onPairingFilterChange: (channel: string | null, accountId: string | null) => void;
  onPairingReviewAccount: (channel: string, accountId: string) => void;
  onPairingApprove: (request: ChannelsPairingRequest) => void;
  onPairingDismiss: (request: ChannelsPairingRequest) => void;
  onPairingPromptChange: (
    patch: Partial<Pick<ChannelPairingPrompt, "notify" | "bootstrapCommandOwner">>,
  ) => void;
  onPairingPromptCancel: () => void;
  onPairingPromptConfirm: () => void;
  onWhatsAppStart: (force: boolean) => void;
  onWhatsAppWait: () => void;
  onWhatsAppLogout: () => void;
  onShowAdvancedSettings: (enabled: boolean) => void;
  onConfigPatch: (path: Array<string | number>, value: unknown) => void;
  onConfigSave: () => void;
  onConfigReload: () => void;
  onNostrProfileEdit: (accountId: string, profile: NostrProfile | null) => void;
  onNostrProfileCancel: () => void;
  onNostrProfileFieldChange: (field: keyof NostrProfile, value: string) => void;
  onNostrProfileSave: () => void;
  onNostrProfileImport: () => void;
  onNostrProfileToggleAdvanced: () => void;
};
