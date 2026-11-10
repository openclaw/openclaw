import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import {
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
  testing,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import {
  createSubagentModelConfig,
  findSubagentSpawnReceipt,
  type SpawnReceipt,
} from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const rootPrompt = "Run the route through a middle runner and report its result.";
const middleTask = "Middle runner: delegate the leaf check, then report the leaf answer.";
const leafTask = "Leaf check: answer with the leaf marker.";
const LEAF_ANSWER = "LEAF-ANSWER-7d1c";
const MIDDLE_DONE = "MIDDLE-DONE";
const HANDOFF = "Handoff: middle runner\nPending: leaf check";
const PAUSE_NOTICE = "A child is paused awaiting a continuation";
const FOLLOWUP = "Continue with the follow-up check after requester completion.";
const CLAIM = "Wait for a message from the middle runner.";

function promptStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(promptStrings);
  }
  return value && typeof value === "object" ? Object.values(value).flatMap(promptStrings) : [];
}

type ResponsesItem = { type?: unknown; name?: unknown; call_id?: unknown; output?: unknown };

function inputItems(body: unknown): ResponsesItem[] {
  const input = (body as { input?: unknown }).input;
  return Array.isArray(input) ? (input as ResponsesItem[]) : [];
}

function calledTools(body: unknown): string[] {
  return inputItems(body).flatMap((item) =>
    item?.type === "function_call" && typeof item.name === "string" ? [item.name] : [],
  );
}

/** Text the requester was given after its own sessions_yield result. */
function textAfterToolOutput(body: unknown, name: string): string {
  const items = inputItems(body);
  const call = items.findLast((item) => item?.type === "function_call" && item.name === name);
  const outputIndex = items.findIndex(
    (item) => item?.type === "function_call_output" && item.call_id === call?.call_id,
  );
  return outputIndex < 0 ? "" : promptStrings(items.slice(outputIndex + 1)).join("\n");
}

function toolOutput(body: unknown, name: string): string | undefined {
  const items = inputItems(body);
  const call = items.find((item) => item?.type === "function_call" && item.name === name);
  const output = items.find(
    (item) => item?.type === "function_call_output" && item.call_id === call?.call_id,
  )?.output;
  return output === undefined ? undefined : promptStrings(output).join("");
}

