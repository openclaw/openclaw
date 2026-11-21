import type { ChannelsPairingRequest } from "../../api/types.ts";
import type { ChannelsState } from "../../lib/channels/index.ts";
import type { RuntimeConfigState } from "../../lib/config/config-state-model.ts";
import type { PluginListResult } from "../../lib/plugins/index.ts";
import type { createChannelSetup } from "./wizard-setup.ts";

export type ChannelSettingsPresentation = {
  has: (channelId: string) => boolean;
  sync: () => void;
  reset: () => void;
  attach: (channelId: string, container: HTMLElement) => () => void;
};

export type ChannelPairingPrompt = {
  kind: "approve" | "dismiss";
  request: ChannelsPairingRequest;
  notify: boolean;
  bootstrapCommandOwner: boolean;
};

/** What the last Save of one channel reported; only that channel's dialog shows it. */
export type ChannelSaveFeedback = { channelId: string } & (
  | { kind: "error"; message: string }
  | { kind: "conflict"; paths: Array<Array<string | number>> }
  | { kind: "interrupted" }
  | { kind: "notSaved" }
);

export type ChannelsProps = {
  /** Unsaved form edits per channel; they reach the config only through Save. */
  configEdits: ChannelsState["configEdits"];
  savingChannel: string | null;
  savedChannel: string | null;
  saveFeedback: ChannelSaveFeedback | null;
  mutationBusy?: Readonly<Partial<Record<"config" | "pairing" | "whatsapp" | "wizard", boolean>>>;
  channels: ChannelsState;
  config: RuntimeConfigState;
  presentation: {
    readonly pluginCatalog: PluginListResult | null;
    readonly pluginIconUrls: Record<string, string>;
    readonly details: ChannelSettingsPresentation;
  };
  wizardHost: ReturnType<typeof createChannelSetup>;
  pairingChannelFilter: string | null;
  pairingAccountFilter: string | null;
  pairingPrompt: ChannelPairingPrompt | null;
  pairingNotice: string | null;
  canManagePairing: boolean;
  canAdmin: boolean;
  showAdvancedSettings: boolean;
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
  onWhatsAppStart: (force: boolean) => void | Promise<void>;
  onWhatsAppWait: () => void | Promise<void>;
  onWhatsAppLogout: (accountId: string) => void | Promise<void>;
  onShowAdvancedSettings: (enabled: boolean) => void;
  onConfigPatch: (channelId: string, path: Array<string | number>, value: unknown) => void;
  onConfigSave: (channelId: string) => void;
  onConfigDiscard: (channelId: string) => void;
  /** Keep the edits to fields changed elsewhere, or take the newer values; then save. */
  onConfigConflict: (channelId: string, choice: "keep" | "latest") => void;
};
