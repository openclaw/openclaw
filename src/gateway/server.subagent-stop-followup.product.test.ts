// Prove Stop, deletion, and yield of kept children through real Gateway tools.
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as announceOutput from "../agents/subagents/announce/subagent-announce-output.js";
import { PROVISIONAL_KILL_RECONCILIATION_MS } from "../agents/subagents/registry/subagent-registry-helpers.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import * as sweepKill from "../agents/subagents/registry/subagent-registry-sweep-kill.js";
import {
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
  testing as subagentRegistryTesting,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import * as sessionReconciliation from "../agents/subagents/registry/subagent-session-reconciliation.js";
import { sessionControllerMailboxes } from "../sessions/session-controller.mailbox.js";
import {
  createSubagentStopFixture,
  findSubagentRecords,
  subagentToolCallEvents,
} from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient } from "./test-helpers.e2e.js";

vi.mock("../agents/subagents/announce/subagent-announce-output.js", { spy: true });
vi.mock("../agents/subagents/registry/subagent-registry-sweep-kill.js", { spy: true });
vi.mock("../agents/subagents/registry/subagent-session-reconciliation.js", { spy: true });

const parentPrompt = "Run the exact Stop then kept-child follow-up proof.";
const stoppedTask = "Hold this first child execution until it is stopped.";
const followupTask = "Finish this successor execution with the required success marker.";
const stoppedResult = "STOPPED_RUN_MUST_NOT_DELIVER";
const successorResult = "AFTER_STOP_OK";
const deletedTask = "Pause until this child session is deleted.";
const siblingTask = "Finish the sibling task after the other child is retired.";
const siblingResult = "AFTER_RETIREMENT_OK";
const pauseNotice = "Paused awaiting continuation.";
const spawnReceipts = (body: string) =>
  findSubagentRecords(
    JSON.parse(body) as unknown,
    (record) => typeof record.childSessionKey === "string" && typeof record.runId === "string",
  ).map((record) => ({
    runId: record.runId as string,
    sessionKey: record.childSessionKey as string,
  }));

type ModelHandler = (
  body: string,
  request: IncomingMessage,
  response: ServerResponse,
  sequence: number,
) => Promise<boolean>;

/** Serves one scripted parent plus its children; unscripted turns answer NO_REPLY. */
async function startScriptedModel(handle: ModelHandler) {
  let responseSequence = 0;
  const server = await startOpenAiResponsesModelServer({
    modelId: "stop-proof",
    bindError: "Expected subagent model server address",
    onRequest: async (request, response) => {
      try {
        const body = await readRequestText(request);
        responseSequence += 1;
        if (!(await handle(body, request, response, responseSequence))) {
          writeOpenAiResponsesText(response, {
            text: "NO_REPLY",
            messageId: `fallback_${responseSequence}`,
            responseId: `fallback_response_${responseSequence}`,
          });
        }
      } catch (error) {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        response.end(JSON.stringify({ error: { message: String(error) } }));
      }
    },
  });
  return { url: `${server.baseUrl}/v1`, close: server.close };
}

/** A child that holds its model call until cancellation, then attempts a late result. */
async function holdUntilStopped(
  request: IncomingMessage,
  response: ServerResponse,
  started: () => void,
) {
  const stopped = createDeferred();
  started();
  request.once("aborted", () => stopped.resolve());
  response.once("close", () => stopped.resolve());
  await stopped.promise;
  writeOpenAiResponsesText(response, {
    text: stoppedResult,
    messageId: "stopped_child_late_result",
    responseId: "stopped_child_late_result_response",
  });
}