async function startModelServer(
  completion: "children" | "direct" | "claimed" | "successor" = "children",
) {
  const rootSettlements: string[] = [];
  const middleDone = createDeferred<string>();
  const middleYieldResult = createDeferred<string>();
  const spawned = createDeferred<SpawnReceipt>();
  const finishRequester = createDeferred();
  const allowMessageWait = createDeferred();
  const leafSpawned = createDeferred<SpawnReceipt>();
  const claimed = createDeferred<SpawnReceipt>();
  const allowFollowup = createDeferred();
  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const raw = await readRequestText(request);
    const body = JSON.parse(raw) as unknown;
    const reply = (text: string, id: string) =>
      writeOpenAiResponsesText(response, { text, messageId: id, responseId: `${id}_response` });
    if (raw.includes(FOLLOWUP)) {
      reply("FOLLOWUP-DONE", "followup_done");
      return;
    }
    const calls = calledTools(body);
    if (raw.includes(rootPrompt)) {
      if (!calls.includes("sessions_spawn")) {
        writeToolCall(response, "sessions_spawn", {
          task: middleTask,
          context: "isolated",
          ...(completion === "successor" ? { visible: true } : {}),
        });
        return;
      }
      if (completion !== "children") {
        const receipt = findSubagentSpawnReceipt(toolOutput(body, "sessions_spawn"));
        if (!receipt) {
          throw new Error("Requester did not receive its child spawn receipt");
        }
        spawned.resolve(receipt);
        if (completion === "direct" || completion === "claimed") {
          if (completion === "claimed") {
            if (!calls.includes("sessions_send")) {
              await allowFollowup.promise;
              writeToolCall(response, "sessions_send", {
                sessionKey: receipt.childSessionKey,
                mode: "followup",
                watch: true,
                timeoutSeconds: 0,
                message: CLAIM,
              });
              return;
            }
            const claim = JSON.parse(toolOutput(body, "sessions_send") ?? "null") as {
              status?: string;
              runId?: string;
            } | null;
            if (claim?.status !== "accepted" || !claim.runId) {
              throw new Error("Requester did not receive its accepted child follow-up");
            }
            claimed.resolve({ childSessionKey: receipt.childSessionKey, runId: claim.runId });
          }
          await finishRequester.promise;
          reply("REQUESTER-DONE", "requester_done");
          return;
        }
      }
      if (!calls.includes("sessions_yield")) {
        writeToolCall(response, "sessions_yield", {});
        return;
      }
      const settlement = textAfterToolOutput(body, "sessions_yield");
      if (settlement) {
        rootSettlements.push(settlement);
        if (settlement.includes(MIDDLE_DONE)) {
          middleDone.resolve(settlement);
        }
        reply("NO_REPLY", `root_settle_${rootSettlements.length}`);
        return;
      }
      reply("Waiting for the middle runner.", "root_waiting");
      return;
    }
    if (raw.includes(middleTask)) {
      if (completion === "successor") {
        if (!calls.includes("sessions_spawn")) {
          writeToolCall(response, "sessions_spawn", { task: leafTask, context: "isolated" });
          return;
        }
        const leaf = findSubagentSpawnReceipt(toolOutput(body, "sessions_spawn"));
        if (!leaf) {
          throw new Error("Middle runner did not receive its leaf spawn receipt");
        }
        leafSpawned.resolve(leaf);
        if (!calls.includes("sessions_send")) {
          await allowFollowup.promise;
          writeToolCall(response, "sessions_send", {
            sessionKey: leaf.childSessionKey,
            mode: "followup",
            watch: true,
            timeoutSeconds: 0,
            message: CLAIM,
          });
          return;
        }
        if (!calls.includes("sessions_yield")) {
          const receipt = JSON.parse(toolOutput(body, "sessions_send") ?? "null") as {
            status?: string;
            runId?: string;
          } | null;
          if (receipt?.status !== "accepted" || !receipt.runId) {
            throw new Error("Middle runner did not receive its accepted leaf follow-up");
          }
          claimed.resolve({ childSessionKey: leaf.childSessionKey, runId: receipt.runId });
          writeToolCall(response, "sessions_yield", {});
          return;
        }
        reply(MIDDLE_DONE, "requester_successor_done");
        return;
      }
      if (completion === "claimed" && !raw.includes(CLAIM)) {
        reply("CHILD-READY", "child_ready");
        return;
      }
      if (completion === "direct" || completion === "claimed") {
        await allowMessageWait.promise;
        writeToolCall(response, "sessions_yield", {
          waitFor: "message",
          acknowledgment: "Waiting for my requester to continue me.",
        });
        return;
      }
      if (!calls.includes("sessions_spawn")) {
        writeToolCall(response, "sessions_spawn", { task: leafTask, context: "isolated" });
        return;
      }
      if (!calls.includes("sessions_yield")) {
        writeToolCall(response, "sessions_yield", { waitFor: "message", acknowledgment: HANDOFF });
        return;
      }
      const yielded = toolOutput(body, "sessions_yield");
      if (yielded) {
        middleYieldResult.resolve(yielded);
      }
      if (raw.includes(LEAF_ANSWER)) {
        reply(`${MIDDLE_DONE}: ${LEAF_ANSWER}`, "middle_done");
        return;
      }
      reply("NO_REPLY", "middle_waiting");
      return;
    }
    if (raw.includes(leafTask)) {
      if (completion === "successor" && raw.includes(CLAIM)) {
        await allowMessageWait.promise;
        writeToolCall(response, "sessions_yield", { waitFor: "message" });
        return;
      }
      reply(LEAF_ANSWER, "leaf_answer");
      return;
    }
    reply("NO_REPLY", "fallback");
  }
  const server = await startOpenAiResponsesModelServer({
    modelId: "yield-wait-scope",
    bindError: "Expected yield wait scope model server address",
    onRequest: async (request, response) => {
      try {
        await handleRequest(request, response);
      } catch (error) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    },
  });
  return {
    url: `${server.baseUrl}/v1`,
    rootSettlements,
    middleDone: middleDone.promise,
    middleYieldResult: middleYieldResult.promise,
    spawned: spawned.promise,
    finishRequester: finishRequester.resolve,
    allowMessageWait: allowMessageWait.resolve,
    leafSpawned: leafSpawned.promise,
    claimed: claimed.promise,
    allowFollowup: allowFollowup.resolve,
    close: server.close,
  };
}

