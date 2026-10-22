import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { text as readBody } from "node:stream/consumers";
import { afterEach, beforeEach, expect, it } from "vitest";
import { withFastReplyConfig } from "../../../../src/auto-reply/reply/get-reply-fast-path.test-support.js";
import { enqueueSessionEventForHost } from "../../../../src/auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../../helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { isolatedGatewayEnv } from "./gateway-recovery.test-support.js";
import { resetGatewayState } from "./gateway-startup-routing.test-support.js";

// Real Gateway session-event admission and tool execution; only model HTTP is synthetic.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(resetGatewayState);
afterEach(resetGatewayState);

type Body = {
  instructions?: string;
  input: Array<{ role?: string; type?: string; call_id?: string; output?: string }>;
};

function writeToolCall(response: ServerResponse, name: string, args: Record<string, unknown>) {
  const item = {
    type: "function_call",
    id: "fc_wake",
    call_id: "call_wake",
    name,
    arguments: JSON.stringify(args),
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_wake",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

it(
  "lets an automation notice turn read caller-visible automations",
  { timeout: 120_000 },
  async ({ signal, onTestFinished }) => {
    const home = tempDirs.make("openclaw-system-turn-automations-");
    const stateDir = path.join(home, ".openclaw");
    const workspaceDir = path.join(home, "workspace");
    const configPath = path.join(stateDir, "openclaw.json");
    await Promise.all([stateDir, workspaceDir].map((dir) => fs.mkdir(dir, { recursive: true })));
    const sessionKey = "agent:main:dashboard:" + randomUUID();
    const token = randomUUID();
    const notice =
      '⚠️ Automation "proof" was auto-disabled after 1 consecutive run failures.\nCheck automation history for details.';
    const failure = createDeferred<Error>();
    const ready = createDeferred();
    const inspected = createDeferred<string>();
    const observe = <T>(work: Promise<T>) =>
      withinTest(
        Promise.race([
          work,
          failure.promise.then((error) => {
            throw error;
          }),
        ]),
        signal,
      );
    let step = 0;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let provider: Awaited<ReturnType<typeof startOpenAiResponsesModelServer>> | undefined;
    const env = {
      ...isolatedGatewayEnv,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      ALL_PROXY: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined,
      all_proxy: undefined,
      http_proxy: undefined,
      https_proxy: undefined,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    const scenario = withEnvAsync(env, async () => {
      try {
        provider = await startOpenAiResponsesModelServer({
          modelId: "qa-system-turn",
          bindError: "provider bind failed",
          onRequest: async (request, response) => {
            try {
              const body = JSON.parse(await readBody(request)) as Body;
              const reply = (text: string) =>
                writeOpenAiResponsesText(response, {
                  text,
                  messageId: "m-" + step,
                  responseId: "r-" + step,
                });
              if (JSON.stringify(body).includes("Generate a concise session title")) {
                reply("System turn proof");
                return;
              }
              switch (step++) {
                case 0:
                  reply("Ready.");
                  ready.resolve();
                  break;
                case 1:
                  expect(JSON.stringify(body.input)).toContain(
                    "Check automation history for details.",
                  );
                  writeToolCall(response, "automations", { action: "list" });
                  break;
                case 2: {
                  const output = body.input.find(
                    (item) => item.type === "function_call_output" && item.call_id === "call_wake",
                  )?.output;
                  assert(output !== undefined, "Missing actual automations result");
                  inspected.resolve(output);
                  reply("Automation history inspected.");
                  break;
                }
                default:
                  throw new Error("Unexpected provider request " + step);
              }
            } catch (error) {
              failure.resolve(error instanceof Error ? error : new Error(String(error)));
              throw error;
            }
          },
        });
        const cfg = createOpenAiResponsesModelConfig({
          baseUrl: provider.baseUrl,
          providerId: "mock-openai",
          modelId: "qa-system-turn",
          reasoning: false,
          toolProfile: "full",
        });
        cfg.agents!.defaults!.workspace = workspaceDir;
        cfg.agents!.defaults!.models = {
          "mock-openai/qa-system-turn": {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        };
        cfg.agents!.entries = { main: {} };
        cfg.tools = { allow: ["automations"], codeMode: false, toolSearch: false };
        cfg.gateway = { auth: { mode: "token", token } };
        await fs.writeFile(configPath, JSON.stringify(cfg));
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          origin: "http://127.0.0.1",
          clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          scopes: ["operator.admin"],
        });
        await gateway.server.startupSettled;
        const runtime = getRuntimeConfigSnapshot();
        assert(runtime);
        withFastReplyConfig(runtime);
        await gateway.client.request("chat.send", {
          sessionKey,
          message: "Hello.",
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        await observe(ready.promise);
        // The scheduler's notice producer (server-cron-targets): a system turn with no sender.
        const receipt = enqueueSessionEventForHost(notice, {
          agentId: "main",
          sessionKey,
          source: "cron",
          contextKey: "cron:proof:auto-disabled",
        });
        await observe(receipt.accepted);
        const output = await observe(inspected.promise);
        expect(output).not.toContain("needs the owner's authority");
        expect(output).not.toContain("Other actions need the owner's authority");
        expect(JSON.parse(output)).toMatchObject({ scope: "caller" });
      } finally {
        try {
          if (gateway) {
            try {
              await disconnectGatewayClient(gateway.client);
            } finally {
              await gateway.server.close({ reason: "Isolated system turn proof complete" });
            }
          }
        } finally {
          await provider?.close();
        }
      }
    });
    onTestFinished(async () => {
      await Promise.allSettled([scenario]);
    });
    return scenario;
  },
);
