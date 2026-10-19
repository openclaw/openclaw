import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { QueueDropPolicy } from "../../../config/types.queue.js";

export type { QueueDropPolicy } from "../../../config/types.queue.js";

export type QueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

export type ResolveQueueSettingsParams = {
  cfg: OpenClawConfig;
  channel?: string;
  sessionEntry?: SessionEntry;
  inlineMode?: QueueMode;
  inlineOptions?: Partial<QueueSettings>;
  pluginDebounceMs?: number;
};

export type QueueDedupeMode = "message-id" | "none";

type QueueInsertPosition = "tail" | "front";

export type EnqueueFollowupRunOptions = {
  /** Physical owner of a new source, when it differs from the configured store. */
  storePath?: string;
  position?: QueueInsertPosition;
  steerCandidate?: boolean;
};
