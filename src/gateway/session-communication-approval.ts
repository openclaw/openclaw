import {
  validateQuestionRequestParams,
  type Question,
} from "../../packages/gateway-protocol/src/index.js";
import type {
  CommunicationApproval,
  CommunicationEndpoint,
} from "../sessions/communication-admission.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { authorizeCurrentOperatorRoleScopes } from "./operator-role-policy.js";
import type { QuestionManager } from "./question-manager.js";
import { questionShapeError } from "./question-validation.js";
import type { GatewayRequestContext, GatewayClient } from "./server-methods/types.js";
import { canManageSessionSharing, resolveSessionSharingRole } from "./session-sharing-policy.js";

/** An agent's inherited admin/run authority is never a human's decision. */
function canApproveSessionCommunication(params: {
  client: GatewayClient | null;
  endpoint: CommunicationEndpoint;
  context: Pick<GatewayRequestContext, "getRuntimeConfig">;
}): boolean {
  const { client, endpoint } = params;
  if (
    !client ||
    (client.connect.role ?? "operator") !== "operator" ||
    client.invalidated ||
    client.internal?.syntheticClient ||
    client.internal?.agentRuntimeIdentity ||
    client.internal?.agentToolCaller ||
    client.internal?.operatorRunAuthority ||
    client.internal?.approvalRuntime
  ) {
    return false;
  }
  try {
    client.internal?.operatorAccessAuthority?.assertCurrent();
    if (authorizeCurrentOperatorRoleScopes(client, params.context.getRuntimeConfig())) {
      return false;
    }
    const scopes = client.connect.scopes ?? [];
    if (!operatorScopeSatisfied("operator.sessions.write", scopes)) {
      return false;
    }
    if (!endpoint.entry) {
      return scopes.includes("operator.admin");
    }
    return canManageSessionSharing(
      resolveSessionSharingRole({
        cfg: params.context.getRuntimeConfig(),
        client,
        includeMembership: false,
        target: {
          agentId: endpoint.agentId,
          canonicalKey: endpoint.sessionKey,
          storePath: endpoint.storePath,
          storeKey: endpoint.sessionKey,
          storeKeys: [endpoint.sessionKey],
          entry: endpoint.entry,
        },
      }),
    );
  } catch {
    return false;
  }
}

/** Reuses transient questions; the manager owns expiry, cancellation, and one winning answer. */
export async function requestSessionCommunicationApproval(params: {
  context: GatewayRequestContext;
  approval: CommunicationApproval;
  source: CommunicationEndpoint;
  target: CommunicationEndpoint;
  message: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
  registerHumanInputWait?: Parameters<QuestionManager["request"]>[0]["registerHumanInputWait"];
  requesterRun?: Parameters<QuestionManager["request"]>[0]["requesterRun"];
}): Promise<void> {
  const manager = params.context.questionManager;
  if (!manager) {
    throw new Error("Human communication approval requires the admitted Gateway question owner.");
  }
  params.assertCurrent();
  params.signal?.throwIfAborted();
  const authorizeClient = (client: GatewayClient | null) =>
    canApproveSessionCommunication({
      client,
      endpoint: params.approval.endpoint,
      context: params.context,
    });
  const isRequesterActive = () => {
    try {
      params.assertCurrent();
      params.signal?.throwIfAborted();
      return true;
    } catch {
      return false;
    }
  };
  const questions: Question[] = [
    {
      questionId: "communication",
      header: params.approval.direction === "send" ? "Send message" : "Receive peer",
      question:
        "Allow this one peer message?\nFrom: " +
        params.source.sessionKey +
        "\nTo: " +
        params.target.sessionKey +
        "\n\n" +
        params.message,
      options: [{ label: "Allow once" }, { label: "Deny" }],
      multiSelect: false,
      isOther: false,
      isSecret: false,
    },
  ];
  const request = {
    questions,
    sessionKey: params.approval.endpoint.sessionKey,
    agentId: params.approval.endpoint.agentId,
  };
  if (
    !validateQuestionRequestParams(request) ||
    questionShapeError(questions, { allowPlainSecretQuestions: false, validateUrls: true })
  ) {
    throw new Error(
      "The exact communication approval cannot be displayed as a valid question; no message was sent.",
    );
  }
  const question = manager.request({
    agentId: params.approval.endpoint.agentId,
    sessionKey: params.approval.endpoint.sessionKey,
    timeoutMs: 15 * 60 * 1000,
    requesterRun: params.requesterRun,
    registerHumanInputWait: params.registerHumanInputWait,
    authorizeClient,
    isRequesterActive,
    questions,
    onResolved: (event) => {
      params.context.broadcast("question.resolved", event, { questionRecipient: authorizeClient });
    },
  });
  const cancel = () => {
    if (manager.get(question.id)?.status === "pending") {
      manager.cancel(question.id, "communication-cancelled");
    }
  };
  params.signal?.addEventListener("abort", cancel, { once: true });
  try {
    params.context.broadcast("question.requested", question, {
      questionRecipient: authorizeClient,
    });
    const answer = await manager.waitAnswer(question.id);
    params.assertCurrent();
    params.signal?.throwIfAborted();
    if (
      answer.status !== "answered" ||
      answer.answers.answers.communication?.length !== 1 ||
      answer.answers.answers.communication[0] !== "Allow once"
    ) {
      throw new Error("Peer message was not authorized; no message was delivered.");
    }
  } finally {
    params.signal?.removeEventListener("abort", cancel);
    cancel();
  }
}