async function within<T>(promise: Promise<T>, ms: number, describe: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(describe())), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(() => resetSubagentRegistryForTests({ persist: false }));

it("treats a subagent's waitFor yield for its own children as a child wait, not a pause", async () => {
  const model = await startModelServer();
  const state = await createOpenClawTestState({ label: "subagent-yield-wait-scope" });
  const base = createSubagentModelConfig(state.workspaceDir, {
    baseUrl: model.url,
    modelId: "yield-wait-scope",
    name: "Yield wait scope",
    runtime: true,
  });
  const gateway = await startGatewayWithClient({
    cfg: {
      ...base,
      agents: {
        ...base.agents,
        defaults: {
          ...base.agents?.defaults,
          subagents: { ...base.agents?.defaults?.subagents, maxSpawnDepth: 2 },
        },
      },
      gateway: { controlUi: { enabled: false } },
    },
    configPath: state.configPath,
    token: "yield-wait-scope-token",
  });
  try {
    await gateway.server.startupSettled;
    const accepted = await gateway.client.request<{ runId: string }>("chat.send", {
      sessionKey: "main",
      message: rootPrompt,
      idempotencyKey: `yield-wait-scope-${randomUUID()}`,
      deliver: false,
    });
    await expect(
      gateway.client.request("agent.wait", { runId: accepted.runId, timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ status: "ok" });

    // The root is woken once, by the middle runner's completion carrying the leaf
    // answer, and is never told the runner is paused awaiting a sessions_send.
    const settlement = await within(
      model.middleDone,
      60_000,
      () =>
        `root never received the middle completion; root wakes: ${JSON.stringify(model.rootSettlements)}`,
    );
    expect(settlement).toContain(`${MIDDLE_DONE}: ${LEAF_ANSWER}`);
    expect(model.rootSettlements.filter((text) => text.includes(PAUSE_NOTICE))).toEqual([]);
    expect(model.rootSettlements).toHaveLength(1);

    // The middle runner's own leaf completion resumed it, so its yield was an
    // ordinary child wait, and the tool result says waitFor was not applied.
    const yielded = JSON.parse(await model.middleYieldResult) as Record<string, unknown>;
    expect(yielded).toMatchObject({
      status: "yielded",
      acknowledgment: HANDOFF,
      note: expect.stringContaining('waitFor: "message" was not applied'),
    });
  } finally {
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "subagent yield wait scope proof complete" });
    await model.close();
    await state.cleanup();
  }
});

