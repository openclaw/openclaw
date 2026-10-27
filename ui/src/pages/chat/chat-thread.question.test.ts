/* @vitest-environment jsdom */

import { afterEach, expect, it } from "vitest";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createComposerQuestionPrompt } from "./chat-composer.test-support.ts";
import { message } from "./chat-thread-fixtures.test-support.ts";
import { buildItems } from "./chat-thread.test-support.ts";
import { resetChatThreadState } from "./chat-thread.ts";
import { coalesceStreamRuns } from "./chat-turn-presentation.ts";
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
    runWorking: runActive,
    questionPrompts: [question],
  });
}

afterEach(() => resetChatThreadState());

it("keeps a pending question out of the message stream", () => {
  const result = coalesceStreamRuns(items(prompt("pending"), true));
  const run = result.find((item) => item.kind === "stream-run");

  expect(run).toMatchObject({ kind: "stream-run", parts: [{ kind: "reading-indicator" }] });
});

it("keeps a terminal question between the surrounding transcript turns", () => {
  const result = items(prompt("answered"), false, [
    message("user", "First prompt", 900, { __openclaw: { idempotencyKey: "run-question:user" } }),
    message("assistant", "First reply", 1_300),
    message("user", "Next prompt", 2_000),
  ]);

  expect(result.map((item) => (item.kind === "group" ? item.role : item.kind))).toEqual([
    "user",
    "question",
    "assistant",
    "user",
  ]);
});

it.each([
  ["answered", "Yes"],
  ["cancelled", "Skipped"],
  ["expired", "Expired"],
  ["unavailable", "Unavailable"],
] as const)("keeps the full question with its %s outcome", (status, outcome) => {
  const question = prompt(status);
  question.answeredElsewhere = true;
  question.answers = { answers: { choice: ["Yes"] } };
  const container = document.createElement("div");

  mountSolid(ChatQuestionSummary, { prompt: question }, container);
  expect(
    container.querySelector(".chat-question-summary")?.textContent?.replace(/\s+/g, " "),
  ).toContain(`Which format? Choice: ${outcome}`);
  expect(container.querySelector(".chat-question-panel")).toBeNull();
});

it("never echoes a secret answer in the terminal transcript summary", () => {
  const answered = prompt("answered");
  answered.questions = [
    {
      questionId: "api_key",
      header: "API key",
      question: "Provide the deployment API key",
      options: [],
      isSecret: true,
      secretStore: { name: "FAKE_DEPLOYMENT_API_KEY", kind: "secret" },
    },
  ];
  answered.answeredElsewhere = true;
  answered.answers = { answers: { api_key: ["fake-secret-never-render"] } };
  const container = document.createElement("div");

  mountSolid(ChatQuestionSummary, { prompt: answered }, container);

  expect(container.textContent?.replace(/\s+/g, " ")).toContain("API key: Answered");
  expect(container.textContent).toContain("Provide the deployment API key");
  expect(container.textContent).not.toContain("fake-secret-never-render");
  expect(container.innerHTML).not.toContain("fake-secret-never-render");
});
