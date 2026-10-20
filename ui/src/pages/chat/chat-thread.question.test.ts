/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createComposerQuestionPrompt } from "./chat-composer.test-support.ts";
import { buildItems } from "./chat-thread.test-support.ts";
import { coalesceStreamRuns, resetChatThreadState } from "./chat-thread.ts";
import { ChatQuestionSummary } from "./components/chat-question-summary.tsx";

function prompt(status: QuestionPrompt["status"]): QuestionPrompt {
  return {
    ...createComposerQuestionPrompt("question-1", "Which format?"),
    sessionKey: "agent:main:main",
    runId: "run-question",
    expiresAtMs: 60_000,
    status,
  };
}

function items(question: QuestionPrompt, runActive: boolean, messages: unknown[] = []) {
  return buildItems({
    paneId: `pane-${question.status}`,
    sessionKey: "agent:main:main",
    messages,
    runId: undefined,
    runWorking: runActive,
    questionPrompts: [question],
  });
}
function summary(status: QuestionPrompt["status"], overrides: Partial<QuestionPrompt> = {}) {
  return mountSolid(ChatQuestionSummary, {
    prompt: { ...prompt(status), answeredElsewhere: true, ...overrides },
  }).container;
}

afterEach(() => resetChatThreadState());

it("keeps a pending question out of the message stream", () => {
  const result = coalesceStreamRuns(items(prompt("pending"), true));
  const run = result.find((item) => item.kind === "stream-run");

  expect(run).toMatchObject({ kind: "stream-run", parts: [{ kind: "reading-indicator" }] });
});

it("keeps a terminal question between the surrounding transcript turns", () => {
  const result = items(prompt("answered"), false, [
    {
      role: "user",
      content: "First prompt",
      timestamp: 900,
      __openclaw: { idempotencyKey: "run-question:user" },
    },
    { role: "assistant", content: "First reply", timestamp: 1_300 },
    { role: "user", content: "Next prompt", timestamp: 2_000 },
  ]);

  const roles = result.map((item) => (item.kind === "group" ? item.role : item.kind));
  expect(roles).toEqual(["user", "question", "assistant", "user"]);
});

it.each([
  ["answered", "Yes"],
  ["cancelled", "Skipped"],
  ["expired", "Expired"],
  ["unavailable", "Unavailable"],
] as const)("keeps the full question with its %s outcome", (status, outcome) => {
  const container = summary(status, { answers: { answers: { choice: ["Yes"] } } });
  expect(
    container.querySelector(".chat-question-summary")?.textContent?.replace(/\s+/g, " "),
  ).toContain(`Which format? Choice: ${outcome}`);
  expect(container.querySelector(".chat-question-panel")).toBeNull();
});

it("never echoes a secret answer in the terminal transcript summary", () => {
  const container = summary("answered", {
    questions: [
      {
        questionId: "api_key",
        header: "API key",
        question: "Provide the deployment API key",
        options: [],
        isSecret: true,
        secretStore: { name: "FAKE_DEPLOYMENT_API_KEY", kind: "secret" },
      },
    ],
    answers: { answers: { api_key: ["fake-secret-never-render"] } },
  });

  expect(container.textContent?.replace(/\s+/g, " ")).toContain("API key: Answered");
  expect(container.textContent).toContain("Provide the deployment API key");
  expect(container.textContent).not.toContain("fake-secret-never-render");
  expect(container.innerHTML).not.toContain("fake-secret-never-render");
});
