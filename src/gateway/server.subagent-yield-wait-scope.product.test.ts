import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { createSubagentModelConfig } from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const rootPrompt = "Run the route through a middle runner and report its result.";
const middleTask = "Middle runner: delegate the leaf check, then report the leaf answer.";
const leafTask = "Leaf check: answer with the leaf marker.";
const LEAF_ANSWER = "LEAF-ANSWER-7d1c";
const MIDDLE_DONE = "MIDDLE-DONE";
const HANDOFF = "Handoff: middle runner\nPending: leaf check";
const PAUSE_NOTICE = "A child is paused awaiting a continuation";

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

/**
 * A root session spawns a middle runner, which spawns its own leaf child and then
 * yields for it with waitFor "message", as pstack route runners did.
 */
async function startModelServer() {
  const rootSettlements: string[] = [];
  const middleDone = createDeferred<string>();
  const middleYieldResult = createDeferred<string>();
  async function handleRequest(request: IncomingMessage, response: ServerResponse) {
    const raw = await readRequestText(request);
    const body = JSON.parse(raw) as unknown;
    const reply = (text: string, id: string) =>
      writeOpenAiResponsesText(response, { text, messageId: id, responseId: `${id}_response` });
    const calls = calledTools(body);
    if (raw.includes(rootPrompt)) {
      if (!calls.includes("sessions_spawn")) {
        writeToolCall(response, "sessions_spawn", { task: middleTask, context: "isolated" });
        return;
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
