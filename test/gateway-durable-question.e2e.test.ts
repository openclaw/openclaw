import { once } from "node:events";
import { access } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { QuestionGetResult, QuestionRecord } from "../packages/gateway-protocol/src/index.js";
import { createDurableQuestionGateway } from "./helpers/durable-question-gateway.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it(
  "preserves a busy-session answer ACK across an immediate Gateway crash without replaying claimed work",
  { timeout: 180_000 },
  async ({ signal }) => {
    let stage = "not started";
    const setStage = (next: string) => {
      if (next === stage) {
        return;
      }
      stage = next;
      try {
        process.stderr.write(`[durable-question:web] ${stage}\n`);
      } catch {}
    };
    setStage("fixture preparation");
    const fixture = await createDurableQuestionGateway(signal);
    let client: Awaited<ReturnType<typeof fixture.connect>> | undefined;
    const requested = createDeferred<QuestionRecord>();
    const report = () => {
      const diagnostic = `Durable question proof failed during ${stage}.\n${fixture.diagnostics()}\n${fixture.instance.logs()}`;
      try {
        process.stderr.write(`${diagnostic}\n`);
      } catch {}
      return diagnostic;
    };
    const onAbort = () => {
      report();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    await runQaGatewayFixture(
      async () => {
        try {
          setStage("Gateway startup");
          await fixture.instance.startGateway();
          setStage("operator connection");
          client = await fixture.connect(({ event, payload }) => {
            if (event === "question.requested" && isRecord(payload)) {
              requested.resolve(payload as QuestionRecord);
            }
          });
          setStage("session creation");
          const sessionKey = "agent:main:durable-proof";
          await client.request("sessions.create", {
            key: sessionKey,
            agentId: "main",
            model: fixture.model.modelRef,
            permissionMode: "full",
            cwd: fixture.instance.state.workspaceDir,
          });
          setStage("asking turn admission");
          const asking = await client.request<{ runId: string }>(
            "chat.send",
            {
              sessionKey,
              message:
                "DURABLE_ASK_PROOF: Ask which environment, then continue only after the answer.",
              idempotencyKey: "original-asking-turn",
              deliver: false,
            },
            { expectFinal: false },
          );
          setStage("question publication");
          const askingFinished = client.request("agent.wait", {
            runId: asking.runId,
            timeoutMs: 30_000,
          });
          const question = await withinTest(
            Promise.race([
              requested.promise,
              fixture.failed,
              askingFinished.then((result) => {
                if (
                  isRecord(result) &&
                  (result.status === "pending" || result.status === "timeout")
                ) {
                  return requested.promise;
                }
                throw new Error(
                  `Asking turn settled before publishing its question: ${JSON.stringify(result)}`,
                );
              }),
            ]),
            signal,
          );
          expect(question.status).toBe("pending");
          setStage("canonical durable acceptance");
          expect(
            (
              await client.request<QuestionGetResult>("question.get", {
                id: question.id,
                includeContinuation: true,
              })
            ).continuation,
          ).toMatchObject({ questionId: question.id, status: "pending" });
          setStage("asking turn handoff");
          const firstObservation = await askingFinished;
          const completed =
            isRecord(firstObservation) &&
            (firstObservation.status === "pending" || firstObservation.status === "timeout")
              ? await client.request("agent.wait", { runId: asking.runId, timeoutMs: 30_000 })
              : firstObservation;
          expect(completed).toMatchObject({ status: "ok" });
          await expect(
            access(
              path.join(
                fixture.instance.state.workspaceDir,
                "durable-question-side-effect-started",
              ),
            ),
          ).rejects.toMatchObject({ code: "ENOENT" });
          expect(
            await client.request<QuestionGetResult>("question.get", { id: question.id }),
          ).toEqual({
            question,
          });
          setStage("original operator client retirement");
          await client.stopAndWait();
          client = undefined;
          setStage("clean Gateway restart");
          await fixture.instance.stopGateway();
          setStage("clean Gateway startup");
          await fixture.instance.startGateway();
          setStage("restored operator connection");
          client = await fixture.connect();
          setStage("restored pending custody read");
          const restored = await client.request<QuestionGetResult>("question.get", {
            id: question.id,
            includeContinuation: true,
          });
          expect(restored.question).toEqual(question);
          expect(restored.continuation).toMatchObject({
            questionId: question.id,
            status: "pending",
          });
          setStage("busy turn admission");
          await client.request(
            "chat.send",
            {
              sessionKey,
              message: "DURABLE_BUSY_PROOF: keep this unrelated foreground turn busy.",
              idempotencyKey: "unrelated-busy-turn",
              deliver: false,
            },
            { expectFinal: false },
          );
          setStage("busy provider execution");
          await withinTest(Promise.race([fixture.busyStarted, fixture.failed]), signal);
          const answer = { answers: { choice: ["Staging"] } };
          setStage("busy-session answer settlement and ACK");
          expect(
            await client.request("question.resolve", {
              id: question.id,
              answers: answer,
              resolutionId: "durable-proof-answer",
            }),
          ).toEqual({ status: "answered", answers: answer });
          // The provider is held, but native admission may already have claimed the continuation.
          expect(fixture.continuationCount).toBe(0);
          const child = fixture.instance.child;
          if (!child) {
            throw new Error("Expected the original Gateway process at the ACK boundary");
          }
          const crashed = once(child, "close");
          setStage("immediate post-ACK Gateway crash");
          expect(child.kill("SIGKILL")).toBe(true);
          await withinTest(crashed, signal);
          setStage("crashed operator client retirement");
          await client.stopAndWait();
          client = undefined;
          setStage("crashed Gateway owner reconciliation");
          await fixture.instance.stopGateway();
          fixture.releaseBusy();
          setStage("post-crash Gateway startup");
          await fixture.instance.startGateway();
          setStage("post-crash operator connection");
          client = await fixture.connect();
          // An existing observation can bypass get's recovery wait; list joins the whole pass.
          await client.request("question.list", { includeContinuation: true });
          setStage("recovered continuation custody read");
          const current = await client.request<QuestionGetResult>("question.get", {
            id: question.id,
            includeContinuation: true,
          });
          expect(current.question.answers).toEqual(answer);
          if (current.continuation?.status === "interrupted") {
            setStage("pre-crash claim interruption without replay");
            expect(current.continuation).toMatchObject({
              questionId: question.id,
              runId: expect.any(String),
              reason: expect.any(String),
              nextAction:
                "Start a new user turn; this continuation was not automatically repeated.",
            });
            expect(fixture.continuationCount).toBe(0);
          } else {
            expect(["owed", "claimed", "settled"]).toContain(current.continuation?.status);
            setStage("recovered answer continuation provider execution");
            await withinTest(Promise.race([fixture.continued, fixture.failed]), signal);
            expect(fixture.continuationCount).toBe(1);
            const admitted = await client.request<QuestionGetResult>("question.get", {
              id: question.id,
              includeContinuation: true,
            });
            const runId = admitted.continuation?.runId;
            expect(runId).toEqual(expect.any(String));
            expect(runId).not.toBe(asking.runId);
            setStage("recovered continuation native completion");
            expect(await client.request("agent.wait", { runId, timeoutMs: 30_000 })).toMatchObject({
              status: "ok",
            });
          }
          await expect(
            access(
              path.join(
                fixture.instance.state.workspaceDir,
                "durable-question-side-effect-started",
              ),
            ),
          ).rejects.toMatchObject({ code: "ENOENT" });
          setStage("legacy response and lost-answer ACK verification");
          const oldShape = await client.request<QuestionGetResult>("question.get", {
            id: question.id,
          });
          expect(Object.keys(oldShape)).toEqual(["question"]);
          expect(
            await client.request("question.resolve", {
              id: question.id,
              answers: { answers: { choice: ["Production"] } },
              resolutionId: "lost-ack-retry",
            }),
          ).toEqual({ status: "answered", answers: answer });
        } catch (error) {
          throw new Error(report(), { cause: error });
        }
      },
      () => {
        setStage("operator client cleanup");
        return client?.stopAndWait();
      },
      () => {
        setStage("Gateway fixture cleanup");
        return fixture.cleanup();
      },
      () => signal.removeEventListener("abort", onAbort),
    );
  },
);
