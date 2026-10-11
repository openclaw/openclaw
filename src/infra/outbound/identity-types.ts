/** Agent identity metadata that outbound channels can render with a message. */
export type OutboundIdentity = Partial<Record<"name" | "avatarUrl" | "emoji" | "theme", string>>;
