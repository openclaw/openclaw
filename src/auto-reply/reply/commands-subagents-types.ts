import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import type { HandleCommandsParams } from "./commands-types.js";

export type SubagentsRunsContext = {
  params: HandleCommandsParams;
  runs: SubagentRunRecord[];
  restTokens: string[];
};

export type SubagentsRequesterContext = SubagentsRunsContext & {
  requesterKey: string;
};

export type SubagentsCommandContext = SubagentsRequesterContext & {
  handledPrefix: string;
};