function modelActions(response: ServerResponse, sequence: number) {
  const tool = (name: string, args: Record<string, unknown>) => {
    writeOpenAiResponsesSse(response, subagentToolCallEvents(name, args, sequence));
    return true;
  };
  return {
    tool,
    spawn: (task: string, extras: Record<string, unknown> = {}) =>
      tool("sessions_spawn", { task, context: "isolated", cleanup: "keep", ...extras }),
    pause: () => tool("sessions_yield", { waitFor: "message" }),
    // Requester continuations answer visibly so delivery records a visible final.
    reply: (text: string, id?: string) => {
      writeOpenAiResponsesText(response, {
        text,
        messageId: id ?? `requester_delivery_${sequence}`,
        responseId: id ? `${id}_response` : `requester_delivery_response_${sequence}`,
      });
      return true;
    },
  };
}

type ChildReceipt = { runId: string; sessionKey: string };

/** Stop/follow-up and sibling retirement share transport and delivery, not turn ordering. */
function startRetirementModel(kind: "active" | "paused" | "delete" | "stop") {
  const followup = kind === "active" || kind === "paused";
  const active = kind === "active" || kind === "stop";
  const task = kind === "delete" ? deletedTask : stoppedTask;
  const result = followup ? successorResult : siblingResult;
  const source = createDeferred<ChildReceipt>();
  const successor = createDeferred<{ runId: string }>();
  const started = createDeferred();
  const retire = createDeferred();
  const yieldParent = createDeferred();
  const delivered = createDeferred();
  const counts = { delivered: 0, retired: 0 };
  let turn = 0;
  return {
    source: source.promise,
    successor: successor.promise,
    started: started.promise,
    delivered: delivered.promise,
    retire: retire.resolve,
    yieldParent: yieldParent.resolve,
    counts,
    release: followup ? yieldParent.resolve : retire.resolve,
    handle: async (...[body, request, response, sequence]: Parameters<ModelHandler>) => {
      const { tool, spawn, pause, reply } = modelActions(response, sequence);
      const spawnChild = (childTask: string) =>
        spawn(childTask, followup || active ? { completionTarget: "parent" } : {});
      if (!body.includes(parentPrompt)) {
        if (body.includes(followup ? followupTask : siblingTask)) {
          return reply(result, followup ? "stop_followup_successor" : "retirement_sibling_result");
        }
        if (!body.includes(task)) {
          return false;
        }
        if (active) {
          await holdUntilStopped(request, response, started.resolve);
          return true;
        }
        started.resolve();
        return body.includes("function_call_output") ? false : pause();
      }
      // Stale notices/late output cannot reach the requester; success uses a new delivery turn.
      if (body.includes(stoppedResult) || body.includes(pauseNotice)) {
        counts.retired += 1;
        return false;
      }
      if (body.includes(result)) {
        counts.delivered += 1;
        delivered.resolve();
        return reply(followup ? "PARENT_RECEIVED_SUCCESSOR" : "PARENT_RECEIVED_SIBLING");
      }
      turn += 1;
      if (turn === 1) {
        return spawnChild(task);
      }
      const children = spawnReceipts(body);
      if (followup && !children[0]) {
        throw new Error("Parent transport did not retain the child spawn receipt");
      }
      if (turn === 2) {
        const child = children[0];
        if (!child) {
          throw new Error("Parent did not retain the retired-child spawn receipt");
        }
        source.resolve(child);
        if (!followup) {
          return spawnChild(siblingTask);
        }
        await retire.promise;
        return tool("sessions", { action: "stop", ...child });
      }
      const retired = followup ? children[0]! : await source.promise;
      if (turn === 3) {
        if (followup) {
          return tool("sessions_send", {
            sessionKey: retired.sessionKey,
            mode: "followup",
            timeoutSeconds: 0,
            message: followupTask,
          });
        }
        const child = children.find((entry) => entry.runId !== retired.runId);
        if (!child) {
          throw new Error("Parent did not retain the sibling spawn receipt");
        }
        successor.resolve(child);
        await retire.promise;
        return active ? tool("sessions", { action: "stop", ...retired }) : pause();
      }
      if (turn === 4 && followup) {
        const [accepted] = findSubagentRecords(
          JSON.parse(body) as unknown,
          (record) =>
            record.status === "accepted" &&
            record.targetDisposition === "queued" &&
            typeof record.runId === "string",
        );
        if (!accepted) {
          throw new Error("Parent did not retain the queued follow-up receipt");
        }
        successor.resolve({ runId: accepted.runId as string });
        await yieldParent.promise;
      }
      // Sibling Stop yields immediately, while the retired child is still settling.
      return turn === 4 && (followup || active) ? pause() : false;
    },
  };
}

