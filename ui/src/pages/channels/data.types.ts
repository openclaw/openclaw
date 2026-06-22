// Channels page data contracts.
import type { GatewayBrowserClient } from "../../ui/gateway.ts";
import type { ChannelsStatusSnapshot } from "../../ui/types.ts";

export type ChannelsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  channelsLoading: boolean;
  channelsLoadingProbe?: boolean | null;
  channelsRefreshSeq?: number;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  channelsError: string | null;
  channelsLastSuccess: number | null;
  whatsappLoginMessage: string | null;
  whatsappLoginQrDataUrl: string | null;
  whatsappLoginConnected: boolean | null;
  whatsappBusy: boolean;
};
