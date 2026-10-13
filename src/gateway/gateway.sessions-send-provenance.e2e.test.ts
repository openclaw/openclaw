import { describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/config.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import {
  createScenario,
  gateway,
  humanReplies,
  outbound,
  providerErrors,
  runHuman,
  runProofIngress,
  type RunResult,
  type ProofCase,
} from "./gateway.sessions-send-provenance.test-support.js";

const cases: ProofCase[] = [
  { name: "denied self-send", id: "denied", sender: "guest", agent: "main", denied: true },
  { name: "allowed self-send", id: "allowed", sender: "trusted", agent: "main", denied: false },
  {
    name: "authorized more capable delegate",
    id: "delegate",
    sender: "trusted",
    agent: "research",
    denied: false,
  },
  {
    name: "admitted followup retains denial while waiting despite a policy change",
    id: "busy_followup",
    sender: "guest",
    agent: "main",
    denied: true,
    busy: true,
    targetKey: "agent:main:telegram:direct:provenance-busy-receiver",
  },
  {
    name: "later authorized work in the same receiver",
    id: "busy_allowed",
    sender: "trusted",
    agent: "main",
    denied: false,
    targetKey: "agent:main:telegram:direct:provenance-busy-receiver",
  },
  {
    name: "denied explicit steer to busy authorized receiver",
    id: "busy_steer_denied",
    sender: "guest",
    agent: "main",
    denied: true,
    busy: true,
    mode: "steer",
    targetKey: "agent:main:telegram:direct:provenance-steer-denied",
  },
  {
    name: "compatible explicit steer from the original requester",
    id: "busy_steer_compatible",
    sender: "trusted",
    agent: "main",
    denied: false,
    busy: true,
    mode: "steer",
    bootstrap: true,
    targetKey: "agent:main:telegram:direct:provenance-busy-receiver",
  },
];

async function updateSenderPolicies(policies: Record<string, { deny: string[] | null }>) {
  const before = await gateway.client.request<{ hash: string }>("config.get", {});
  await gateway.client.request("config.patch", {
    baseHash: before.hash,
    raw: JSON.stringify({ tools: { toolsBySender: policies } }),
    replacePaths: Object.entries(policies).flatMap(([senderKey, policy]) =>
      policy.deny === null ? [`tools.toolsBySender.${senderKey}.deny`] : [],
    ),
  });
}

describe("registered sessions_send requester provenance", () => {
  it(
    "preserves requester policy without restricting later work or authorized delegation",
    { timeout: 90_000 },
    async ({ signal }) => {
      for (const spec of cases) {
        const sourceKey = `agent:${spec.agent}:telegram:direct:provenance-${spec.id === "allowed" ? "denied" : spec.id}`;
        const scenario = createScenario(spec, sourceKey);
        let incumbent: Promise<unknown> | undefined;
        let source: ReturnType<typeof runProofIngress> | undefined;
        let changedQueuedPolicy = false;
        try {
          if (spec.busy) {
            if (spec.bootstrap) {
              const bootstrap = await runProofIngress({
                abortSignal: signal,
                agentId: spec.agent,
                sessionKey: sourceKey,
                message: scenario.bootstrapPrompt,
                senderId: spec.sender,
                to: scenario.sourceRecipient,
              });
              expect(bootstrap).toMatchObject({
                payloads: [expect.objectContaining({ text: `BOOTSTRAP_COMPLETE_${spec.id}` })],
              });
              expect(
                scenario.bootstrapAccepted,
                JSON.stringify(scenario.bootstrapAccepted),
              ).toMatchObject({
                status: "accepted",
                targetDisposition: "queued",
                runId: expect.any(String),
              });
              incumbent = gateway.client.request<RunResult>("agent.wait", {
                runId: scenario.bootstrapAccepted?.runId,
                timeoutMs: 30_000,
              });
            } else {
              incumbent = runProofIngress({
                abortSignal: signal,
                agentId: "main",
                sessionKey: scenario.targetKey,
                message: scenario.incumbentPrompt,
                senderId: "trusted",
                to: `${scenario.sourceRecipient}-incumbent`,
              });
            }
            incumbent = incumbent.then((result) => {
              scenario.incumbentCompleted = true;
              return result;
            });
            await withinTest(
              awaitGateBeforeSettlement(
                scenario.incumbentStarted.promise,
                incumbent,
                "Authorized receiver settled before its first delivery",
              ),
              signal,
            );
          }
          source = runProofIngress({
            abortSignal: signal,
            agentId: spec.agent,
            sessionKey: sourceKey,
            message: scenario.sourcePrompt,
            senderId: spec.sender,
            to: scenario.sourceRecipient,
          });
          const sourceResult = await source;
          scenario.sourceCompleted = true;
          expect(sourceResult).toMatchObject({
            payloads: [expect.objectContaining({ text: `SOURCE_COMPLETE_${spec.id}` })],
          });
          const rejectedSteering = spec.mode === "steer" && spec.denied;
          expect(
            scenario.accepted,
            JSON.stringify({ accepted: scenario.accepted, providerErrors }),
          ).toMatchObject({
            status: rejectedSteering ? "error" : "accepted",
            runId: expect.any(String),
          });
          if (rejectedSteering) {
            expect(scenario.accepted?.error).toMatch(/different requester.*followup/);
          }
          expect(scenario.sourceRequests[0]?.tools).toContain("sessions_send");
          if (spec.denied || spec.id === "delegate") {
            expect(scenario.sourceRequests[0]?.tools).not.toContain("message");
          } else {
            expect(scenario.sourceRequests[0]?.tools).toContain("message");
          }
          if (spec.busy) {
            if (!rejectedSteering) {
              expect(scenario.accepted).toMatchObject({
                targetDisposition: spec.mode === "steer" ? "steered" : "queued",
              });
            }
            if (!spec.bootstrap) {
              expect(scenario.incumbentCompleted).toBe(false);
              expect(scenario.targetRequests).toEqual([]);
            } else {
              scenario.releaseTarget.resolve();
            }
            if (spec.id === "busy_followup") {
              // Native acceptance already prepared this execution, unlike a human
              // input still waiting for admission in the shared-conversation case.
              await updateSenderPolicies({ "id:guest": { deny: null } });
              changedQueuedPolicy = true;
              expect(getRuntimeConfig().tools?.toolsBySender?.["id:guest"]?.deny).toBeUndefined();
            }
            scenario.releaseIncumbent.resolve();
            expect(await incumbent).toMatchObject(
              spec.bootstrap
                ? { status: "ok" }
                : {
                    payloads: [expect.objectContaining({ text: `INCUMBENT_COMPLETE_${spec.id}` })],
                  },
            );
            expect(
              scenario.incumbentRequests.every((request) => request.tools.includes("message")),
            ).toBe(true);
            expect(
              outbound.filter((entry) => entry.to === `${scenario.recipient}-incumbent`),
            ).toEqual(
              [1, 2].map((index) => ({
                to: `${scenario.recipient}-incumbent`,
                text: `${scenario.marker}_INCUMBENT_${index}`,
                accountId: "default",
              })),
            );
          }
          if (rejectedSteering) {
            await waitForGatewayActiveWork(30_000);
            expect(scenario.targetRequests).toEqual([]);
            expect(outbound.filter((entry) => entry.to === scenario.recipient)).toEqual([]);
            expect(providerErrors).toEqual([]);
            continue;
          }
          if (spec.mode !== "steer") {
            expect(outbound.filter((entry) => entry.text === scenario.marker)).toEqual([]);
          }
          await withinTest(scenario.targetStarted.promise, signal);
          scenario.releaseTarget.resolve();
          if (!spec.bootstrap) {
            const terminal = await gateway.client.request<RunResult>("agent.wait", {
              runId: scenario.accepted?.runId,
              timeoutMs: 30_000,
            });
            expect(terminal, JSON.stringify(terminal)).toMatchObject({ status: "ok" });
          }
          await waitForGatewayActiveWork(30_000);
          expect(providerErrors).toEqual([]);
          const deliveries = outbound.filter((entry) => entry.to === scenario.recipient);
          expect
            .soft(deliveries, spec.name)
            .toEqual(
              spec.denied
                ? []
                : [{ to: scenario.recipient, text: scenario.marker, accountId: "default" }],
            );
          if (spec.mode !== "steer") {
            expect
              .soft(scenario.effectAfterSourceCompletion, spec.name)
              .toEqual(spec.denied ? [] : [true]);
          }
          expect
            .soft(
              scenario.targetRequests.map((request) => request.tools.includes("message")),
              spec.name,
            )
            .toEqual(scenario.targetRequests.map(() => !spec.denied));
          console.log(
            "[busy receiver proof]",
            JSON.stringify({
              case: spec.id,
              accepted: scenario.accepted,
              incumbentTools: scenario.incumbentRequests.map((request) =>
                request.tools.includes("message"),
              ),
              targetTools: scenario.targetRequests.map((request) =>
                request.tools.includes("message"),
              ),
              deliveries,
            }),
          );
          if (scenario.targetKey === sourceKey) {
            expect
              .soft(
                outbound.filter((entry) => entry.to === scenario.sourceRecipient),
                spec.name,
              )
              .toEqual([
                {
                  to: scenario.sourceRecipient,
                  text: `TARGET_COMPLETE_${spec.id}`,
                  accountId: "default",
                },
              ]);
          }
        } finally {
          scenario.releaseIncumbent.resolve();
          scenario.releaseTarget.resolve();
          await Promise.allSettled([source, incumbent]);
          await waitForGatewayActiveWork(30_000);
          if (changedQueuedPolicy) {
            await updateSenderPolicies({ "id:guest": { deny: ["message"] } });
          }
        }
      }
    },
  );
});

// The same real reply admission that commits Bob's queued message emits the notice.
// Holding Alice's outbound I/O proves the notice arrives before her work finishes.
describe("shared conversation requester admission", () => {
  it("acknowledges Bob's separate turn and resolves its policy when admitted", async ({
    signal,
  }) => {
    const scenario = createScenario(
      {
        name: "cross-human followup",
        id: "mixed_human",
        sender: "bob",
        agent: "main",
        denied: true,
      },
      "agent:main:telegram:group:provenance-mixed-human",
    );
    scenario.releaseTarget.resolve();
    let alice: ReturnType<typeof runHuman> | undefined;
    try {
      alice = runHuman(scenario, "alice", scenario.incumbentPrompt, "steer", signal).then(
        (result) => {
          scenario.incumbentCompleted = true;
          return result;
        },
      );
      await withinTest(
        awaitGateBeforeSettlement(
          scenario.incumbentStarted.promise,
          alice,
          "Alice settled before her first delivery",
        ),
        signal,
      );
      const receipt = await runHuman(scenario, "bob", scenario.sourcePrompt, "steer", signal);
      expect(receipt.deferredToActiveRun).toBe("followup");
      expect(humanReplies.filter((reply) => reply.sender === "bob")).toEqual([
        {
          sender: "bob",
          text: "Your message is queued for a new turn after the current turn finishes. It hasn’t changed the work already in progress.",
        },
      ]);
      expect(scenario.incumbentCompleted).toBe(false);
      expect(scenario.sourceRequests).toEqual([]);
      await updateSenderPolicies({
        "id:alice": { deny: ["message"] },
        "id:bob": { deny: ["message"] },
      });
      expect(getRuntimeConfig().tools?.toolsBySender?.["id:bob"]).toEqual({ deny: ["message"] });
      scenario.releaseIncumbent.resolve();
      await alice;
      await withinTest(scenario.targetStarted.promise, signal);
      await waitForGatewayActiveWork(30_000);
      expect(providerErrors).toEqual([]);
      expect(scenario.accepted).toMatchObject({ status: "accepted" });
      expect(scenario.incumbentRequests.every((request) => request.tools.includes("message"))).toBe(
        true,
      );
      expect(scenario.sourceRequests.every((request) => !request.tools.includes("message"))).toBe(
        true,
      );
      expect(scenario.targetRequests.every((request) => !request.tools.includes("message"))).toBe(
        true,
      );
      expect(outbound.filter((item) => item.to === scenario.recipient)).toEqual([]);
      expect(
        outbound
          .filter((item) => item.to === `${scenario.recipient}-incumbent`)
          .map((item) => item.text),
      ).toEqual([`${scenario.marker}_INCUMBENT_1`, `${scenario.marker}_INCUMBENT_2`]);
    } finally {
      scenario.releaseIncumbent.resolve();
      scenario.releaseTarget.resolve();
      await Promise.allSettled([alice]);
      await waitForGatewayActiveWork(30_000);
    }
  }, 90_000);
});