const onlyChildTask = "Hold the only child of a yielded parent until it ends.";
const resolvedCohortMarker = "ended without a result";

const awaitedChildTask = "Hold the awaited child of a finished parent turn until it is stopped.";

/** One or more held/paused children, followed by a yielding or idle requester. */
function startChildModel(
  tasks: readonly string[],
  parentYields = true,
  child: "hold" | "pause" = "hold",
) {
  const spawnedChildren = createDeferred<{ runId: string; sessionKey: string }[]>();
  const childrenStarted = tasks.map(() => createDeferred());
  const continued = createDeferred();
  const continuations: string[] = [];
  let parentRequestCount = 0;
  return {
    children: spawnedChildren.promise,
    childrenStarted: Promise.all(childrenStarted.map((started) => started.promise)),
    continued: continued.promise,
    continuations: () => [...continuations],
    handle: async (...[body, request, response, sequence]: Parameters<ModelHandler>) => {
      const { spawn, pause, reply } = modelActions(response, sequence);
      if (!body.includes(parentPrompt)) {
        const index = tasks.findIndex((task) => body.includes(task));
        if (index < 0) {
          return false;
        }
        const started = childrenStarted[index]!;
        if (child === "hold") {
          await holdUntilStopped(request, response, () => started.resolve());
          return true;
        }
        started.resolve();
        return body.includes("function_call_output") ? false : pause();
      }
      if (body.includes(stoppedResult)) {
        throw new Error("A stopped child result reached its requester");
      }
      const isContinuation =
        parentYields && tasks.length === 1
          ? body.includes(resolvedCohortMarker)
          : parentRequestCount > tasks.length;
      if (isContinuation) {
        continuations.push(body);
        continued.resolve();
        return reply(
          tasks.length > 1
            ? "PARENT_RECEIVED_STOPPED_PAIR"
            : parentYields
              ? "PARENT_RECEIVED_RESOLVED_COHORT"
              : "PARENT_RECEIVED_STOPPED_CHILD",
        );
      }
      parentRequestCount += 1;
      if (parentRequestCount <= tasks.length) {
        return spawn(tasks[parentRequestCount - 1]!);
      }
      if (parentRequestCount === tasks.length + 1) {
        const spawned = spawnReceipts(body);
        if (!spawned[0] || (tasks.length > 1 && spawned.length !== tasks.length)) {
          throw new Error("Parent did not retain every child spawn receipt");
        }
        spawnedChildren.resolve(tasks.length === 1 ? [spawned[0]] : spawned);
        return parentYields ? pause() : reply("PARENT_AWAITS_CHILD");
      }
      return false;
    },
  };
}

type ProofClient = Awaited<
  ReturnType<Awaited<ReturnType<typeof createSubagentStopFixture>>["start"]>
>["client"];
async function startParentTurn(client: ProofClient, runId: string) {
  // Sidecar readiness precedes chat recovery; preserve the receipt while awaiting admission.
  await vi.waitFor(
    () =>
      expect(
        client.request("chat.send", {
          sessionKey: `agent:main:${runId}`,
          message: parentPrompt,
          idempotencyKey: runId,
          deliver: false,
        }),
      ).resolves.toMatchObject({ runId, status: "started" }),
    { timeout: 30_000 },
  );
}

