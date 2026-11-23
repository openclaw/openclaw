import { performance } from "node:perf_hooks";
import { GATEWAY_CLIENT_NAMES } from "../../../packages/gateway-protocol/src/client-info.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { QUESTION_COMPOSER_REPLACEMENT } from "../../shared/question-composer-replacement.js";
import { canSelectQuestion } from "../question-access.js";
import {
  prepareQuestionAuthorization,
  withPreparedQuestionSessions,
} from "../question-session-access.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** The composer can answer one ordinary question; other prompts yield to the new instruction. */
export function captureChatSendQuestionReplacement(
  options: GatewayRequestHandlerOptions | undefined,
  request: NormalizedChatSendRequest,
  sessionKey: string,
  runId: string | undefined,
  isCommand: boolean,
) {
  if (
    !options ||
    !runId ||
    isCommand ||
    request.systemInputProvenance ||
    request.turnKind !== "main" ||
    request.reconnectResumeRequested ||
    request.p.queueMode !== "steer" ||
    !request.rawMessage.trim() ||
    request.clientInfo?.id !== GATEWAY_CLIENT_NAMES.CONTROL_UI
  ) {
    return undefined;
  }
  const manager = options.context.questionManager;
  const run = getAgentRunContext(runId)?.delegatedAuthority?.operationalRunInstance;
  if (!manager || !run) {
    return undefined;
  }
  const receivedAtMs = performance.timeOrigin + request.chatSendReceivedAtMs;
  const [question] = manager.list(
    (record) =>
      record.sessionKey === sessionKey &&
      record.runId === runId &&
      record.createdAtMs <= receivedAtMs &&
      (record.questions.length > 1 ||
        record.questions.some(
          (item) =>
            item.isSecret ||
            item.secretStore ||
            (item.questionId === "required_action" && !item.isOther),
        )) &&
      canSelectQuestion(manager, record.id, options.client),
  );
  if (!question) {
    return undefined;
  }
  const observation = manager.observe(question.id, question);
  // Host decisions and MCP forms keep their own input/consent contracts.
  if (
    !observation ||
    observation.authorizeClient ||
    observation.requesterRun?.instanceId !== run.instanceId ||
    question.questions.some((item) => item.presentation === "form")
  ) {
    return undefined;
  }
  const authorization = prepareQuestionAuthorization(options, observation, question.id, "mutate");
  return async (assertCurrent: () => void) => {
    await withPreparedQuestionSessions(
      options,
      [authorization.target],
      ([prepared]) => {
        assertCurrent();
        authorization.assertCurrent();
        if (!authorization.authorize(prepared) && manager.get(question.id) === question) {
          manager.cancel(question.id, QUESTION_COMPOSER_REPLACEMENT);
        }
      },
      { assertCurrent: authorization.assertCurrent },
    );
  };
}
