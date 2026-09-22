import type { QueueConfig } from "./types.messages.js";

/** Queue overflow policy for inbound channel messages. */
export type QueueDropPolicy = NonNullable<QueueConfig["drop"]>;

export type QueueModeByProvider = NonNullable<QueueConfig["byChannel"]>;
