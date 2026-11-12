import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
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
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import {
  createSubagentModelConfig,
  findSubagentSpawnReceipt,
  type SpawnReceipt,
} from "./server.subagent-stop-settlement.product.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

// The main session delegates to a runner subagent, which spawns a leaf and yields for it.
// The leaf settles while the runner answers a follow-up; a second follow-up queues behind
// the runner's settle wake, so the runner's newest run is no longer the one that yielded.
// In the accepted settle turn the runner writes a marker through the real write tool.
const ROOT = "ROOT-TASK: delegate the check to a runner.";
const ROOT_FOLLOWUP = "ROOT-FOLLOWUP: send the runner a follow-up.";
const RUNNER = "RUNNER-TASK: delegate the leaf check, wait for it, then report.";
const RUNNER_FOLLOWUP = "RUNNER-FOLLOWUP-WHILE-YIELDED";
const LEAF = "LEAF-TASK: answer with the leaf marker.";
const LEAF_ANSWER = "LEAF-ANSWER-5e8";

type Revocation = "none" | "requester reset" | "explicit stop";

type Item = { type?: unknown; role?: unknown; name?: unknown; call_id?: unknown; output?: unknown };

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(strings);
  }
  return value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
}

function items(body: unknown): Item[] {
  const input = (body as { input?: unknown }).input;
  return Array.isArray(input) ? (input as Item[]) : [];
}

function calls(body: unknown, name: string): number {
  return items(body).filter((item) => item?.type === "function_call" && item.name === name).length;
}

function toolOutput(body: unknown, name: string): string | undefined {
  const all = items(body);
  const call = all.findLast((item) => item?.type === "function_call" && item.name === name);
  const output = all.find(
    (item) => item?.type === "function_call_output" && item.call_id === call?.call_id,
  )?.output;
  return output === undefined ? undefined : strings(output).join("");
}

/** Input added since the model last answered: the current turn's new messages. */
function newestInput(body: unknown): string {
  const all = items(body);
  const last = all.findLastIndex(
    (item) => item?.type === "function_call_output" || item?.role === "assistant",
  );
  return strings(all.slice(last + 1)).join("\n");
}

