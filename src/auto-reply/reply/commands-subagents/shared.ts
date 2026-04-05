import type { SubagentRunRecord } from "../../../agents/subagent-registry.types.js";
import type { HandleCommandsParams } from "../commands-types.js";

export {
  COMMAND,
  COMMAND_AGENTS,
  COMMAND_FOCUS,
  COMMAND_KILL,
  COMMAND_STEER,
  COMMAND_TELL,
  COMMAND_UNFOCUS,
  resolveHandledPrefix,
  resolveRequesterSessionKey,
  resolveSubagentsAction,
  stopWithText,
  resolveCommandSubagentController,
  type ResolvedSubagentController,
  type SubagentsAction,
} from "./core.js";

export {
  buildSubagentsHelp,
  formatTimestampWithAge,
  loadSubagentSessionEntry,
  resolveDisplayStatus,
  resolveSubagentEntryForToken,
  type SessionStoreCache,
} from "../commands-subagents-read.js";

export {
  extractMessageText,
  formatLogLines,
  stripToolMessages,
  type ChatMessage,
} from "../commands-subagents-text.js";

export {
  resolveFocusTargetSession,
  type FocusTargetResolution,
} from "./focus-target.js";

export {
  resolveChannelAccountId,
  resolveCommandSurfaceChannel,
} from "../channel-context.js";

export const RECENT_WINDOW_MINUTES = 30;
export const STEER_ABORT_SETTLE_TIMEOUT_MS = 5_000;

export type SubagentsCommandParams = HandleCommandsParams;

export type SubagentsCommandContext = {
  params: SubagentsCommandParams;
  handledPrefix: string;
  requesterKey: string;
  runs: SubagentRunRecord[];
  restTokens: string[];
};
