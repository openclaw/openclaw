import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { HandleCommandsParams } from "./commands-types.js";

export {
  ACTIONS,
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
  type SubagentsAction,
} from "./commands-subagents/shared.js";

export type SubagentsCommandContext = {
  params: HandleCommandsParams;
  handledPrefix: string;
  requesterKey: string;
  runs: SubagentRunRecord[];
  restTokens: string[];
};
