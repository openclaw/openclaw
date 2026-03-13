export type PairingNotifyConfig = {
  /** Enable owner notifications for new pairing requests. Default: true when target is set. */
  enabled?: boolean;
  /**
   * Notification target: the owner's address on the notification channel.
   * e.g., phone number for iMessage/WhatsApp/Signal, user ID for Telegram/Discord/Slack.
   */
  target?: string;
  /**
   * Channel to send notifications through (e.g., "imessage", "telegram", "whatsapp").
   * Default: "imessage".
   */
  channel?: string;
  /** Account ID when using multi-account channel setups. */
  accountId?: string;
};

export type PairingConfig = {
  /** Owner notification settings for new pairing requests. */
  notify?: PairingNotifyConfig;
};