/** Wait on registry publication, optionally accepting removal of the row. */
async function waitForRun(
  runId: string,
  matches: (row: SubagentRunRecord) => boolean,
  acceptRemoval = false,
) {
  const reached = createDeferred();
  const observe = () => {
    const row = getSubagentRunByRunId(runId);
    if (row ? matches(row) : acceptRemoval) {
      reached.resolve();
    }
  };
  const stop = subscribeSubagentRunChanges("persistence", observe);
  try {
    observe();
    await reached.promise;
  } finally {
    stop();
  }
}

const waitForRunOrRemoval = (runId: string, matches: (row: SubagentRunRecord) => boolean) =>
  waitForRun(runId, matches, true);

/** Drive fallback confirmation without rewriting a live kill owner's row. */
async function sweepPastKillReconciliation() {
  const sweepAt = Date.now() + PROVISIONAL_KILL_RECONCILIATION_MS;
  const clock = vi.spyOn(Date, "now").mockReturnValue(sweepAt);
  try {
    await subagentRegistryTesting.sweepOnceForTests();
  } finally {
    clock.mockRestore();
  }
}

const waitForAgent = (client: ProofClient, runId: string) =>
  expect(client.request("agent.wait", { runId, timeoutMs: 30_000 })).resolves.toMatchObject({
    status: "ok",
  });
const abortChild = (client: ProofClient, child: { runId: string; sessionKey: string }) =>
  expect(
    client.request("sessions.abort", { key: child.sessionKey, runId: child.runId }),
  ).resolves.toMatchObject({ ok: true, status: "aborted" });
const deleteChild = (client: ProofClient, key: string) =>
  expect(client.request("sessions.delete", { key })).resolves.toMatchObject({
    ok: true,
    deleted: true,
  });

async function withProof(
  script: { handle: ModelHandler; release?: () => void },
  label: string,
  run: (client: ProofClient) => Promise<void>,
) {
  const model = await startScriptedModel(script.handle);
  const { state, start } = await createSubagentStopFixture(label, model.url);
  const gateway = await start();
  await gateway.server.startupSettled;
  try {
    await run(gateway.client);
  } finally {
    script.release?.();
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: `${label} proof complete` });
    await state.cleanup();
    await model.close();
  }
}

/** Controller inputs that a run still owes its requester, by stable reservation identity. */
function owedControllerInputs(runId: string) {
  return [...sessionControllerMailboxes()].flatMap((mailbox) =>
    mailbox.entries.filter(
      (input) => input.phase !== "consumed" && input.sourceTurnId?.includes(runId) === true,
    ),
  );
}

afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
});

it.each(["active", "paused", "delete", "stop"] as const)(
  "delivers exactly one successor after retiring an %s source",
  async (kind) => {
    const followup = kind === "active" || kind === "paused";
    const script = startRetirementModel(kind);
    const label = `subagent-retirement-${kind}`;
    const parentRunId = `${label}-parent`;
    await withProof(script, label, async (client) => {
      await startParentTurn(client, parentRunId);
      const source = await script.source;
      await script.started;
      if (kind === "paused" || kind === "delete") {
        await waitForRun(source.runId, (row) => row.pauseReason === "sessions_yield");
      }
      if (followup) {
        script.retire();
      }
      const successor = await script.successor;
      await waitForAgent(client, successor.runId);
      if (kind === "delete") {
        await deleteChild(client, source.sessionKey);
        expect(owedControllerInputs(source.runId), "deletion retires its inputs").toEqual([]);
      }
      if (followup) {
        script.yieldParent();
      } else {
        script.retire();
      }
      await waitForAgent(client, parentRunId);
      await waitForRun(successor.runId, (row) => row.delivery?.status === "delivered");
      await script.delivered;
      expect(script.counts).toEqual({ delivered: 1, retired: 0 });
      expect(owedControllerInputs(source.runId), "the retired source owes nothing").toEqual([]);
      expect(owedControllerInputs(successor.runId), "the successor delivered once").toEqual([]);
    });
  },
);

