import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  validateSkillsProposalHistoryScanParams,
  validateSkillsProposalHistoryStatusParams,
} from "../../../packages/gateway-protocol/src/schema/skill-history.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const HISTORY_SCAN_RETIRED_MESSAGE =
  "Historical batch scans are retired. Start a learning session from Workshop to review past conversations.";

export const skillProposalHistoryHandlers: GatewayRequestHandlers = {
  "skills.proposals.historyStatus": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSkillsProposalHistoryStatusParams,
        "skills.proposals.historyStatus",
        respond,
      )
    ) {
      return;
    }
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, HISTORY_SCAN_RETIRED_MESSAGE));
  },
  "skills.proposals.historyScan": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSkillsProposalHistoryScanParams,
        "skills.proposals.historyScan",
        respond,
      )
    ) {
      return;
    }
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, HISTORY_SCAN_RETIRED_MESSAGE));
  },
};
