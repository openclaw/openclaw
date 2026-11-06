import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  formatAskUserAnsweredText,
  formatRestartedQuestionResult,
} from "../../agents/tools/ask-user-tool-normalization.js";
import { enqueueSessionEventForHost } from "../../auto-reply/reply/session-event-handoff.js";
import { registerAgentRunContext } from "../../infra/agent-run-registry.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { RestoredQuestion } from "../question-manager.js";
import { resumeRestoredQuestion } from "../question-resume.js";
import { createGatewayQuestionStore } from "../question-store.js";
import * as support from "./question.test-support.js";
import type { GatewayRequestContext } from "./types.js";

// mock-isolation: the continuation's session principal is outside this boundary.
vi.mock("../session-system-turn-authority.js", () => ({
  prepareSessionSystemTurnAuthority: async () => undefined,
}));
// mock-isolation: records the admitted session event instead of starting an agent turn.
vi.mock("../../auto-reply/reply/session-event-handoff.js", () => ({
  captureSessionEventTargetForHost: async () => ({ sessionId: "asking-session" }),
  enqueueSessionEventForHost: vi.fn(() => ({
    accepted: Promise.resolve({ ok: true }),
    settled: new Promise(() => {}),
  })),
}));

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "empty", label: "question-restart" });
});
afterEach(() => state.cleanup());
support.installQuestionTestHooks(() => createGatewayQuestionStore({ env: state.env }));

it("reports questions dropped by a Gateway restart as expired", async () => {
  const requested = await support.callQuestionRpc("question.request", support.requestParams, {
    client: support.adminRequestClient,
  });
  const ids = [(requested[1] as { id: string }).id, await support.requestSecretQuestion()];
  await support.restartQuestionManager();
  for (const id of ids) {
    const [ok, payload] = await support.callQuestionRpc("question.get", { id });
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      question: { id, status: "expired", resolvedBy: "gateway-restart" },
    });
  }
});

it("continues the asking session once when a restored question is answered", async () => {
  const { runId, sessionKey, agentId } = support.requestParams;
  registerAgentRunContext(runId, { sessionKey, agentId, sessionId: "asking-session" });
  const requested = await support.callQuestionRpc("question.request", support.requestParams, {
    client: support.adminRequestClient,
  });
  const id = (requested[1] as { id: string }).id;
  const resumed: Promise<void>[] = [];
  const continueRestored = (question: RestoredQuestion) => {
    resumed.push(resumeRestoredQuestion({} as GatewayRequestContext, question));
  };
  await support.restartQuestionManager(continueRestored);
  const listed = await support.callQuestionRpc("question.list", {});
  expect(listed[1]).toMatchObject({ questions: [{ id, status: "pending" }] });
  const answer = { id, answers: { answers: { destination: ["Paris"] } } };
  expect((await support.callQuestionRpc("question.resolve", answer))[0]).toBe(true);
  await Promise.all(resumed.splice(0));
  const enqueue = vi.mocked(enqueueSessionEventForHost);
  const answered = support.manager.get(id)!;
  expect(enqueue.mock.calls).toEqual([
    [
      formatRestartedQuestionResult(answered),
      expect.objectContaining({ source: "tool_handoff", contextKey: `question:${id}` }),
    ],
  ]);
  expect(formatRestartedQuestionResult(answered).length).toBeLessThanOrEqual(
    formatAskUserAnsweredText(answered.questions, answered.answers!).length,
  );
  expect((await support.callQuestionRpc("question.resolve", answer))[2]).toMatchObject({
    details: { reason: "QUESTION_ALREADY_TERMINAL" },
  });
  // A restart before adoption admits the committed answer once more; adoption retires it.
  await support.restartQuestionManager(continueRestored);
  await Promise.all(resumed.splice(0));
  expect(enqueue).toHaveBeenCalledTimes(2);
  await Promise.resolve(enqueue.mock.calls[1]?.[1].onAdopted?.());
  await support.restartQuestionManager(continueRestored);
  expect(resumed).toEqual([]);
  expect(support.manager.get(id)).toBeNull();
});
