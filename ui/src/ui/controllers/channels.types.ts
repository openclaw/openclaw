import type { GatewayBrowserClient } from "../gateway.ts";
import type { ChannelsStatusSnapshot } from "../types.ts";

export type ChannelsState = {
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
  simplexInviteBusy: boolean;
  simplexInviteMode: SimplexInviteMode | null;
  simplexInviteLink: string | null;
  simplexInviteQrDataUrl: string | null;
  simplexInviteError: string | null;
};

export type SimplexInviteMode = "connect" | "address";
