import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { addSession, appendOutput, deleteSession } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import { QuestionManager } from "./question-manager.js";
import * as authorization from "./session-sharing-authorization-async.js";

it("rechecks invited question, process and companion access at their final responses", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async ({ gateway, sender, invited, bob, carol, model, events, providerReplies }) => {
      const { key } = await sender.request<{ key: string }>(
        "sessions.create",
        {
          agentId: "main",
          visibility: "shared",
        },
        { signal },
      );
      const target = { sessionKey: key, agentId: "main" };
      const membership = (method: "add" | "remove", identityId = carol.id) =>
        sender.request(`session.members.${method}`, { ...target, identityId }, { signal });
      const questionId = "invited-question";
      const questionRequest = {
        id: questionId,
        ...target,
        questions: [
          {
            questionId: "choice",
            header: "Choice",
            question: "Proceed?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      };
      await sender.request("question.request", questionRequest, { signal });
      const getQuestion = () => invited.request("question.get", { id: questionId }, { signal });
      const listQuestions = () =>
        invited.request<{ questions: { id: string }[] }>("question.list", {}, { signal });
      await expect(getQuestion()).rejects.toThrow();
      expect((await listQuestions()).questions).toEqual([]);
      await membership("add");
      await membership("add", bob.id);
      expect(await getQuestion()).toMatchObject({ question: { id: questionId } });
      expect((await listQuestions()).questions.map(({ id }) => id)).toContain(questionId);
      // Session-only guests keep requester-only question access even when invited.
      await expect(
        gateway.client.request("question.get", { id: questionId }, { signal }),
      ).rejects.toThrow();

      const waiterEntered = createDeferred();
      // oxlint-disable-next-line typescript/unbound-method -- apply preserves the intercepted question owner.
      const waitAnswer = QuestionManager.prototype.waitAnswer;
      using cleanup = new DisposableStack();
      cleanup.use(
        vi.spyOn(QuestionManager.prototype, "waitAnswer").mockImplementation(function (
          this: QuestionManager,
          ...args
        ) {
          const result = waitAnswer.apply(this, args);
          if (args[0] === questionId) {
            waiterEntered.resolve();
          }
          return result;
        }),
      );
      const waiting = invited.request(
        "question.waitAnswer",
        { id: questionId, timeoutMs: 30_000 },
        { signal },
      );
      void waiting.catch(() => {});
      await withinTest(
        awaitGateBeforeSettlement(
          waiterEntered.promise,
          waiting,
          "question did not register its retained waiter",
        ),
        signal,
      );
      await membership("remove");
      await sender.request(
        "question.resolve",
        {
          id: questionId,
          answers: { answers: { choice: ["Yes"] } },
        },
        { signal },
      );
      await expect(waiting).rejects.toThrow();
      await expect
        .poll(() =>
          events.sender.some(
            ({ event, payload }) =>
              event === "question.resolved" && isRecord(payload) && payload.id === questionId,
          ),
        )
        .toBe(true);
      expect(
        events.invited.some(
          ({ event, payload }) =>
            event === "question.resolved" && isRecord(payload) && payload.id === questionId,
        ),
      ).toBe(false);

      const process = createProcessSessionFixture({ id: "invited-process", backgrounded: true });
      process.scopeKey = key;
      process.agentId = "main";
      process.processActivity = { resultSettled: false, lastOutputAtMs: process.startedAt };
      addSession(process);
      appendOutput(process, "stdout", "invited process output");
      cleanup.use({ [Symbol.dispose]: () => deleteSession(process.id) });
      const processes = () =>
        invited.request<{ processes: { processId: string }[] }>(
          "sessions.processes.list",
          { key, agentId: "main" },
          { signal },
        );
      await expect(processes()).rejects.toThrow();
      await membership("add");
      expect((await processes()).processes.map(({ processId }) => processId)).toContain(process.id);
      const processEntered = createDeferred();
      const processRelease = createDeferred();
      const authorize = authorization.resolveSessionMutationAuthorizationAsync;
      let armed = true;
      cleanup.use(
        vi
          .spyOn(authorization, "resolveSessionMutationAuthorizationAsync")
          .mockImplementation(async (params) => {
            const result = await authorize(params);
            if (armed && params.method === "sessions.processes.stop") {
              armed = false;
              processEntered.resolve();
              await processRelease.promise;
            }
            return result;
          }),
      );
      const pendingProcesses = processes();
      void pendingProcesses.catch(() => {});
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            processEntered.promise,
            pendingProcesses,
            "process output did not reach final control preparation",
          ),
          signal,
        );
        await membership("remove");
        processRelease.resolve();
        await expect(pendingProcesses).rejects.toThrow();
      } finally {
        processRelease.resolve();
        await Promise.allSettled([pendingProcesses]);
      }

      const companionState = () =>
        invited.request<{ exchanges: { question: string; answer: string }[] }>(
          "sessions.companion.state",
          target,
          { signal },
        );
      const ask = (question: string) =>
        invited.request<{ answer: string }>(
          "sessions.companion.ask",
          { ...target, question, model: model.modelRef },
          { signal },
        );
      await expect(companionState()).rejects.toThrow(/not found/i);
      await expect(ask("Not a member")).rejects.toThrow(/not found/i);
      await membership("add");
      const answer = await ask("Allowed question");
      expect(answer).toMatchObject({ answer: "Acknowledged." });
      expect((await companionState()).exchanges).toContainEqual(
        expect.objectContaining({ question: "Allowed question", answer: "Acknowledged." }),
      );
      const providerEntered = createDeferred();
      const providerRelease = createDeferred();
      providerReplies.beforeReply = async () => {
        providerEntered.resolve();
        await providerRelease.promise;
      };
      const pendingAnswer = ask("Revoked question");
      void pendingAnswer.catch(() => {});
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            providerEntered.promise,
            pendingAnswer,
            "companion did not reach the real provider",
          ),
          signal,
        );
        await membership("remove");
        providerRelease.resolve();
        await expect(pendingAnswer).rejects.toThrow();
      } finally {
        providerReplies.beforeReply = undefined;
        providerRelease.resolve();
        await Promise.allSettled([pendingAnswer]);
      }
      await expect(companionState()).rejects.toThrow(/not found/i);
      await membership("add");
      expect((await companionState()).exchanges.map(({ question }) => question)).not.toContain(
        "Revoked question",
      );
    },
  );
});
