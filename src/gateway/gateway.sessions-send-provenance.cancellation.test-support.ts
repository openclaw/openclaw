import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  configureProofCollaboration,
  createScenario,
  expectProofIdle,
  FOLLOWUP_REPLY,
  humanReplies,
  proofDeliveries,
  runHuman,
  settleProofScenario,
  waitForProofGate,
} from "./gateway.sessions-send-provenance.test-support.js";

export async function verifyCollaborativeCancellation(signal: AbortSignal) {
  const { getSessionControllerOperation, captureReplyMessageInjectionTarget } =
    await import("../sessions/session-controller.js");
  const { captureSessionTarget } = await import("../sessions/session-controller.target.js");
  const { resolveGatewaySessionStoreTargetInWorker } =
    await import("./session-utils-store-worker.js");
  const injection = await import("../sessions/session-controller.message-injection.js");
  const { enqueueMessageInjection } =
    await import("../auto-reply/reply/message-injection-authority.js");
  const contracts = await import("../sessions/session-controller.contracts.js");
  const previousSetting = getRuntimeConfig().messages?.queue?.allowCollaborativeSteering;
  try {
    await configureProofCollaboration(true, true);
    for (const phase of ["preparation", "injection", "queued"] as const) {
      for (const cancel of ["source", "incumbent"] as const) {
        const id = `collaborative_cancel_${phase}_${cancel}`;
        const scenario = createScenario(
          { name: id, id, sender: "bob", agent: "main", denied: true },
          `agent:main:telegram:group:provenance-${id}`,
        );
        scenario.releaseTarget.resolve();
        const source = new AbortController();
        const entered = createDeferred();
        const resume = createDeferred();
        const firstReply = humanReplies.length;
        using observers = new DisposableStack();
        const alice = runHuman(scenario, "alice", scenario.incumbentPrompt, "steer", signal);
        const aliceOutcome = alice.then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        );
        let bob: ReturnType<typeof runHuman> | undefined;
        let queuedPreparation: Promise<void> | undefined;
        try {
          await waitForProofGate(
            scenario.incumbentStarted.promise,
            alice,
            signal,
            "Alice did not start",
          );
          const loaded = await resolveGatewaySessionStoreTargetInWorker({
            cfg: getRuntimeConfig(),
            key: scenario.sourceKey,
            readOnly: true,
            signal,
          });
          const target = captureSessionTarget({
            storeScope: loaded.storePath,
            sessionKey: loaded.canonicalKey,
            agentId: loaded.agentId,
            incarnation: expectDefined(loaded.store[loaded.canonicalKey], "Alice's session")
              .sessionId,
          });
          const operation = expectDefined(
            getSessionControllerOperation(loaded.canonicalKey, target),
            "Alice's owner",
          );
          const queuedTarget =
            phase === "queued"
              ? expectDefined(
                  captureReplyMessageInjectionTarget(operation),
                  "Alice's injection target",
                )
              : undefined;
          if (queuedTarget) {
            const blockerEntered = createDeferred();
            queuedPreparation = enqueueMessageInjection(
              queuedTarget[contracts.replyMessageInjectionTargetOwner].backendIdentity,
              async () => {
                blockerEntered.resolve();
                await resume.promise;
              },
            );
            await waitForProofGate(
              blockerEntered.promise,
              queuedPreparation,
              signal,
              "Injection queue blocker did not start",
            );
          }
          let injectionStarted = false;
          const begin = injection.beginReplyMessageInjectionTarget;
          const observing = vi
            .spyOn(injection, "beginReplyMessageInjectionTarget")
            .mockImplementation((...args) => {
              if (args[1].includes(scenario.sourcePrompt)) {
                injectionStarted = true;
                if (queuedTarget) {
                  expect(args[0][contracts.replyMessageInjectionTargetOwner].backendIdentity).toBe(
                    queuedTarget[contracts.replyMessageInjectionTargetOwner].backendIdentity,
                  );
                  const pending = begin(...args);
                  // Bob is behind the real FIFO blocker, before his first preparation.
                  entered.resolve();
                  return pending;
                }
              }
              return begin(...args);
            });
          observers.defer(() => observing.mockRestore());
          const project = operation.projectToolAuthorityFingerprintAsync;
          let held = false;
          const delaying = vi
            .spyOn(operation, "projectToolAuthorityFingerprintAsync")
            .mockImplementation(async (caller) => {
              const fingerprint = await project(caller);
              if (
                phase !== "queued" &&
                !held &&
                caller.allowCollaborativeSteering &&
                injectionStarted === (phase === "injection")
              ) {
                expect(fingerprint).toBeTypeOf("string");
                expect(fingerprint).toBe(operation.toolAuthorityFingerprint);
                held = true;
                entered.resolve();
                // Pause the real result, never substitute policy or queue acceptance.
                await resume.promise;
              }
              return fingerprint;
            });
          observers.defer(() => delaying.mockRestore());
          bob = runHuman(
            scenario,
            "bob",
            scenario.sourcePrompt,
            "steer",
            AbortSignal.any([signal, source.signal]),
          );
          const bobOutcome = bob.then(
            (result) => ({ result, error: undefined }),
            (error: unknown) => ({ result: undefined, error }),
          );
          await waitForProofGate(entered.promise, bob, signal, `Bob missed ${phase} preparation`);
          expect(scenario.sourceRequests).toEqual([]);
          if (cancel === "source") {
            source.abort();
          } else {
            expect(operation.abortByUser()).toBe(true);
          }
          resume.resolve();
          // The first sink effect is already sent; its HTTP producer must settle.
          scenario.releaseIncumbent.resolve();
          const [aliceResult, bobResult] = await Promise.all([aliceOutcome, bobOutcome]);
          await queuedPreparation;
          await expectProofIdle();
          const replies = humanReplies.slice(firstReply);
          const incumbentTexts = (cancel === "source" ? [1, 2] : [1]).map(
            (index) => `${scenario.marker}_INCUMBENT_${index}`,
          );
          expect(proofDeliveries(scenario.recipient)).toEqual([]);
          expect(
            proofDeliveries(`${scenario.recipient}-incumbent`).map((entry) => entry.text),
          ).toEqual(incumbentTexts);
          if (cancel === "source") {
            expect(aliceResult.error).toBeUndefined();
            if (bobResult.error !== undefined) {
              expect(bobResult.error).toMatchObject({ name: "AbortError" });
            }
            expect(bobResult.result?.deferredToActiveRun).toBeUndefined();
            expect([scenario.sourceRequests, scenario.targetRequests]).toEqual([[], []]);
            expect(replies.filter((reply) => reply.sender === "bob")).toEqual([]);
          } else {
            expect(bobResult.error, id).toBeUndefined();
            expect(bobResult.result?.deferredToActiveRun).toBe("followup");
            expect(replies).toContainEqual({
              sender: "bob",
              text: FOLLOWUP_REPLY,
            });
            expect(scenario.accepted).toMatchObject({ status: "accepted" });
            expect(scenario.sourceRequests.length).toBeGreaterThan(0);
            expect(scenario.targetRequests.length).toBeGreaterThan(0);
            expect(scenario.targetRequests[1]?.output).toMatch(
              /^(Tool message not found|message is not available in this turn\.)/,
            );
          }
        } finally {
          resume.resolve();
          await settleProofScenario(scenario, [queuedPreparation, alice, bob]);
        }
      }
    }
  } finally {
    await configureProofCollaboration(previousSetting);
  }
}
