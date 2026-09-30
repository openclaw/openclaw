import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  validateSkillsProposalHistoryScanParams,
  validateSkillsProposalHistoryStatusParams,
} from "../../../packages/gateway-protocol/src/schema/skill-history.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

const HISTORY_SCAN_RETIRED_MESSAGE =
  "Historical batch scans are retired. Start a learning session from Workshop to review past conversations.";

const respondRetiredHistory: GatewayRequestHandler = ({ respond }) => {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, HISTORY_SCAN_RETIRED_MESSAGE));
};

export const skillProposalHistoryHandlers: GatewayRequestHandlers = {
  "skills.proposals.historyStatus": defineValidatedGatewayHandler(
    "skills.proposals.historyStatus",
    validateSkillsProposalHistoryStatusParams,
    respondRetiredHistory,
  ),
  "skills.proposals.historyScan": defineValidatedGatewayHandler(
    "skills.proposals.historyScan",
    validateSkillsProposalHistoryScanParams,
    respondRetiredHistory,
  ),
};