async function startModel(markerPath: string) {
  const runnerSpawned = createDeferred<SpawnReceipt>();
  const leafSpawned = createDeferred<SpawnReceipt>();
  const followupStarted = createDeferred();
  const allowFollowupReply = createDeferred();
  const releaseLeaf = createDeferred();
  const settleAccepted = createDeferred();
  const control: { beforeEffect?: () => Promise<void> } = {};
  let settleWakes = 0;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const raw = await readRequestText(request);
    const body = JSON.parse(raw) as unknown;
    const reply = (text: string) =>
      writeOpenAiResponsesText(response, {
        text,
        messageId: `msg_${randomUUID()}`,
        responseId: `resp_${randomUUID()}`,
      });
    const newest = newestInput(body);
    if (raw.includes(ROOT)) {
      if (newest.includes(ROOT_FOLLOWUP)) {
        writeToolCall(response, "sessions_send", {
          sessionKey: (await runnerSpawned.promise).childSessionKey,
          message: RUNNER_FOLLOWUP,
          mode: "followup",
          timeoutSeconds: 0,
        });
        return;
      }
      if (calls(body, "sessions_spawn") === 0) {
        writeToolCall(response, "sessions_spawn", { task: RUNNER, context: "isolated" });
        return;
      }
      const receipt = findSubagentSpawnReceipt(toolOutput(body, "sessions_spawn"));
      if (receipt) {
        runnerSpawned.resolve(receipt);
      }
      reply("NO_REPLY");
      return;
    }
    if (raw.includes(RUNNER)) {
      if (newest.includes(LEAF_ANSWER)) {
        settleWakes += 1;
        settleAccepted.resolve();
        await control.beforeEffect?.();
        writeToolCall(response, "write", { path: markerPath, content: "settle effect\n" });
        return;
      }
      if (newest.includes(RUNNER_FOLLOWUP)) {
        followupStarted.resolve();
        await allowFollowupReply.promise;
        reply("Follow-up noted.");
        return;
      }
      if (calls(body, "sessions_spawn") === 0) {
        writeToolCall(response, "sessions_spawn", { task: LEAF, context: "isolated" });
        return;
      }
      if (calls(body, "sessions_yield") === 0) {
        const leaf = findSubagentSpawnReceipt(toolOutput(body, "sessions_spawn"));
        if (leaf) {
          leafSpawned.resolve(leaf);
        }
        writeToolCall(response, "sessions_yield", {});
        return;
      }
      reply("RUNNER-DONE");
      return;
    }
    if (raw.includes(LEAF)) {
      await releaseLeaf.promise;
      reply(LEAF_ANSWER);
      return;
    }
    reply("NO_REPLY");
  }
  const server = await startOpenAiResponsesModelServer({
    modelId: "settle-turnover",
    bindError: "Expected settle turnover model server address",
    onRequest: async (request, response) => {
      try {
        await handle(request, response);
      } catch (error) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    },
  });
  return {
    url: `${server.baseUrl}/v1`,
    control,
    settleWakes: () => settleWakes,
    runnerSpawned: runnerSpawned.promise,
    leafSpawned: leafSpawned.promise,
    followupStarted: followupStarted.promise,
    allowFollowupReply: allowFollowupReply.resolve,
    releaseLeaf: releaseLeaf.resolve,
    settleAccepted: settleAccepted.promise,
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

/** Resolves once a registry publication makes `find` return a row. */
function untilRun(find: () => SubagentRunRecord | undefined): Promise<SubagentRunRecord> {
  const found = createDeferred<SubagentRunRecord>();
  const check = () => {
    const row = find();
    if (row) {
      found.resolve(row);
    }
  };
  const stop = subscribeSubagentRunChanges("persistence", check);
  check();
  return found.promise.finally(stop);
}

afterEach(() => resetSubagentRegistryForTests({ persist: false }));

it.each<Revocation>(["none", "requester reset", "explicit stop"])(
  "a runner's settle wake survives a queued follow-up turnover; revocation after acceptance: %s",
  async (revocation) => {
    const state = await createOpenClawTestState({ label: "subagent-settle-turnover" });
    const markerPath = path.join(state.workspaceDir, "settle-effect.txt");
    const model = await startModel(markerPath);
    const base = createSubagentModelConfig(state.workspaceDir, {
      baseUrl: model.url,
      modelId: "settle-turnover",
      name: "Settle turnover",
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
      token: "settle-turnover-token",
    });
    const send = (message: string) =>
      gateway.client.request<{ runId: string }>("chat.send", {
        sessionKey: "main",
        message,
        idempotencyKey: `settle-turnover-${randomUUID()}`,
        deliver: false,
      });
    const wait = (runId: string) =>
      gateway.client.request<{ status: string }>("agent.wait", { runId, timeoutMs: 30_000 });
    try {
      await gateway.server.startupSettled;
      await wait((await send(ROOT)).runId);
      const runner = await within(model.runnerSpawned, 30_000, () => "root never spawned runner");
      const leaf = await within(model.leafSpawned, 30_000, () => "runner never spawned leaf");
      await within(
        untilRun(() => {
          const row = getSubagentRunByRunId(runner.runId);
          return row?.pauseReason === "sessions_yield" ? row : undefined;
        }),
        30_000,
        () => "runner never yielded for its leaf",
      );
      model.control.beforeEffect = async () => {
        if (revocation === "requester reset") {
          await gateway.client.request("sessions.reset", {
            key: runner.childSessionKey,
            reason: "reset",
          });
        } else if (revocation === "explicit stop") {
          await gateway.client.request("sessions.abort", {
            key: runner.childSessionKey,
            userInitiated: true,
          });
        }
      };

      const followup = await send(ROOT_FOLLOWUP);
      await within(model.followupStarted, 30_000, () => "runner follow-up never started");
      model.releaseLeaf();
      // The settle wake replaces the yielded run while the follow-up still runs.
      const settleRun = await within(
        untilRun(() =>
          [...subagentRuns.values()].find(
            (run) =>
              run.childSessionKey === runner.childSessionKey &&
              run.runId.startsWith("announce:requester-settle:"),
          ),
        ),
        30_000,
        () => "runner settle wake never reached its session",
      );
      // A second follow-up queues behind the settle wake as the runner's newest run.
      await wait((await send(ROOT_FOLLOWUP)).runId);
      model.allowFollowupReply();
      await wait(followup.runId);

      await within(
        model.settleAccepted,
        30_000,
        () =>
          `runner never received the leaf answer; leaf delivery ${JSON.stringify(getSubagentRunByRunId(leaf.runId)?.delivery)}`,
      );
      await wait(settleRun.runId);
      const leafDelivery = await within(
        untilRun(() => {
          const row = getSubagentRunByRunId(leaf.runId);
          return row?.delivery?.status === "delivered" || revocation !== "none" ? row : undefined;
        }),
        30_000,
        () => `leaf result never recorded: ${JSON.stringify(getSubagentRunByRunId(leaf.runId))}`,
      ).then((row) => row.delivery?.status);
      const history = await gateway.client.request<{ messages: Array<{ customType?: string }> }>(
        "chat.history",
        { sessionKey: runner.childSessionKey },
      );
      expect({
        settleWakes: model.settleWakes(),
        effectWritten: existsSync(markerPath),
        failedReplies: history.messages.filter(
          (message) => message.customType === "run-failed-before-reply",
        ).length,
        ...(revocation === "none" ? { leafDelivery } : {}),
      }).toEqual({
        settleWakes: 1,
        effectWritten: revocation === "none",
        failedReplies: 0,
        ...(revocation === "none" ? { leafDelivery: "delivered" } : {}),
      });
    } finally {
      model.allowFollowupReply();
      model.releaseLeaf();
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "settle turnover proof complete" });
      await model.close();
      await state.cleanup();
    }
  },
  120_000,
);
