import type { GatewayBrowserClient } from "../gateway";
import type { ChannelsStatusSnapshot, ConfigSnapshot } from "../types";
import type {
  DiscordForm,
  IMessageForm,
  SlackForm,
  SignalForm,
  TelegramForm,
} from "../ui-types";

export type ConnectionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  channelsLoading: boolean;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsLastSuccess: number | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
  telegramForm: TelegramForm;
  telegramSaving: boolean;
  telegramTokenLocked: boolean;
  telegramConfigStatus: string | null;
  discordForm: DiscordForm;
  discordSaving: boolean;
  discordTokenLocked: boolean;
  discordConfigStatus: string | null;
  slackForm: SlackForm;
  slackSaving: boolean;
  slackTokenLocked: boolean;
  slackAppTokenLocked: boolean;
  slackConfigStatus: string | null;
  signalForm: SignalForm;
  signalSaving: boolean;
  signalConfigStatus: string | null;
  imessageForm: IMessageForm;
  imessageSaving: boolean;
  imessageConfigStatus: string | null;
  configSnapshot: ConfigSnapshot | null;
};