it.each([
  ["before", false],
  ["after", false],
  ["before", true],
] as const)(
  "closes a child's message wait when its requester finishes %s it parks (later turn: %s)",
  async (order, laterTurn) => {
    const model = await startModelServer(laterTurn ? "claimed" : "direct");
    const state = await createOpenClawTestState({ label: "subagent-message-wait-requester-done" });
    const gateway = await startGatewayWithClient({
      cfg: {
        ...createSubagentModelConfig(state.workspaceDir, {
          baseUrl: model.url,
          modelId: "yield-wait-scope",
          runtime: true,
        }),
        gateway: { controlUi: { enabled: false } },
      },
      configPath: state.configPath,
      token: "yield-wait-scope-token",
    });
    const parked = createDeferred();
    const closed = createDeferred();
    let child: SpawnReceipt | undefined;
    const observeChild = () => {
      const row = child && getSubagentRunByRunId(child.runId);
      if (row?.pauseReason === "sessions_yield") {
        parked.resolve();
      }
    };
    const stop = subscribeSubagentRunChanges("persistence", observeChild);
    // Terminal session effects publish after the registry row; join their own receipt.
    const stopClosed = onSessionLifecycleEvent((event) => {
      if (
        event.sessionKey === child?.childSessionKey &&
        event.reason === "subagent-status" &&
        child &&
        getSubagentRunByRunId(child.runId)?.execution.outcome
      ) {
        closed.resolve();
      }
    });
    try {
      await gateway.server.startupSettled;
      const requester = await gateway.client.request<{ runId: string }>("chat.send", {
        sessionKey: "main",
        message: rootPrompt,
        idempotencyKey: `message-wait-${randomUUID()}`,
        deliver: false,
      });
      const bootstrap = await within(
        model.spawned,
        30_000,
        () => "requester never spawned the child",
      );
      if (laterTurn) {
        await expect(
          gateway.client.request("agent.wait", { runId: bootstrap.runId, timeoutMs: 30_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        model.allowFollowup();
        child = await within(model.claimed, 30_000, () => "requester never claimed the child");
        expect(
          subagentRuns.getRequesterRunInstance(getSubagentRunByRunId(child.runId)!)?.runId,
        ).toBe(requester.runId);
      } else {
        child = bootstrap;
      }
      observeChild();
      const finishRequester = async () => {
        model.finishRequester();
        await expect(
          gateway.client.request("agent.wait", { runId: requester.runId, timeoutMs: 30_000 }),
        ).resolves.toMatchObject({ status: "ok" });
      };
      if (order === "before") {
        await finishRequester();
      }
      if (laterTurn) {
        const later = await gateway.client.request<{ runId: string }>("chat.send", {
          sessionKey: "main",
          message: "An unrelated later request.",
          idempotencyKey: `message-wait-later-${randomUUID()}`,
          deliver: false,
        });
        await expect(
          gateway.client.request("agent.wait", { runId: later.runId, timeoutMs: 30_000 }),
        ).resolves.toMatchObject({ status: "ok" });
        const pending = getSubagentRunByRunId(child.runId)!;
        expect(subagentRuns.getRequesterRunInstance(pending)?.runId).toBe(requester.runId);
        const entry = await readSessionEntryReadOnlyInWorker({
          agentId: "main",
          sessionKey: pending.requesterSessionKey,
        });
        expect(entry?.lastRunId).toBe(later.runId);
      }
      model.allowMessageWait();
      await expect(
        gateway.client.request("agent.wait", { runId: child.runId, timeoutMs: 30_000 }),
      ).resolves.toMatchObject({ status: "ok" });
      await within(parked.promise, 5_000, () => "child never published its accepted message wait");
      expect(getSubagentRunByRunId(child.runId)).toMatchObject({
        pauseReason: "sessions_yield",
        execution: { status: "terminal" },
      });
      expect(getSubagentRunByRunId(child.runId)?.execution.outcome).toBeUndefined();

      if (order === "before") {
        await testing.sweepOnceForTests();
      } else {
        await finishRequester();
      }
      await within(
        closed.promise,
        5_000,
        () =>
          `finished requester left child parked: ${JSON.stringify(getSubagentRunByRunId(child!.runId)?.execution)}`,
      );
      expect(getSubagentRunByRunId(child.runId)?.execution.outcome).toMatchObject({
        status: "error",
        error: expect.stringMatching(/requester/i),
      });
      const entry = await readSessionEntryReadOnlyInWorker({
        agentId: "main",
        sessionKey: child.childSessionKey,
      });
      expect(entry).toBeDefined();
      expect(entry?.lifecycleRunId).toBeUndefined();
      // The writer fence remains, but the completed wait must allow a new turn.
      const followup = await gateway.client.request<{ runId: string; status: string }>(
        "sessions.send",
        {
          key: child.childSessionKey,
          message: FOLLOWUP,
          idempotencyKey: `message-wait-followup-${randomUUID()}`,
        },
      );
      expect(followup.status).toBe("started");
      await expect(
        gateway.client.request("agent.wait", { runId: followup.runId, timeoutMs: 30_000 }),
      ).resolves.toMatchObject({ status: "ok" });
    } finally {
      stop();
      stopClosed();
      model.finishRequester();
      model.allowFollowup();
      model.allowMessageWait();
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "message wait requester completion proof complete" });
      await model.close();
      await state.cleanup();
    }
  },
);

it("closes a claimed child's message wait when its requester task finishes through an adopted run", async () => {
  const model = await startModelServer("successor");
  const state = await createOpenClawTestState({ label: "subagent-message-wait-successor" });
  const base = createSubagentModelConfig(state.workspaceDir, {
    baseUrl: model.url,
    modelId: "yield-wait-scope",
    runtime: true,
  });
  const gateway = await startGatewayWithClient({
    cfg: {
      ...base,
      agents: {
        ...base.agents,
        defaults: {
          ...base.agents?.defaults,
          subagents: { ...base.agents?.defaults?.subagents, maxSpawnDepth: 2 },
        },
      },
      gateway: { controlUi: { enabled: false } },
    },
    configPath: state.configPath,
    token: "yield-wait-scope-token",
  });
  let requester: SpawnReceipt | undefined;
  let child: SpawnReceipt | undefined;
  let successor: { runId: string } | undefined;
  const requesterParked = createDeferred();
  const childParked = createDeferred();
  const successorCommitted = createDeferred();
  const closed = createDeferred();
  const observeRows = () => {
    if (requester && getSubagentRunByRunId(requester.runId)?.pauseReason === "sessions_yield") {
      requesterParked.resolve();
    }
    if (child && getSubagentRunByRunId(child.runId)?.pauseReason === "sessions_yield") {
      childParked.resolve();
    }
  };
  const observeRequester = async () => {
    if (!requester) {
      return;
    }
    const entry = await readSessionEntryReadOnlyInWorker({
      agentId: "main",
      sessionKey: requester.childSessionKey,
    });
    if (entry?.status !== "done" || !entry.lastRunId) {
      return;
    }
    if (!successor && entry.lastRunId !== requester.runId) {
      successor = { runId: entry.lastRunId };
      successorCommitted.resolve();
    }
  };
  const stopRows = subscribeSubagentRunChanges("persistence", observeRows);
  const stopSessions = sessionChanges.subscribe((event) => {
    if (
      !("all" in event) &&
      event.scope === "runtime" &&
      event.sessionKey === requester?.childSessionKey
    ) {
      void observeRequester();
    }
  });
  const stopClosed = onSessionLifecycleEvent((event) => {
    if (event.sessionKey === child?.childSessionKey && event.reason === "subagent-status") {
      closed.resolve();
    }
  });
  try {
    await gateway.server.startupSettled;
    await gateway.client.request("chat.send", {
      sessionKey: "main",
      message: rootPrompt,
      idempotencyKey: `successor-root-${randomUUID()}`,
      deliver: false,
    });
    requester = await within(model.spawned, 30_000, () => "root never spawned the requester");
    const bootstrap = await within(
      model.leafSpawned,
      30_000,
      () => "requester never spawned its leaf",
    );
    await expect(
      gateway.client.request("agent.wait", { runId: bootstrap.runId, timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ status: "ok" });
    model.allowFollowup();
    child = await within(model.claimed, 30_000, () => "requester never claimed the leaf follow-up");
    observeRows();
    await within(requesterParked.promise, 30_000, () => "requester never yielded behind its child");
    const binding = () =>
      subagentRuns.getRequesterRunInstance(getSubagentRunByRunId(child!.runId)!);
    expect(binding()?.runId).toBe(requester.runId);
    // The child's pause wakes its yielded requester through the real settlement
    // path, which adopts the original task before the model finishes it.
    model.allowMessageWait();
    await within(childParked.promise, 30_000, () => "claimed child never parked for a message");
    await within(
      successorCommitted.promise,
      30_000,
      () => "requester continuation never committed completion",
    );
    expect(successor).toBeDefined();
    expect(getSubagentRunByRunId(successor!.runId)?.taskRunId).toBe(requester.runId);
    await testing.sweepOnceForTests();
    await within(
      closed.promise,
      5_000,
      () =>
        `finished requester ${successor!.runId} left child waiting on ${binding()?.runId}: ${JSON.stringify(getSubagentRunByRunId(child!.runId))}`,
    );
    expect(getSubagentRunByRunId(child.runId)).toMatchObject({
      execution: { outcome: { status: "error", error: expect.stringMatching(/requester/i) } },
    });
    expect(getSubagentRunByRunId(child.runId)?.pauseReason).toBeUndefined();
    const entry = await readSessionEntryReadOnlyInWorker({
      agentId: "main",
      sessionKey: child.childSessionKey,
    });
    expect(entry?.lifecycleRunId).toBeUndefined();
    const followup = await gateway.client.request<{ runId: string }>("sessions.send", {
      key: child.childSessionKey,
      message: FOLLOWUP,
      idempotencyKey: `successor-child-followup-${randomUUID()}`,
    });
    await expect(
      gateway.client.request("agent.wait", { runId: followup.runId, timeoutMs: 30_000 }),
    ).resolves.toMatchObject({ status: "ok" });
  } finally {
    stopRows();
    stopSessions();
    stopClosed();
    model.allowFollowup();
    model.allowMessageWait();
    await disconnectGatewayClient(gateway.client);
    await gateway.server.close({ reason: "requester successor proof complete" });
    await model.close();
    await state.cleanup();
  }
});
