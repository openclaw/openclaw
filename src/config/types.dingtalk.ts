export type DingTalkConfig = {
  /** Whether the DingTalk channel is enabled. */
  enabled?: boolean;
  /** Account display name. */
  name?: string;
  /** DingTalk client id. */
  clientId?: string;
  /** DingTalk client secret. */
  clientSecret?: string;
  /** Allowlist for inbound senders. */
  allowFrom?: Array<string | number>;
};
