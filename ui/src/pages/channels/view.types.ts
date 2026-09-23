// Channels page view contracts.
import type {
  ChannelAccountSnapshot,
  ChannelsPairingRequest,
  DiscordStatus,
  GoogleChatStatus,
  IMessageStatus,
  NostrProfile,
  NostrStatus,
  SignalStatus,
  SlackStatus,
  TelegramStatus,
  WhatsAppStatus,
} from "../../api/types.ts";
import type { ChannelsState } from "../../lib/channels/index.ts";
import type { RuntimeConfigState } from "../../lib/config/config-state-model.ts";
import type { ChannelPluginPresentationController } from "./plugin-presentation-controller.ts";
import type { NostrProfileFormState } from "./view.nostr-profile-form.ts";
import type { ChannelWizardHost } from "./wizard-host.ts";

export type ChannelKey = string;

export type ChannelPairingPrompt = {
  kind: "approve" | "dismiss";
  request: ChannelsPairingRequest;
  notify: boolean;
  bootstrapCommandOwner: boolean;
};

export type ChannelsProps = {
  channels: ChannelsState;
  config: RuntimeConfigState;
  presentation: ChannelPluginPresentationController;
  wizardHost: ChannelWizardHost;
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

export type ChannelsChannelData = {
  whatsapp?: WhatsAppStatus;
  telegram?: TelegramStatus;
  discord?: DiscordStatus | null;
  googlechat?: GoogleChatStatus | null;
  slack?: SlackStatus | null;
  signal?: SignalStatus | null;
  imessage?: IMessageStatus | null;
  nostr?: NostrStatus | null;
  channelAccounts?: Record<string, ChannelAccountSnapshot[]> | null;
};
