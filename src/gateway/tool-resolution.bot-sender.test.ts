/** A loopback run's bot sender reaches the ask_user tool it builds, which sends questions to the owner. */
import { afterEach, expect, it, vi } from "vitest";
import * as questionDispatch from "../agents/harness/gateway-question-dispatch.js";
import { cancelAskUserPromptDelivery } from "../agents/tools/ask-user-tool.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { QuestionManager } from "./question-manager.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

const cfg: OpenClawConfig = { plugins: { enabled: false }, tools: { allow: ["ask_user"] } };
const args = {
  questions: [
    {
      id: "target",
      header: "Target",
      question: "Where next?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
};

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

async function askFromLoopback(senderIsBot: boolean, toolCallId: string) {
  const scheduler = createTestGatewayScheduler();
  const questions = new QuestionManager(scheduler);
  const dispatch = questionDispatch.resolveAgentQuestionGatewayCall(
    async (method, _opts, params) => {
      if (method === "question.request") {
        return { id: questions.request(params as Parameters<QuestionManager["request"]>[0]).id };
      }
      if (method === "question.waitAnswer") {
        return await questions.waitAnswer((params as { id: string }).id);
      }
      if (method === "question.list") {
        return { questions: questions.list() };
      }
      if (method === "question.resolve") {
        return questions.cancel((params as { id: string }).id);
      }
      throw new Error(`unexpected method ${method}`);
    },
  );
  vi.spyOn(questionDispatch, "resolveAgentQuestionGatewayCall").mockReturnValue(dispatch);
  const { tools } = await resolveGatewayScopedTools({
    cfg,
    sessionKey: "agent:main:main",
    surface: "loopback",
    messageProvider: "webchat",
    senderIsOwner: true,
    ...(senderIsBot ? { senderIsBot: true as const } : {}),
  });
  const askUser = tools.find((tool) => tool.name === "ask_user");
  expect(askUser, "the loopback catalog offers ask_user").toBeDefined();
  const pending = askUser!.execute(toolCallId, args);
  const cleanup = async () => {
    cancelAskUserPromptDelivery(toolCallId, "agent:main:main");
    for (const question of questions.list()) {
      questions.cancel(question.id);
    }
    await pending.catch(() => undefined);
    questions.close();
    await questions.drain();
    await scheduler.stop();
  };
  return { pending, questions, cleanup };
}

it("sends a loopback bot sender's question to the owner, cancelling it when the owner cannot answer", async () => {
  setRuntimeConfigSnapshot(cfg);
  const ask = await askFromLoopback(true, "loopback-bot");

  await expect(ask.pending).rejects.toThrow("prompt delivery failed");
  await ask.cleanup();
});

it("keeps a loopback human sender's question waiting in its own conversation", async () => {
  setRuntimeConfigSnapshot(cfg);
  const ask = await askFromLoopback(false, "loopback-human");

  await vi.waitFor(() => expect(ask.questions.list()).toHaveLength(1));
  expect(ask.questions.list()[0]?.status).toBe("pending");
  await ask.cleanup();
});
