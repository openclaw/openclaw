import type {
  AsyncSessionSourceCheck,
  SessionSourceCheck,
} from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";

export type FastAbortRequestParams = {
  ctx: FinalizedRuntimeMsgContext;
  cfg: OpenClawConfig;
  isCommandTargetCurrent?: SessionSourceCheck | AsyncSessionSourceCheck;
  onAbortRequest?: () => void;
};

export type FastAbortResult = {
  handled: boolean;
  aborted: boolean;
  rejectionReason?: "finalizing";
  localModelMayStillBeFinishing?: true;
  stoppedSubagents?: number;
  failedSubagents?: number;
};

export type FastAbortResolver = (params: FastAbortRequestParams) => Promise<FastAbortResult>;

export type FormatAbortReplyText = (
  stoppedSubagents?: number,
  rejectionReason?: "finalizing",
  failedSubagents?: number,
  localModelMayStillBeFinishing?: boolean,
) => string;
