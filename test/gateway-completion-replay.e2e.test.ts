import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { isInternalRuntimeContextCarrierText } from "../extensions/qa-lab/api.js";
import { loadSubagentRegistryFromSqlite } from "../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import {
  closeHttpServer,
  connectProofClient,
  contentTexts,
  createModelGatewayProof,
  listenLoopback,
  readRequestText,
  respondJson,
} from "./helpers/gateway-integration-fixtures.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import type { OpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

const SESSION_KEY = "agent:main:slack:channel:completion-replay";
const CHILD_TASK = "Produce CHILD_REPLAY_RESULT.";
const instances: OpenClawTestInstance[] = [];
const servers: Array<Awaited<ReturnType<typeof startModel>>> = [];

afterEach(async () => {
  for (const server of servers) {
    server.releaseChild();
  }
  await Promise.allSettled(instances.splice(0).map((instance) => instance.cleanup()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  closeOpenClawStateDatabaseForTest();
});

it(
  "does not repeat a real requester tool effect through fallback, settle wake, or restart",
  {
    timeout: 180_000,
  },
  async () => {
    const model = await startModel();
    servers.push(model);
    const instance = await createModelGatewayProof({
      name: "gateway-completion-replay",
      baseUrl: model.url,
      modelId: "completion-replay",
      toolProfile: "coding",
      config: (base) => ({
        ...base,
        plugins: { enabled: false },
        messages: { groupChat: { visibleReplies: "message_tool" } },
        tools: {
          profile: "coding",
          codeMode: false,
          toolSearch: false,
          allow: ["sessions_spawn", "exec"],
          exec: { security: "full", ask: "off" },
        },
      }),
    });
    instances.push(instance);
    instance.state.applyEnv();
    await instance.startGateway();
    const effectPath = path.join(instance.homeDir, ".openclaw", "workspace", "replay-effects.txt");
    let client = await connectProofClient(instance, {
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    const turn = (message: string, idempotencyKey: string, timeoutMs: number) =>
      client.request(
        "agent",
        { sessionKey: SESSION_KEY, message, deliver: false, idempotencyKey },
        { expectFinal: true, timeoutMs },
      );
    const childEntry = () =>
      [...loadSubagentRegistryFromSqlite().values()].find((row) => row.task === CHILD_TASK)!;
    try {
      await expect(
        turn("START_REPLAY_REQUESTER", "start-replay-requester", 90_000),
      ).resolves.toMatchObject({ status: "ok" });
      await vi.waitFor(() => expect(model.childStarted()).toBe(true), { timeout: 30_000 });
      model.releaseChild();
      await vi.waitFor(async () => expect(await fs.readFile(effectPath, "utf8")).toBe("effect\n"), {
        timeout: 30_000,
      });
      await vi.waitFor(
        () => {
          expect(childEntry()?.delivery).toMatchObject({
            status: "suspended",
            suspendedReason: "permanent_failure",
            lastDropReason: "message_tool_delivery_missing",
          });
        },
        { timeout: 30_000 },
      );
      expect(model.effectCalls()).toBe(1);
      expect(model.failures()).toEqual([]);
    } catch (error) {
      throw new Error(
        `${String(error)}\nFixture failures: ${JSON.stringify(model.failures())}\nGateway: ${instance.logs()}`,
        { cause: error },
      );
    } finally {
      model.releaseChild();
      await disconnectGatewayClient(client);
      await instance.stopGateway();
    }

    // No manually seeded terminal row: the child and completion above created it.
    const before = childEntry();
    expect(before).toMatchObject({
      execution: { outcome: { status: "ok" } },
      completion: { resultText: "CHILD_REPLAY_RESULT" },
    });
    expect(before.delivery?.payload).toBeDefined();
    expect(before.requesterSettleWake).toBeUndefined();
    closeOpenClawStateDatabaseForTest();
    expect(loadSubagentRegistryFromSqlite().get(before.runId)?.delivery).toEqual(before.delivery);
    closeOpenClawStateDatabaseForTest();

    await instance.startGateway();
    client = await connectProofClient(instance);
    try {
      // A real same-session round trip is the lane barrier, not a timed sleep.
      await expect(
        turn("EXPLICIT_FOLLOWUP_AFTER_RESTART", "followup-after-restart", 30_000),
      ).resolves.toMatchObject({ status: "ok" });
      expect(model.effectCalls()).toBe(1);
      expect(model.failures()).toEqual([]);
      await expect(fs.readFile(effectPath, "utf8")).resolves.toBe("effect\n");
    } finally {
      await disconnectGatewayClient(client);
      await instance.stopGateway();
    }
    const after = loadSubagentRegistryFromSqlite().get(before.runId)!;
    expect(after.delivery).toEqual(before.delivery);
    expect(after.requesterSettleWake).toBeUndefined();
  },
);

type ModelInput = {
  type?: string;
  role?: string;
  name?: string;
  call_id?: string;
  content?: unknown;
  output?: unknown;
};

async function startModel() {
  const child = createDeferred();
  const failures: string[] = [];
  let childStarted = false;
  let effectCalls = 0;
  let sequence = 0;
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      failures.push(String(error));
      respondJson(response, { error: { message: String(error) } }, 400);
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(await readRequestText(request)) as { input?: ModelInput[] };
    const input = body.input ?? [];
    const latestUser = input
      .toReversed()
      .find(
        (item) =>
          item.role === "user" &&
          !isInternalRuntimeContextCarrierText(contentTexts(item.content).join("\n")),
      );
    const text = JSON.stringify(latestUser?.content);
    const last = input.at(-1);
    const id = String(++sequence);
    const final = (value: string) =>
      writeOpenAiResponsesText(response, {
        text: value,
        messageId: "msg_" + id,
        responseId: "resp_" + id,
      });
    if (text?.includes("[Subagent Task]") && text.includes(CHILD_TASK)) {
      childStarted = true;
      await child.promise;
      final("CHILD_REPLAY_RESULT");
    } else if (text?.includes("EXPLICIT_FOLLOWUP_AFTER_RESTART")) {
      final("EXPLICIT_FOLLOWUP_OK");
    } else if (text?.includes("Subagent completion delivery is blocked:")) {
      // The host may run this durable notice as its own turn or fold it into the
      // next prompt; either way it is a notification, not a completion retry.
      final("Completion delivery is blocked.");
    } else if (last?.type === "function_call_output") {
      // Runtime normalization may change IDs; follow the actual call/output pair.
      const call = input.findLast(
        (item) => item.type === "function_call" && item.call_id === last.call_id,
      );
      if (call?.name === "sessions_spawn") {
        if (!JSON.stringify(last.output).includes("accepted")) {
          throw new Error("real sessions_spawn did not accept: " + JSON.stringify(last.output));
        }
        final("Child is running.");
      } else if (call?.name === "exec") {
        if (last.output !== "(no output)") {
          throw new Error("real exec did not succeed: " + JSON.stringify(last.output));
        }
        final("Requester finished without using the message tool.");
      } else {
        throw new Error(
          "unexpected tool output: " +
            JSON.stringify({
              last,
              latestUser,
              calls: input.filter((item) => item.type === "function_call"),
            }),
        );
      }
    } else if (text?.includes("START_REPLAY_REQUESTER")) {
      tool(response, id, "spawn_" + id, "sessions_spawn", {
        task: CHILD_TASK,
        runtime: "subagent",
        mode: "run",
        cleanup: "keep",
      });
    } else {
      // Every completion or implicit retry attempts a non-idempotent real tool.
      // The file, not this request counter, proves whether it actually executed.
      effectCalls++;
      if (effectCalls > 3) {
        throw new Error("completion replay exceeded finite proof census");
      }
      tool(response, id, "effect_" + id, "exec", {
        command: "printf 'effect\\n' >> replay-effects.txt",
      });
    }
  }
  const url = await listenLoopback(server);
  return {
    url,
    releaseChild: () => child.resolve(undefined),
    childStarted: () => childStarted,
    effectCalls: () => effectCalls,
    failures: () => failures,
    close: async () => {
      child.resolve(undefined);
      await closeHttpServer(server).catch(() => undefined);
    },
  };
}

function tool(response: ServerResponse, id: string, callId: string, name: string, args: unknown) {
  const item = {
    type: "function_call",
    id: "fc_" + id,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_" + id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}
