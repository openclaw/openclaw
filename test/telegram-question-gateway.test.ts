import { expectDefined } from "@openclaw/normalization-core";
// Root-owned integration may combine public plugin surfaces with Gateway-owned runtime.
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { telegramOutbound } from "../extensions/telegram/api.js";
import { compileStructuredInputUrl } from "../src/agents/harness/structured-input.js";
import { buildAgentHarnessQuestionPromptPayload } from "../src/agents/harness/user-input-bridge.js";
import { QuestionManager } from "../src/gateway/question-manager.js";
import { createQuestionHandlers } from "../src/gateway/server-methods/question.js";
import { createSecretStoreWriteService } from "../src/gateway/server-methods/secrets.js";
import { callGatewayHandler } from "../src/gateway/server-methods/skills.test-helpers.js";
import { createTestGatewayScheduler } from "../src/test-utils/gateway-scheduler-clock.js";

type QuestionGatewayCall = { method: string; params?: Record<string, unknown> };
const questionId = "ask_0123456789abcdef0123456789abcdef";
const callback = (index: number) => `tgq1:${questionId}:${index}`;
type TelegramPresentation = {
  buttons?: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
};

async function renderButtons(payload: ReturnType<typeof buildAgentHarnessQuestionPromptPayload>) {
  const rendered = await telegramOutbound.renderPresentation?.({
    payload,
    presentation: expectDefined(payload.presentation, "portable question presentation"),
    ctx: { cfg: {}, to: "42", text: payload.text, payload },
  });
  return (rendered?.channelData?.telegram as TelegramPresentation | undefined)?.buttons;
}

const questionGatewayTransport = vi.hoisted(() => ({
  dispatch: undefined as ((request: QuestionGatewayCall) => Promise<unknown>) | undefined,
}));

vi.mock("../src/gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gateway/call.js")>();
  return {
    ...actual,
    callGateway: async (request: QuestionGatewayCall) => {
      if (!questionGatewayTransport.dispatch) {
        throw new Error("expected the in-process question Gateway transport");
      }
      return await questionGatewayTransport.dispatch(request);
    },
  };
});

afterEach(() => {
  questionGatewayTransport.dispatch = undefined;
});

it("opens an external step with a URL button separate from completion callbacks", async () => {
  const url = "https://example.test/connect";
  const input = compileStructuredInputUrl({
    url,
    elicitationId: "connect",
    message: "Sign in to continue",
    fallbackMessage: "External step",
    protocolName: "MCP",
  });
  if (input.kind !== "ready" || input.plan.kind !== "url") {
    throw new Error("expected a URL question");
  }
  const payload = buildAgentHarnessQuestionPromptPayload({
    questionId,
    questions: [input.plan.question],
  });
  expect((await renderButtons(payload))?.flat()).toEqual([
    { text: "Open link", url },
    { text: "I've completed this step", callback_data: callback(0) },
    { text: "Decline", callback_data: callback(1) },
  ]);
  expect(payload.text).toContain(url);
});

it("resolves canonical option C when rendered option A repeats across blocks", async () => {
  const scheduler = createTestGatewayScheduler();
  const manager = new QuestionManager(scheduler);
  const handlers = createQuestionHandlers(
    manager,
    createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
    scheduler,
  );
  const gatewayCalls: string[] = [];
  const dispatch = async ({ method, params }: QuestionGatewayCall): Promise<unknown> => {
    gatewayCalls.push(method);
    const result = await callGatewayHandler(handlers, method, params ?? {}, {
      context: { broadcast: () => undefined },
    });
    expect(result.ok, `question Gateway method ${method}`).toBe(true);
    return result.response;
  };
  questionGatewayTransport.dispatch = dispatch;

  try {
    const optionValues = ["A", "B", "C"];
    const question = {
      header: "Destination",
      question: "Where next?",
      options: optionValues.map((label) => ({ label })),
      multiSelect: false,
      isOther: false,
      isSecret: false,
    };
    await dispatch({
      method: "question.request",
      params: {
        id: questionId,
        questions: [{ questionId: "destination", ...question }],
        timeoutMs: 15_000,
      },
    });
    expect(manager.get(questionId)?.questions[0]?.options).toEqual(
      optionValues.map((label) => ({ label })),
    );

    const questionButton = (optionValue: string) => ({
      label: optionValue,
      action: { type: "question" as const, questionId, optionValue },
    });
    const presentation = {
      blocks: [
        { type: "buttons" as const, buttons: [questionButton("C"), questionButton("A")] },
        { type: "buttons" as const, buttons: [questionButton("A"), questionButton("B")] },
      ],
    };
    const payload = buildAgentHarnessQuestionPromptPayload({
      questionId,
      questions: [{ id: "destination", ...question }],
      options: { presentation },
    });
    expect(payload.channelData.askUser).toEqual({ questionId, optionValues });
    const rows = await renderButtons(payload);
    expect(rows?.map((row) => row.map((button) => button.callback_data))).toEqual([
      [callback(2)],
      [callback(0)],
      [callback(0)],
      [callback(1)],
    ]);

    const callbackData = rows?.[0]?.[0]?.callback_data;
    if (!callbackData) {
      throw new Error("expected canonical Telegram option C callback data");
    }
    const optionIndex = Number(callbackData.slice(`tgq1:${questionId}:`.length));
    expect(optionIndex).toBe(2);

    await expect(
      questionGatewayRuntime.resolveOption({ cfg: {}, questionId, optionIndex, senderId: "42" }),
    ).resolves.toEqual({ status: "answered", questionId: "destination", optionValue: "C" });
    expect(gatewayCalls).toEqual(["question.request", "question.get", "question.resolve"]);
    expect(manager.get(questionId)).toMatchObject({
      status: "answered",
      answers: { answers: { destination: ["C"] } },
      resolvedBy: "42",
    });
  } finally {
    manager.close();
    await manager.drain();
    await scheduler.stop();
  }
});