it.each([
  { ending: "child stop", continuations: 1 },
  { ending: "active child stop", continuations: 1 },
  { ending: "child delete", continuations: 1 },
  { ending: "parent stop", continuations: 0 },
] as const)(
  "resolves a yielded parent's only child after $ending with $continuations continuation",
  async ({ ending, continuations }) => {
    // Stop reaches a dormant child through its registry row. Stop of an active child is
    // confirmed when its controller operation settles, with no reconciliation delay.
    const script = startChildModel(
      [onlyChildTask],
      true,
      ending === "child stop" ? "pause" : "hold",
    );
    const label = `subagent-only-child-${ending.replaceAll(" ", "-")}`;
    const parentRunId = `${label}-parent`;
    const parentSessionKey = `agent:main:${parentRunId}`;
    await withProof(script, label, async (client) => {
      await startParentTurn(client, parentRunId);
      const child = (await script.children)[0]!;
      await script.childrenStarted;
      await waitForAgent(client, parentRunId);
      await waitForRun(
        child.runId,
        (row) =>
          row.requesterSettleWake?.requesterYieldBatch === true &&
          (ending !== "child stop" || row.pauseReason === "sessions_yield"),
      );
      if (ending === "child stop" || ending === "active child stop") {
        await abortChild(client, child);
      } else if (ending === "child delete") {
        await deleteChild(client, child.sessionKey);
      } else {
        await client.request("sessions.abort", { key: parentSessionKey });
      }
      // The cohort resolves when its last member's wake is settled or retired.
      await waitForRunOrRemoval(
        child.runId,
        (row) => row.execution.status === "terminal" && row.requesterSettleWake === undefined,
      );
      // The continuation is a later requester turn; the resolved wake only reserves it.
      if (continuations > 0) {
        await script.continued;
      }
      const delivered = script.continuations();
      expect(delivered).toHaveLength(continuations);
      for (const body of delivered) {
        expect(body).toContain(onlyChildTask);
      }
      expect(owedControllerInputs(child.runId), "the resolved cohort owes nothing").toEqual([]);
    });
  },
);

it.each([
  { stopped: "child", notices: 1 },
  { stopped: "parent", notices: 0 },
] as const)(
  "tells a parent $notices time(s) when the user stops the $stopped of an awaited child",
  async ({ stopped, notices: expectedNotices }) => {
    const script = startChildModel([awaitedChildTask], false);
    const parentRunId = `subagent-awaited-${stopped}-stop-parent`;
    const parentSessionKey = `agent:main:${parentRunId}`;
    await withProof(script, `subagent-awaited-${stopped}-stop`, async (client) => {
      await startParentTurn(client, parentRunId);
      const child = (await script.children)[0]!;
      await script.childrenStarted;
      await waitForAgent(client, parentRunId);
      expect(getSubagentRunByRunId(child.runId)?.requesterSettleWake?.requesterYieldBatch).not.toBe(
        true,
      );
      const outputPolls = vi.mocked(announceOutput.readLatestSubagentOutputWithRetry);
      outputPolls.mockClear();
      if (stopped === "child") {
        await abortChild(client, child);
        await script.continued;
        // A killed child has no further output: its notice is sent without polling for any.
        expect(outputPolls).not.toHaveBeenCalled();
      } else {
        // A requester-wide Stop: the parent already knows, so its children report nothing.
        await client.request("sessions.abort", { key: parentSessionKey });
        // Wait for published termination, not the provisional kill that live settlement clears.
        await waitForRunOrRemoval(child.runId, (row) => row.execution.status === "terminal");
        await sweepPastKillReconciliation();
      }
      // Settled means the kill is confirmed and its cleanup finished, not just published.
      await waitForRunOrRemoval(
        child.runId,
        (row) =>
          row.execution.status === "terminal" &&
          row.killReconciliation === undefined &&
          row.cleanupHandled === true &&
          typeof row.cleanupCompletedAt === "number" &&
          row.requesterSettleWake === undefined,
      );
      expect(owedControllerInputs(child.runId), "the stopped child owes nothing").toEqual([]);
      const notices = script.continuations();
      expect(notices).toHaveLength(expectedNotices);
      for (const notice of notices) {
        expect(notice).toContain(
          `ended without a result: 1 stopped, killed, or deleted before finishing (${awaitedChildTask})`,
        );
        expect(notice).toContain("(no output)");
      }
    });
  },
);

