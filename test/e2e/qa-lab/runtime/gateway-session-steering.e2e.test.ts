// Session input lifecycle through a real Gateway process: steering into the active run,
// queued followups, Stop, recovery compaction and cross-session delivery. Scenarios drive
// public RPCs and assert what the model received, which runs executed, the persisted
// transcript and pending inputs. Only the model is scripted.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDeferred } from "../../../helpers/promise.js";
import {
  deliveries,
  finalText,
  reply,
  replyText,
  roleTexts,
  startSteeringGateway,
  workUntilSeen,
  writeContextOverflow,
  writeToolCall,
  type ProviderRequest,
  type SteeringGateway,
} from "./gateway-session-steering.test-support.js";

const SUITE_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

function toolResults(request: ProviderRequest): unknown[] {
  return request.input
    .filter((item) => item.type === "function_call_output")
    .map((item) => JSON.parse(item.output ?? "null") as unknown);
}

describe("session input lifecycle", () => {
  let gateway: SteeringGateway;
  beforeAll(async () => {
    gateway = await startSteeringGateway();
  }, SUITE_TIMEOUT_MS);
  afterAll(() => gateway?.close());
  afterEach(() => gateway.assertScriptConsumed());

  it(
    "joins the requester's correction to the active run exactly once",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const session = gateway.session();
      const correctionText = "Use the revised figures instead.";
      // The run works through real tool boundaries until the model receives the correction.
      const work = workUntilSeen(correctionText, "Revised figures used.");
      gateway.model.script(work.turn);
      const original = await session.send("Summarize the original figures.");
      await session.request(0);

      const correction = await session.send(correctionText);
      expect(await session.wait(original.runId)).toMatchObject({
        status: "ok",
        terminalReply: { text: "Revised figures used." },
      });
      expect(await work.seen).toBeGreaterThan(0);
      expect(deliveries(session, correctionText).filter((count) => count > 0)).toEqual([1]);
      expect(session.executedRuns()).toEqual([original.runId]);
      expect(session.executedRuns()).not.toContain(correction.runId);
      const history = await session.history();
      expect(roleTexts(history, "user")).toEqual([
        "Summarize the original figures.",
        correctionText,
      ]);
      expect(history.pendingInputs).toMatchObject({ total: 0 });
    },
  );

  it(
    "runs /followup as its own turn after the active run",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const session = gateway.session();
      const first = gateway.held("The first answer.");
      gateway.model.script(first.turn, reply("The followup answer."));
      const original = await session.send("Start the first task.");
      await first.entered;

      const queued = await session.send("/followup Then start a separate task.");
      expect(finalText(await session.chat(queued.runId))).toContain(
        "Your message is queued for a new turn",
      );
      // Queued work waits: the active run's model request is still the only one.
      expect(session.requests()).toHaveLength(1);

      first.release();
      expect(await session.wait(original.runId)).toMatchObject({ status: "ok" });
      expect(await session.wait(queued.runId)).toMatchObject({
        status: "ok",
        terminalReply: { text: "The followup answer." },
      });
      expect(session.executedRuns()).toEqual([original.runId, queued.runId]);
      expect(deliveries(session, "Then start a separate task.")).toEqual([0, 1]);
      const history = await session.history();
      expect(roleTexts(history, "assistant")).toEqual([
        "The first answer.",
        "The followup answer.",
      ]);
      expect(history.pendingInputs).toMatchObject({ total: 0 });
    },
  );

  it(
    "keeps queued work when Stop targets only the active run",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const session = gateway.session();
      const first = gateway.held("Never delivered.");
      gateway.model.script(first.turn, reply("The queued answer after Stop."));
      const original = await session.send("Start long work that Stop interrupts.");
      await first.entered;
      const queued = await session.send("/followup Queued before the run is stopped.");
      await session.chat(queued.runId);

      expect(
        await gateway.operator.request("chat.abort", {
          sessionKey: session.sessionKey,
          runId: original.runId,
        }),
      ).toMatchObject({ aborted: true, runIds: [original.runId] });
      expect(await session.wait(original.runId)).toMatchObject({
        status: "error",
        stopReason: "rpc",
      });
      expect(session.chatStates(original.runId).at(-1)).toBe("aborted");
      first.release();
      expect(await session.wait(queued.runId)).toMatchObject({
        status: "ok",
        terminalReply: { text: "The queued answer after Stop." },
      });
      expect(session.executedRuns()).toEqual([original.runId, queued.runId]);
      expect(roleTexts(await session.history(), "assistant")).toEqual([
        "The queued answer after Stop.",
      ]);
    },
  );

  it(
    "cancels queued work visibly when Stop targets the whole session",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const session = gateway.session();
      const first = gateway.held("Never delivered.");
      gateway.model.script(first.turn);
      const original = await session.send("Start long work that session Stop cancels.");
      await first.entered;
      const queued = await session.send("/followup Queued before the session is stopped.");
      await session.chat(queued.runId);

      const stopped = await gateway.operator.request<{ aborted: boolean; runIds: string[] }>(
        "chat.abort",
        { sessionKey: session.sessionKey },
      );
      expect(stopped.aborted).toBe(true);
      expect(stopped.runIds.toSorted()).toEqual([original.runId, queued.runId].toSorted());
      first.release();
      // Each input ends with a visible outcome; neither is left waiting.
      for (const runId of [original.runId, queued.runId]) {
        expect(await session.wait(runId)).toMatchObject({ status: "error" });
        expect(session.chatStates(runId).at(-1)).toBe("aborted");
      }
      expect(session.requests()).toHaveLength(1);
      const history = await session.history();
      expect(roleTexts(history, "assistant")).toEqual([]);
      expect(history.pendingInputs).toMatchObject({ total: 0 });
    },
  );

  it.for(["followup", "steer"] as const)(
    "delivers sessions_send to a busy peer by its requested mode (%s)",
    { timeout: TEST_TIMEOUT_MS },
    async (mode) => {
      const peer = gateway.session();
      const requester = gateway.session();
      const note = `Coordination note (${mode}).`;
      const peerTask = `Peer task (${mode}).`;
      const requesterTask = `Requester task (${mode}).`;
      // Followup leaves the active peer run alone; steer joins it at a tool boundary.
      const held = mode === "followup" ? gateway.held("Peer finished its own work.") : undefined;
      const work = mode === "steer" ? workUntilSeen(note, "Peer used the note.") : undefined;
      gateway.model.route(
        peerTask,
        held?.turn ?? work!.turn,
        ...(mode === "followup" ? [reply("Peer handled the note.")] : []),
      );
      let sendResult: unknown;
      gateway.model.route(
        requesterTask,
        async (_request, response) =>
          writeToolCall(response, "sessions_send", {
            sessionKey: peer.sessionKey,
            message: note,
            timeoutSeconds: 0,
            mode,
          }),
        async (request, response) => {
          sendResult = toolResults(request).at(-1);
          replyText(response, "Requester done.");
        },
        // A separately run peer turn returns its reply to the requester as a later turn.
        ...(mode === "followup" ? [reply("Requester read the peer reply.")] : []),
      );
      const peerRun = await peer.send(peerTask);
      await peer.request(0);
      const requesterRun = await requester.send(requesterTask);
      expect(await requester.wait(requesterRun.runId)).toMatchObject({ status: "ok" });
      expect(sendResult, JSON.stringify(sendResult)).toMatchObject({
        status: "accepted",
        targetDisposition: mode === "followup" ? "queued" : "steered",
      });
      held?.release();
      expect(await peer.wait(peerRun.runId)).toMatchObject({
        status: "ok",
        terminalReply: {
          text: mode === "followup" ? "Peer finished its own work." : "Peer used the note.",
        },
      });

      const noteRun = (sendResult as { runId: string }).runId;
      if (mode === "followup") {
        expect(await peer.wait(noteRun)).toMatchObject({
          status: "ok",
          terminalReply: { text: "Peer handled the note." },
        });
        expect(peer.executedRuns()).toEqual([peerRun.runId, noteRun]);
        expect(deliveries(peer, note)).toEqual([0, 1]);
        // The settled peer reply reaches the requester exactly once.
        const replyRun = await requester.finalReply("Requester read the peer reply.");
        expect(await requester.wait(replyRun)).toMatchObject({ status: "ok" });
        expect(deliveries(requester, "Peer handled the note.")).toEqual([0, 0, 1]);
      } else {
        await work!.seen;
        expect(peer.executedRuns()).toEqual([peerRun.runId]);
        expect(deliveries(peer, note).filter((count) => count > 0)).toEqual([1]);
      }
      expect((await peer.history()).pendingInputs).toMatchObject({ total: 0 });
    },
  );

  it(
    "returns a subagent's result to its requester in one announcement",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const parent = gateway.session();
      const childTask = "Child task: report the inventory count.";
      let spawned: unknown;
      // The parent's requests also quote the child task, so its route is registered first.
      gateway.model.route(
        "Delegate the inventory count.",
        async (_request, response) =>
          writeToolCall(response, "sessions_spawn", { task: childTask, mode: "run" }),
        async (request, response) => {
          spawned = toolResults(request).at(-1);
          replyText(response, "Delegated the count.");
        },
        reply("The child counted 42 items."),
      );
      gateway.model.route(childTask, reply("Inventory count: 42."));
      const run = await parent.send("Delegate the inventory count.");
      expect(await parent.wait(run.runId)).toMatchObject({ status: "ok" });
      expect(spawned).toMatchObject({ status: "accepted", expectsCompletionMessage: true });

      const announcement = await parent.finalReply("The child counted 42 items.");
      expect(await parent.wait(announcement)).toMatchObject({ status: "ok" });
      expect(parent.executedRuns()).toEqual([run.runId, announcement]);
      // The child's result first reaches the parent in the announcement's request.
      expect(deliveries(parent, "Inventory count: 42.")).toEqual([0, 0, 1]);
      const history = await parent.history();
      expect(roleTexts(history, "assistant").filter(Boolean)).toEqual([
        "Delegated the count.",
        "The child counted 42 items.",
      ]);
      expect(history.pendingInputs).toMatchObject({ total: 0 });
    },
  );

  it(
    "answers a message sent during a subagent announcement exactly once",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const parent = gateway.session();
      const childTask = "Child task: summarize the open tickets.";
      const announcementHeld = gateway.held("The child found three open tickets.");
      const question = "Which ticket is most urgent?";
      gateway.model.route(
        "Delegate the ticket summary.",
        async (_request, response) =>
          writeToolCall(response, "sessions_spawn", { task: childTask, mode: "run" }),
        async (_request, response) => replyText(response, "Delegated the summary."),
        announcementHeld.turn,
        // Whether the message joins the announcement or runs after it, it is answered once.
        reply("Ticket 7 is most urgent."),
      );
      gateway.model.route(childTask, reply("Three open tickets; ticket 7 is blocking."));
      const run = await parent.send("Delegate the ticket summary.");
      expect(await parent.wait(run.runId)).toMatchObject({ status: "ok" });
      await announcementHeld.entered;

      const asked = await parent.send(question);
      announcementHeld.release();
      expect(await parent.wait(asked.runId)).toMatchObject({ status: "ok" });

      expect(deliveries(parent, question).filter((count) => count > 0)).toEqual([1]);
      expect(parent.executedRuns().filter((id) => id.startsWith("announce:"))).toHaveLength(1);
      const history = await parent.history();
      expect(roleTexts(history, "user")).toEqual(["Delegate the ticket summary.", question]);
      expect(roleTexts(history, "assistant").filter(Boolean)).toEqual([
        "Delegated the summary.",
        "The child found three open tickets.",
        "Ticket 7 is most urgent.",
      ]);
      expect(history.pendingInputs).toMatchObject({ total: 0 });
    },
  );
  // Last: when this contract breaks, the downgraded correction later runs as its own
  // turn, which would otherwise surface as unscripted requests in unrelated scenarios.
  it(
    "delivers a correction sent during recovery compaction to the same run once",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const session = gateway.session();
      // Real turns build older history that recovery compaction can summarize.
      for (const n of [1, 2, 3, 4]) {
        gateway.model.script(reply(`Earlier answer ${n} ${"r".repeat(4_096)}`));
        const earlier = await session.send(`Earlier question ${n} ${"u".repeat(4_096)}`);
        expect(await session.wait(earlier.runId)).toMatchObject({ status: "ok" });
      }
      const summaryHeld = createDeferred();
      const releaseSummary = createDeferred();
      gateway.model.onSummary(async (_request, response) => {
        summaryHeld.resolve();
        await releaseSummary.promise;
        replyText(response, "## Decisions\n- Earlier questions were answered.");
      });
      const correctionText = "Correction sent during compaction.";
      const work = workUntilSeen(correctionText, "Answer after compaction.");
      gateway.model.script(async (_request, response) => writeContextOverflow(response), work.turn);
      const original = await session.send("This question overflows the context.");
      await summaryHeld.promise;

      const correction = await session.send(correctionText);
      releaseSummary.resolve();
      expect(await session.wait(original.runId)).toMatchObject({
        status: "ok",
        terminalReply: { text: "Answer after compaction." },
      });
      await work.seen;

      expect(deliveries(session, correctionText).filter((count) => count > 0)).toEqual([1]);
      expect(session.executedRuns()).not.toContain(correction.runId);
      expect(session.executedRuns().at(-1)).toBe(original.runId);
      expect(session.compaction(original.runId)).toEqual([
        expect.objectContaining({ phase: "start" }),
        expect.objectContaining({ phase: "end", completed: true }),
      ]);
      const history = await session.history();
      expect(roleTexts(history, "user").slice(-2)).toEqual([
        "This question overflows the context.",
        correctionText,
      ]);
      expect(history.pendingInputs).toMatchObject({ total: 0 });
    },
  );
});
