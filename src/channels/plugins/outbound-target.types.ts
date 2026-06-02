/** Leaf outbound target-reference type shared by channel and core delivery contracts. */
export type ChannelOutboundTargetRef = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};
