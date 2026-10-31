// Steering between two signed-in people on one Gateway. People authenticate through a
// trusted proxy so the Gateway attributes each message to a distinct requester; a
// shared-token Gateway has a single owner identity and cannot express these scenarios.
import { expect, it } from "vitest";
import {
  BOB,
  deliveries,
  finalText,
  roleTexts,
  userTexts,
  withPeopleGateway,
  workUntilSeen,
} from "./gateway-session-steering.test-support.js";

const TEST_TIMEOUT_MS = 120_000;

it(
  "refuses another person's steering without queueing or reaching the model",
  { timeout: TEST_TIMEOUT_MS },
  () =>
    withPeopleGateway({}, async (gateway) => {
      const session = gateway.session();
      const first = gateway.held("Alice's answer.");
      gateway.model.script(first.turn);
      const original = await session.send("Alice asks a question.");
      await first.entered;

      const bob = await gateway.connectAs(BOB);
      const attempt = await session.send("Bob wants to redirect the work.", bob);
      const refusal = await session.final(attempt.runId);
      expect(finalText(refusal)).toContain("collaborative steering is disabled");
      expect(finalText(refusal)).toContain("/followup");

      first.release();
      expect(await session.wait(original.runId)).toMatchObject({ status: "ok" });
      expect(deliveries(session, "Bob wants to redirect")).toEqual([0]);
      expect(session.executedRuns()).toEqual([original.runId]);
      const history = await session.history();
      expect(roleTexts(history, "user")).toEqual(["Alice asks a question."]);
      expect(roleTexts(history, "assistant").at(-1)).toBe("Alice's answer.");
      // Settled without executable custody: it never runs after Alice's turn.
      expect(history.pendingInputs).toMatchObject({
        total: 1,
        items: [{ state: "cancelled", runId: attempt.runId }],
      });
    }),
);

it(
  "joins another person's message to the active run when collaboration is enabled",
  { timeout: TEST_TIMEOUT_MS },
  () =>
    withPeopleGateway({ allowCollaborativeSteering: true }, async (gateway) => {
      const session = gateway.session();
      const bobText = "Bob adds the regional breakdown.";
      const work = workUntilSeen(bobText, "Included Bob's breakdown.");
      gateway.model.script(work.turn);
      const original = await session.send("Alice asks for the report.");
      await session.request(0);

      const bob = await gateway.connectAs(BOB);
      const steered = await session.send(bobText, bob);
      expect(await session.wait(original.runId)).toMatchObject({
        status: "ok",
        terminalReply: { text: "Included Bob's breakdown." },
      });
      await work.seen;
      expect(session.executedRuns()).toEqual([original.runId]);
      expect(session.executedRuns()).not.toContain(steered.runId);
      expect(deliveries(session, bobText).filter((count) => count > 0)).toEqual([1]);
      // Bob stays the author of his message; the run keeps Alice as its requester.
      const delivered = session.requests().at(-1)!;
      expect(userTexts(delivered).find((text) => text.includes(bobText))).toContain('"name":"bob"');
      expect(userTexts(delivered).find((text) => text.includes("Alice asks"))).toContain(
        '"name":"alice"',
      );
      const history = await session.history();
      expect(roleTexts(history, "user")).toEqual(["Alice asks for the report.", bobText]);
      expect(history.pendingInputs).toMatchObject({ total: 0 });
    }),
);

it(
  "stops a revoked person's queued followup before it reaches the model",
  { timeout: TEST_TIMEOUT_MS },
  () =>
    withPeopleGateway({}, async (gateway) => {
      const session = gateway.session();
      const first = gateway.held("Alice's answer.");
      // Bob's queued turn must never reach the model, so no response is scripted for it.
      gateway.model.script(first.turn);
      const original = await session.send("Alice works while Bob queues.");
      await first.entered;
      const bob = await gateway.connectAs(BOB);
      const queued = await session.send("/followup Bob queued before losing access.", bob);
      await session.chat(queued.runId);

      const { paired } = await gateway.alice.request<{
        paired: Array<{ deviceId: string; deviceFamily?: string }>;
      }>("device.pair.list", {});
      const bobDevice = paired.find((device) => device.deviceFamily === BOB);
      expect(bobDevice).toBeDefined();
      await gateway.alice.request("device.pair.remove", { deviceId: bobDevice!.deviceId });

      first.release();
      expect(await session.wait(original.runId)).toMatchObject({ status: "ok" });
      expect(await session.wait(queued.runId)).toMatchObject({ status: "error" });
      expect(session.chatStates(queued.runId).at(-1)).toBe("aborted");
      expect(deliveries(session, "Bob queued before losing access.")).toEqual([0]);
      expect(session.executedRuns()).toEqual([original.runId]);
      expect((await session.history()).pendingInputs).toMatchObject({ total: 0 });
    }),
);