it("confirms a stopped child's kill without losing either of two overlapping confirmations", async () => {
  const script = startChildModel([
    "Hold the first child of a yielded pair until it is stopped.",
    "Hold the second child of a yielded pair until it is stopped.",
  ]);
  const parentRunId = "subagent-yielded-pair-parent-stop-parent";
  const parentSessionKey = `agent:main:${parentRunId}`;
  const confirmations = vi.mocked(sweepKill.reconcileProvisionalSubagentKill);
  const reads = vi.mocked(sessionReconciliation.resolveSubagentSessionCompletion);
  const { reconcileProvisionalSubagentKill: actualConfirm } = await vi.importActual<
    typeof sweepKill
  >("../agents/subagents/registry/subagent-registry-sweep-kill.js");
  const { resolveSubagentSessionCompletion: actualRead } = await vi.importActual<
    typeof sessionReconciliation
  >("../agents/subagents/registry/subagent-session-reconciliation.js");
  await withProof(script, "subagent-yielded-pair-parent-stop", async (client) => {
    try {
      await startParentTurn(client, parentRunId);
      const children = await script.children;
      await script.childrenStarted;
      await waitForAgent(client, parentRunId);
      for (const child of children) {
        await waitForRun(
          child.runId,
          (row) => row.requesterSettleWake?.requesterYieldBatch === true,
        );
      }
      // Hold the first confirmation of one stopped child inside its completion read, as a slow
      // session read does, so a second confirmation of the same kill overlaps it.
      const [held] = children;
      const readHeld = createDeferred();
      const releaseRead = createDeferred();
      let confirming = 0;
      let holding = true;
      confirmations.mockClear();
      confirmations.mockImplementation(async (params) => {
        confirming += params.runId === held!.runId ? 1 : 0;
        try {
          return await actualConfirm(params);
        } finally {
          confirming -= params.runId === held!.runId ? 1 : 0;
        }
      });
      reads.mockImplementation(async (params) => {
        if (holding && confirming > 0 && params.childSessionKey === held!.sessionKey) {
          holding = false;
          readHeld.resolve();
          await releaseRead.promise;
        }
        return await actualRead(params);
      });
      // A requester-wide Stop kills both children; each kill confirms once its owner settles.
      await client.request("sessions.abort", { key: parentSessionKey, clearQueued: true });
      await readHeld.promise;
      // The sweeper confirms the same kill once it ages past the reconciliation window. Sweep
      // at that later time rather than rewriting the kill record the held confirmation owns.
      await sweepPastKillReconciliation();
      releaseRead.resolve();
      for (const child of children) {
        await waitForRunOrRemoval(
          child.runId,
          (row) =>
            row.execution.status === "terminal" &&
            row.killReconciliation === undefined &&
            row.requesterSettleWake === undefined,
        );
      }
      await Promise.allSettled(confirmations.mock.results.map((result) => result.value));
      expect(
        confirmations.mock.settledResults.filter((result) => result.type === "rejected"),
        "an overlapping confirmation never loses the kill it confirms",
      ).toEqual([]);
      for (const child of children) {
        expect(owedControllerInputs(child.runId), "the stopped child owes nothing").toEqual([]);
      }
      // The requester stopped its own children, so it already knows.
      expect(script.continuations()).toEqual([]);
    } finally {
      confirmations.mockImplementation(actualConfirm);
      reads.mockImplementation(actualRead);
    }
  });
});
