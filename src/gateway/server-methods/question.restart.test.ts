import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createGatewayQuestionStore } from "../question-store.js";
import * as support from "./question.test-support.js";

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
