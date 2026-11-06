import type { ChannelsState } from "../../lib/channels/index.ts";

export type AgentChannelsReadState = Pick<
  ChannelsState,
  "channelsSnapshot" | "channelsRead" | "channelsError" | "channelsLastSuccess"
>;
