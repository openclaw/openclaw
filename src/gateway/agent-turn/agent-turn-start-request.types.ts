import type { ReplyExpectation } from "../../agents/reply-completion.js";
import type { SessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { SessionControllerInput } from "../../sessions/session-controller.contracts.js";
import type { AgentRequestPreflight } from "./agent-request-preflight.js";
import type { RequesterSettleWakeReplay } from "./internal-facade.types.js";
import type { AgentTurnIo, AgentTurnPrincipal } from "./types.js";

export type AgentTurnStartRequest = {
  controllerInput?: SessionControllerInput;
  privateCompletion?: true;
  /** Trusted input-owner policy; not accepted from the wire request. */
  replyExpectation?: ReplyExpectation;
  settleWakeReplay?: RequesterSettleWakeReplay;
  assertAdmissionCurrent?: () => void;
  executionSource?: SessionSourceAssertion;
  assertInputCommitAllowed?: () => void;
  hasCurrentClientAuthority?: () => boolean;
  preflight: AgentRequestPreflight;
  principal: AgentTurnPrincipal | null;
  io: AgentTurnIo;
  onRunObserved?: (runId: string) => void;
};
