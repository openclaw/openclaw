import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/config.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import {
  createScenario,
  humanReplies,
  outbound,
  patchProofConfig,
  providerErrors,
  runHuman,
} from "./gateway.sessions-send-provenance.test-support.js";

export async function verifyCollaborativeCancellation(signal: AbortSignal) {
  const { replyRunRegistry } = await import("../auto-reply/reply/reply-run-registry.registry.js");
  const injection = await import("../auto-reply/reply/reply-run-registry.message-injection.js");
  const previousSetting = getRuntimeConfig().messages?.queue?.allowCollaborativeSteering;
  try {
    await patchProofConfig(
      {
        messages: { queue: { allowCollaborativeSteering: true } },
        tools: { toolsBySender: { "id:alice": { deny: null }, "id:bob": { deny: ["message"] } } },
      },
      ["tools.toolsBySender.id:alice.deny"],
    );
    for (const phase of ["preparation", "injection"] as const) {
      for (const cancel of ["source", "incumbent"] as const) {
        const id = `collaborative_cancel_${phase}_${cancel}`;
        console.log("[collaborative cancellation start]", id);
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
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              scenario.incumbentStarted.promise,
              alice,
              "Alice did not start",
            ),
            signal,
          );
          const operation = expectDefined(
            replyRunRegistry.get(scenario.sourceKey),
            "Alice's owner",
          );
          let injectionStarted = false;
          const begin = injection.beginReplyMessageInjectionTarget;
          const observing = vi
            .spyOn(injection, "beginReplyMessageInjectionTarget")
            .mockImplementation((...args) => {
              if (args[1].includes(scenario.sourcePrompt)) {
                injectionStarted = true;
              }
              return begin(...args);
            });
          observers.defer(() => observing.mockRestore());
          const project = operation.projectToolAuthorityFingerprintAsync.bind(operation);
          let held = false;
          const delaying = vi
            .spyOn(operation, "projectToolAuthorityFingerprintAsync")
            .mockImplementation(async (caller) => {
              const fingerprint = await project(caller);
              if (
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
          await withinTest(
            awaitGateBeforeSettlement(entered.promise, bob, `Bob missed ${phase} preparation`),
            signal,
          );
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
          await waitForGatewayActiveWork(30_000);
          expect(providerErrors).toEqual([]);
          expect(outbound.filter((entry) => entry.to === scenario.recipient)).toEqual([]);
          expect(
            outbound
              .filter((entry) => entry.to === `${scenario.recipient}-incumbent`)
              .map((entry) => entry.text),
          ).toEqual(
            (cancel === "source" ? [1, 2] : [1]).map(
              (index) => `${scenario.marker}_INCUMBENT_${index}`,
            ),
          );
          if (cancel === "source") {
            expect(aliceResult.error).toBeUndefined();
            if (bobResult.error !== undefined) {
              expect(bobResult.error).toMatchObject({ name: "AbortError" });
            }
            expect(bobResult.result?.deferredToActiveRun).toBeUndefined();
            expect(scenario.sourceRequests).toEqual([]);
            expect(scenario.targetRequests).toEqual([]);
            expect(
              humanReplies.slice(firstReply).filter((reply) => reply.sender === "bob"),
            ).toEqual([]);
          } else {
            expect(bobResult.error).toBeUndefined();
            expect(bobResult.result?.deferredToActiveRun).toBe("followup");
            expect(scenario.accepted).toMatchObject({ status: "accepted" });
            expect(scenario.sourceRequests.length).toBeGreaterThan(0);
            expect(scenario.targetRequests.length).toBeGreaterThan(0);
            expect(
              [...scenario.sourceRequests, ...scenario.targetRequests].some((request) =>
                request.tools.includes("message"),
              ),
            ).toBe(false);
          }
          console.log(
            "[collaborative cancellation proof]",
            JSON.stringify({
              case: id,
              disposition: bobResult.result?.deferredToActiveRun,
              sourceRequests: scenario.sourceRequests.length,
              targetRequests: scenario.targetRequests.length,
              deliveries: outbound.filter((entry) => entry.to.startsWith(scenario.recipient)),
            }),
          );
        } finally {
          resume.resolve();
          scenario.releaseIncumbent.resolve();
          await Promise.allSettled([alice, bob]);
          await waitForGatewayActiveWork(30_000);
        }
      }
    }
  } finally {
    await patchProofConfig(
      {
        messages: { queue: { allowCollaborativeSteering: previousSetting ?? null } },
        tools: { toolsBySender: { "id:alice": { deny: null }, "id:bob": { deny: null } } },
      },
      [
        "messages.queue.allowCollaborativeSteering",
        "tools.toolsBySender.id:alice.deny",
        "tools.toolsBySender.id:bob.deny",
      ],
    );
  }
}
