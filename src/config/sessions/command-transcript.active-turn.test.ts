import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { markReplyOperationExecutionStarted } from "../../sessions/session-controller.state.js";
import { testing as controllerTesting } from "../../sessions/session-controller.test-support.js";
import { recordDeliveredCommandExchange } from "./command-transcript.js";

afterEach(() => controllerTesting.resetSessionControllerForTest());

it("records a mid-turn exchange as context after the active turn settles", async () => {
  const state = await createOpenClawTestState({ label: "command-active-turn", applyEnv: false });
  onTestFinished(() => state.cleanup());
  const storePath = state.path("sessions.json");
  const target = { agentId: "main", storePath, sessionKey: "agent:main:telegram:group:g1" };
  const sessionId = "busy-session";
  await upsertSessionEntry({ ...target, entry: { sessionId, updatedAt: 1 } });
  const read = async () =>
    (await readVisibleSessionTranscriptMessageEntries({ ...target, sessionId })).map(
      (entry) => entry.message,
    );
  const [started, finish] = [createDeferred(), createDeferred()];
  const turn = withSessionTurn(
    { sessionKey: target.sessionKey, sessionId, storePath, agentId: "main" },
    async (operation) => {
      markReplyOperationExecutionStarted(operation!);
      started.resolve();
      await finish.promise;
    },
  );
  await started.promise;

  await expect(
    recordDeliveredCommandExchange({
      ...target,
      config: { session: { store: storePath } },
      expectedSessionId: sessionId,
      commandText: "/think",
      commandId: "telegram:default:g1:1",
      replyId: "menu",
      replyText: "Choose level for /think.",
    }),
  ).resolves.toMatchObject({ ok: false, reason: "deferred until the active turn settles" });
  // The running turn's model-context fence stays untouched while it works.
  expect(await read()).toEqual([]);

  finish.resolve();
  await turn;
  await vi.waitFor(async () => expect(await read()).toHaveLength(2), { timeout: 15_000 });
  const messages = await read();
  expect(messages).toEqual([
    expect.objectContaining({ role: "user", content: [{ type: "text", text: "/think" }] }),
    expect.objectContaining({
      role: "assistant",
      content: [{ type: "text", text: "Choose level for /think." }],
    }),
  ]);
  for (const message of messages) {
    expect(message).not.toHaveProperty("excludeFromContext");
  }
});
