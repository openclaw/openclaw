/**
 * Primary routing: route all replies to a designated channel regardless of where messages originate.
 */
export type PrimaryRoutingChannel =
  | "telegram"
  | "whatsapp"
  | "discord"
  | "slack"
  | "signal"
  | "imessage";

export type PrimaryRoutingMode =
  | "primary-only" // Only send to primary channel
  | "mirror"; // Send to both source and primary

export type PrimaryRoutingConfig = {
  /** Routing mode: "primary-only" sends only to primary, "mirror" sends to both. */
  mode?: PrimaryRoutingMode;
  /** Primary channel to route all replies to. */
  channel: PrimaryRoutingChannel;
  /** Target address/ID on the primary channel (phone number, user ID, etc.). */
  to?: string;
  /** Optional note to prepend to messages sent to the primary channel for non-primary inbound. */
  nonPrimaryNote?: string;
};

export type RoutingConfig = {
  /** Primary routing configuration. */
  primary?: PrimaryRoutingConfig;
};
