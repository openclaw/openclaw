// Real model HTTP, real exec tool, lifecycle-produced SQLite, and a shipped Gateway restart.
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isInternalRuntimeContextCarrierText } from "../extensions/qa-lab/api.js";
import { loadSubagentRegistryFromSqlite } from "../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { stripEnvelope } from "../src/shared/chat-envelope.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

const SESSION_KEY = "agent:main:slack:channel:completion-replay";
const CHILD_TASK = "Produce CHILD_REPLAY_RESULT.";
const MODEL_REF = "completion-replay/completion-replay";
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

describe("Gateway completed requester replay", () => {
  it(
    "does not repeat a real requester tool effect through fallback, settle wake, or restart",
    {
      timeout: 180_000,
    },
    async () => {
      const model = await startModel();
      servers.push(model);
      const instance = await createOpenClawTestInstance({
        name: "gateway-completion-replay",
        config: config(model.url),
        env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      });
      instances.push(instance);
      instance.state.applyEnv();
      await instance.startGateway();
      const effectPath = path.join(
        instance.homeDir,
        ".openclaw",
        "workspace",
        "replay-effects.txt",
      );
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      try {
        expect(
          await client.request(
            "agent",
            {
              sessionKey: SESSION_KEY,
              message: "START_REPLAY_REQUESTER",
              deliver: false,
              idempotencyKey: "start-replay-requester",
            },
            { expectFinal: true, timeoutMs: 90_000 },
          ),
        ).toMatchObject({ status: "ok" });
        await vi.waitFor(() => expect(model.childStarted()).toBe(true), { timeout: 30_000 });
        model.releaseChild();
        await vi.waitFor(
          async () => expect(await fs.readFile(effectPath, "utf8")).toBe("effect\n"),
          {
            timeout: 30_000,
          },
        );
        await vi.waitFor(
          () => {
            const entry = [...loadSubagentRegistryFromSqlite().values()].find(
              (row) => row.task === CHILD_TASK,
            );
            expect(entry?.delivery).toMatchObject({
              status: "suspended",
              suspendedReason: "permanent_failure",
              lastDropReason: "message_tool_delivery_missing",
            });
          },
          { timeout: 30_000 },
        );
        const suspendedChild = [...loadSubagentRegistryFromSqlite().values()].find(
          (row) => row.task === CHILD_TASK,
        );
        expect(model.effectCalls()).toBe(1);
        expect(model.failures()).toEqual([]);
        console.log(
          "[gateway-completion-replay-runtime-proof]",
          JSON.stringify({
            phase: "requester-effect-before-restart",
            requesterEffectCalls: model.effectCalls(),
            persistedEffectLines: (await fs.readFile(effectPath, "utf8")).trim().split("\n").length,
            childDeliveryStatus: suspendedChild?.delivery?.status,
            childSuspendedReason: suspendedChild?.delivery?.suspendedReason,
          }),
        );
      } catch (error) {
        throw new Error(
          String(error) +
            "\nFixture failures: " +
            JSON.stringify(model.failures()) +
            "\nGateway: " +
            instance.logs(),
          { cause: error },
        );
      } finally {
        model.releaseChild();
        await disconnectGatewayClient(client);
        await instance.stopGateway();
      }

      // No manually seeded terminal row: the child and completion above created it.
      const before = [...loadSubagentRegistryFromSqlite().values()].find(
        (row) => row.task === CHILD_TASK,
      )!;
      expect(before.execution.outcome).toMatchObject({ status: "ok" });
      expect(before.completion?.resultText).toBe("CHILD_REPLAY_RESULT");
      expect(before.delivery?.payload).toBeDefined();
      expect(before.requesterSettleWake).toBeUndefined();
      closeOpenClawStateDatabaseForTest();
      expect(loadSubagentRegistryFromSqlite().get(before.runId)?.delivery).toEqual(before.delivery);
      closeOpenClawStateDatabaseForTest();

      await instance.startGateway();
      const restoredClient = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
      });
      try {
        // A real same-session round trip is the lane barrier, not a timed sleep.
        const followup = await restoredClient.request(
          "agent",
          {
            sessionKey: SESSION_KEY,
            message: "EXPLICIT_FOLLOWUP_AFTER_RESTART",
            deliver: false,
            idempotencyKey: "followup-after-restart",
          },
          { expectFinal: true, timeoutMs: 30_000 },
        );
        expect(followup).toMatchObject({ status: "ok" });
        expect(model.effectCalls()).toBe(1);
        expect(model.failures()).toEqual([]);
        await expect(fs.readFile(effectPath, "utf8")).resolves.toBe("effect\n");
        console.log(
          "[gateway-completion-replay-runtime-proof]",
          JSON.stringify({
            phase: "requester-effect-after-restart",
            followupStatus: (followup as { status?: string }).status,
            requesterEffectCalls: model.effectCalls(),
            persistedEffectLines: (await fs.readFile(effectPath, "utf8")).trim().split("\n").length,
            effectUnchanged: (await fs.readFile(effectPath, "utf8")) === "effect\n",
          }),
        );
      } finally {
        await disconnectGatewayClient(restoredClient);
        await instance.stopGateway();
      }
      const after = loadSubagentRegistryFromSqlite().get(before.runId)!;
      expect(after.delivery).toEqual(before.delivery);
      expect(after.requesterSettleWake).toBeUndefined();
    },
  );
});

