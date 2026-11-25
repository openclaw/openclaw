import { performance } from "node:perf_hooks";
import { expect, it, onTestFinished, vi } from "vitest";
import type { Question } from "../../../packages/gateway-protocol/src/schema/questions.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { decideTurnGrant } from "../operator-admission.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import { captureChatSendQuestionReplacement } from "./chat-send-question-replacement.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import {
  installQuestionTestHooks,
  manager,
  requesterAuthority,
  requestParams,
} from "./question.test-support.js";

installQuestionTestHooks();

it.each([
  "multiple",
  "manual",
  "secret",
  "single",
  "child",
  "queued",
  "command",
  "form",
  "foreign-requester",
  "released-requester",
  "other-requester-first",
  "without-display-run-id",
  "reconnect-resume",
  "native-app",
  "system-input",
  "read-only",
] as const)("keeps composer replacement at the question owner: %s", async (kind) => {
  const ordinary = requestParams.questions[0]!;
  const questions: Question[] =
    kind === "manual"
      ? [
          {
            ...ordinary,
            questionId: "required_action",
            isOther: false,
            options: [{ label: "Ready to recheck" }],
          },
        ]
      : kind === "secret"
        ? [{ ...ordinary, isSecret: true, secretStore: { name: "SAMPLE_KEY", kind: "secret" } }]
        : kind === "single"
          ? [ordinary]
          : [
              ordinary,
              {
                ...ordinary,
                questionId: "second",
                ...(kind === "form" ? { presentation: "form" } : {}),
              },
            ];
  const otherAuthority =
    kind === "foreign-requester" || kind === "other-requester-first"
      ? claimAgentRunDelegatedAuthority({ instanceId: "other-instance", runId: "other-run" })
      : undefined;
  if (otherAuthority) {
    onTestFinished(() => {
      releaseAgentRunDelegatedAuthority(otherAuthority);
    });
  }
  const otherQuestion =
    kind === "other-requester-first" && otherAuthority
      ? manager.request({
          ...requestParams,
          id: "before-current",
          questions,
          timeoutMs: 60_000,
          requesterRun: otherAuthority.operationalRunInstance,
        })
      : undefined;
  const { id } = manager.request({
    ...requestParams,
    id: "current",
    ...(kind === "without-display-run-id" ? { runId: undefined } : {}),
    questions,
    timeoutMs: 60_000,
    requesterRun: (kind === "foreign-requester" && otherAuthority
      ? otherAuthority
      : requesterAuthority
    ).operationalRunInstance,
  });
  if (kind === "released-requester") {
    releaseAgentRunDelegatedAuthority(requesterAuthority);
  }
  const client = { connect: gatewayConnect(["operator.admin"]), connId: "composer" };
  const request: NormalizedChatSendRequest = {
    p: {
      sessionKey: requestParams.sessionKey,
      message: "Use another approach",
      idempotencyKey: "replacement",
      queueMode: kind === "queued" ? "followup" : "steer",
    },
    rawMessage: "Use another approach",
    inboundMessage: "Use another approach",
    chatSendReceivedAtMs: performance.now(),
    clientInfo:
      kind === "native-app"
        ? { ...client.connect.client, id: "openclaw-ios" }
        : client.connect.client,
    ...(kind === "system-input"
      ? { systemInputProvenance: { kind: "internal_system" as const, sourceTool: "test" } }
      : {}),
    supportsTaskSuggestions: false,
    suppressCommandInterpretation: false,
    stopCommand: false,
    turnKind: "main",
    normalizedAttachments: [],
    reconnectResumeRequested: kind === "reconnect-resume",
  };
  const cfg = {};
  const replace = captureChatSendQuestionReplacement(
    {
      req: { type: "req", id: "replacement", method: "chat.send", params: request.p },
      params: request.p,
      client,
      respond: vi.fn(),
      isWebchatConnect: () => true,
      context: createDirectChatContext({ questionManager: manager, getRuntimeConfig: () => cfg }),
    },
    request,
    kind === "child" ? "agent:main:parent" : requestParams.sessionKey,
    requestParams.runId,
    kind === "command",
    decideTurnGrant(kind === "read-only" ? ["operator.read"] : ["operator.admin"]),
  );
  const replaced =
    kind === "multiple" ||
    kind === "manual" ||
    kind === "secret" ||
    kind === "other-requester-first" ||
    kind === "without-display-run-id" ||
    kind === "reconnect-resume" ||
    // One grant answers every client and start: same person, same answer.
    kind === "native-app" ||
    kind === "system-input";
  expect(Boolean(replace)).toBe(replaced);
  await replace?.(() => {});
  expect(manager.get(id)).toMatchObject(
    replaced
      ? { status: "cancelled", resolvedBy: "chat-composer-replacement" }
      : { status: "pending" },
  );
  if (otherQuestion) {
    expect(manager.get(otherQuestion.id)?.status).toBe("pending");
  }
});