function config(url: string): OpenClawConfig {
  return {
    plugins: { enabled: false },
    messages: { groupChat: { visibleReplies: "message_tool" } },
    agents: {
      defaults: {
        model: { primary: MODEL_REF },
        models: { [MODEL_REF]: { agentRuntime: { id: "openclaw" } } },
        skipBootstrap: true,
        skills: [],
      },
    },
    tools: {
      profile: "coding",
      codeMode: false,
      toolSearch: false,
      allow: ["sessions_spawn", "exec"],
      exec: { security: "full", ask: "off" },
    },
    models: {
      mode: "replace",
      providers: {
        "completion-replay": {
          baseUrl: url + "/v1",
          apiKey: "test-placeholder",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "completion-replay",
              name: "completion-replay",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  };
}

type ModelInput = {
  type?: string;
  role?: string;
  name?: string;
  call_id?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  output?: unknown;
};

function modelInputText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}

async function startModel() {
  const child = createDeferred();
  const failures: string[] = [];
  let childStarted = false;
  let effectCalls = 0;
  let sequence = 0;
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      failures.push(String(error));
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { input?: ModelInput[] };
    const input = body.input ?? [];
    const serializedUserTexts = input
      .filter((item) => item.role === "user")
      .map((item) => modelInputText(item.content));
    const latestUser = input
      .toReversed()
      .find(
        (item) =>
          item.role === "user" &&
          !isInternalRuntimeContextCarrierText(modelInputText(item.content)),
      );
    const text = JSON.stringify(latestUser?.content);
    const selectedUserText = latestUser?.role === "user" ? modelInputText(latestUser.content) : "";
    if (selectedUserText.includes("START_REPLAY_REQUESTER")) {
      console.log(
        "[gateway-completion-replay-provider-proof]",
        JSON.stringify({
          phase: "requester-selected",
          serializedRuntimeCarriersSkipped: serializedUserTexts.filter(
            isInternalRuntimeContextCarrierText,
          ).length,
          requesterTurnSelected: selectedUserText.includes("START_REPLAY_REQUESTER"),
        }),
      );
    }
    const last = input.at(-1);
    const id = String(++sequence);
    const final = (value: string) =>
      writeOpenAiResponsesText(response, {
        text: value,
        messageId: "msg_" + id,
        responseId: "resp_" + id,
      });
    if (text?.includes("[Subagent Task]") && text.split("\n\n").includes(CHILD_TASK)) {
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("model listener missing");
  }
  return {
    url: "http://127.0.0.1:" + address.port,
    releaseChild: () => child.resolve(undefined),
    childStarted: () => childStarted,
    effectCalls: () => effectCalls,
    failures: () => failures,
    close: async () => {
      child.resolve(undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
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
