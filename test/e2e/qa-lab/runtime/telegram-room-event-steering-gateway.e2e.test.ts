import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import { createQaGatewayChild, writeJson } from "../../../../extensions/qa-lab/api.js";
import { buildMockOpenAiResponsesProvider } from "../../../../src/gateway/test-openai-responses-model.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";
import { createDeferred } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const BOT_TOKEN = `424242:${"A".repeat(35)}`;
const CHAT_ID = -1002468135790;
const ORIGINAL = "Compare locations for the original request";
const CORRECTION = "Only include locations open Sunday QA_ROOM_CORRECTION";
const FINAL = "QA_ORIGINAL_RUN_FINISHED";
type Json = Record<string, unknown>;

async function readBody(req: IncomingMessage): Promise<Json> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  return raw ? (JSON.parse(raw) as Json) : {};
}

function respond(res: ServerResponse, index: number, tool = false) {
  if (!tool) {
    writeOpenAiResponsesText(res, {
      text: FINAL,
      messageId: `msg_room_${index}`,
      responseId: `resp_room_${index}`,
    });
    return;
  }
  const item = {
    type: "function_call",
    id: "fc_room_status",
    call_id: "call_room_status",
    name: "session_status",
    arguments: "{}",
    status: "completed",
  };
  writeOpenAiResponsesSse(res, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: "{}",
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_room_${index}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

// Both transports are loopback servers; classification, dispatch, queue admission,
// active agent execution, provider requests, and outbound policy are real code.
test.each([true, false])(
  "Telegram room corrections honor explicit steering without changing implicit defaults (explicit=%s)",
  async (explicitSteer) => {
    const firstResponse = createDeferred();
    const secondResponse = createDeferred();
    const requests: Json[] = [];
    const telegramCalls: Array<{ method: string; body: Json }> = [];
    const updates: Json[] = [];
    const polls = new Set<ServerResponse>();
    const chat = { id: CHAT_ID, type: "supergroup", title: "QA Steering Room" };
    let updateId = 0;
    const sendInbound = (text: string) => {
      const update = {
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat,
          from: { id: 1357, is_bot: false, first_name: "QA Sender" },
          text,
        },
      };
      const poll = polls.values().next().value;
      if (poll) {
        polls.delete(poll);
        writeJson(poll, 200, { ok: true, result: [update] });
      } else {
        updates.push(update);
      }
    };
    await withServer(
      (req, res) => {
        void (async () => {
          const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
          if (pathname === "/v1/models") {
            writeJson(res, 200, { data: [{ id: "gpt-5.4", object: "model" }] });
            return;
          }
          if (pathname === "/v1/responses") {
            requests.push(await readBody(req));
            const index = requests.length;
            if (index === 1) {
              await firstResponse.promise;
            } else if (index === 2) {
              await secondResponse.promise;
            }
            if (!res.destroyed) {
              respond(res, index, index === 1);
            }
            return;
          }
          const [, token, method = ""] = pathname.match(/^\/bot([^/]+)\/([^/]+)$/) ?? [];
          const body = await readBody(req);
          telegramCalls.push({ method, body });
          if (token !== BOT_TOKEN) {
            writeJson(res, 401, { ok: false });
          } else if (method === "getMe") {
            writeJson(res, 200, {
              ok: true,
              result: { id: 424242, is_bot: true, first_name: "QA", username: "qa_steering_bot" },
            });
          } else if (method === "getUpdates") {
            const update = updates.shift();
            if (update) {
              writeJson(res, 200, { ok: true, result: [update] });
            } else {
              polls.add(res);
              res.on("close", () => polls.delete(res));
            }
          } else {
            writeJson(res, 200, {
              ok: true,
              result:
                method === "getChat"
                  ? chat
                  : method === "sendMessage"
                    ? { message_id: 9000 + telegramCalls.length, chat, text: body.text, date: 1 }
                    : true,
            });
          }
        })().catch((error: unknown) => writeJson(res, 500, { error: String(error) }));
      },
      async (apiRoot) =>
        await withTempDir("openclaw-telegram-room-steer-", async (workspace) => {
          const owner = createQaGatewayChild();
          let readRuntimeLogs = () => "";
          const outputDir = path.join(
            repoRoot,
            ".artifacts/qa-e2e/telegram-room-event-steering",
            explicitSteer ? "explicit" : "implicit",
          );
          const evidence: Json = { explicitSteer, passed: false };
          try {
            const provider = buildMockOpenAiResponsesProvider(`${apiRoot}/v1`);
            const gateway = await owner.start({
              repoRoot,
              command: {
                executablePath: process.execPath,
                argsPrefix: [
                  "--import",
                  pathToFileURL(path.join(repoRoot, "scripts/tsx.mjs")).href,
                  path.join(repoRoot, "scripts/run-with-env.mts"),
                  `OPENCLAW_DEV_SOURCE_ROOT=${repoRoot}`,
                  "--",
                  process.execPath,
                  path.join(repoRoot, "openclaw.mjs"),
                ],
                argsSuffix: ["--verbose"],
                cwd: repoRoot,
                usePackagedPlugins: true,
              },
              providerMode: "mock-openai",
              providerBaseUrl: `${apiRoot}/v1`,
              transportBaseUrl: apiRoot,
              transport: {
                requiredPluginIds: ["telegram"],
                createGatewayConfig: () => ({
                  messages: {
                    ...(explicitSteer ? { queue: { mode: "steer" as const } } : {}),
                    groupChat: { unmentionedInbound: "room_event", visibleReplies: "message_tool" },
                  },
                  channels: {
                    telegram: {
                      enabled: true,
                      botToken: BOT_TOKEN,
                      apiRoot,
                      groupPolicy: "allowlist",
                      groupAllowFrom: ["1357"],
                      groups: { "*": { requireMention: false } },
                      commands: { native: false },
                      streaming: { mode: "off" },
                    },
                  },
                }),
              },
              controlUiEnabled: false,
              runtimeEnvPatch: {
                OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
                TELEGRAM_BOT_TOKEN: undefined,
              },
              mutateConfig: (cfg) => {
                cfg.agents!.defaults!.workspace = workspace;
                cfg.agents!.defaults!.model = { primary: provider.modelRef };
                cfg.agents!.defaults!.models = {
                  [provider.modelRef]: {
                    agentRuntime: { id: "openclaw" },
                    params: { transport: "sse", openaiWsWarmup: false },
                  },
                };
                cfg.agents!.entries!.qa!.model = { primary: provider.modelRef };
                cfg.models = { providers: { [provider.providerId]: provider.config } };
                cfg.tools = { profile: "minimal" };
                cfg.logging = { level: "debug", file: path.join(workspace, "gateway.log") };
                cfg.diagnostics = { enabled: true };
                cfg.bindings = [{ agentId: "qa", match: { channel: "telegram" } }];
                return cfg;
              },
            });
            readRuntimeLogs = gateway.logs;
            await expect.poll(() => polls.size, { timeout: 30_000 }).toBeGreaterThan(0);
            sendInbound(ORIGINAL);
            await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(1);
            const baseline = (await gateway.call("diagnostics.stability", { limit: 1 })) as {
              lastSeq?: number;
            };
            sendInbound(CORRECTION);
            // Wait for accepted ingress on either path. Steering dispatch completes
            // only after transcript commitment at a later runtime boundary; its
            // queue reservation is the earlier receipt. Default follow-up returns
            // from dispatch without waiting for the held original turn.
            await expect
              .poll(
                async () => {
                  const snapshot = (await gateway.call("diagnostics.stability", {
                    sinceSeq: baseline.lastSeq ?? 0,
                    limit: 100,
                  })) as { events: Array<{ type: string; channel?: string; source?: string }> };
                  return snapshot.events.some(
                    (event) =>
                      event.channel === "telegram" &&
                      (event.type === "message.dispatch.completed" ||
                        (event.type === "message.queued" &&
                          event.source === "followup-queue-steer")),
                  );
                },
                { timeout: 30_000 },
              )
              .toBe(true);
            expect(requests).toHaveLength(1);
            const runId = /embedded run prompt start: runId=([a-z0-9-]+)/.exec(gateway.logs())?.[1];
            expect(runId).toBeTruthy();
            const originalRunFinished = () =>
              gateway.logs().includes(`embedded run done: runId=${runId} `);
            expect(originalRunFinished()).toBe(false);
            firstResponse.resolve();
            await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(2);
            const continuation = JSON.stringify(requests[1]);
            expect(continuation).toContain("function_call_output");
            expect(continuation).toContain("call_room_status");
            expect(continuation.includes(CORRECTION)).toBe(explicitSteer);
            // The continuation is inspected while its response is still held:
            // the initial run cannot have terminated and started a follow-up.
            expect(originalRunFinished()).toBe(false);
            secondResponse.resolve();
            await expect.poll(originalRunFinished, { timeout: 30_000 }).toBe(true);
            if (!explicitSteer) {
              await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(3);
              expect(JSON.stringify(requests[2])).toContain(CORRECTION);
              const runStarts = Array.from(
                gateway.logs().matchAll(/embedded run prompt start: runId=([a-z0-9-]+)/g),
                (match) => match[1],
              );
              expect(runStarts).toHaveLength(2);
              expect(runStarts[0]).toBe(runId);
              expect(runStarts[1]).not.toBe(runId);
              expect(gateway.logs().indexOf(`embedded run done: runId=${runId} `)).toBeLessThan(
                gateway.logs().indexOf(`embedded run prompt start: runId=${runStarts[1]} `),
              );
            }
            await expect
              .poll(
                async () => {
                  const snapshot = (await gateway.call("diagnostics.stability", {
                    type: "session.state",
                    limit: 50,
                  })) as {
                    events: Array<{ outcome?: string; queueDepth?: number }>;
                  };
                  const latest = snapshot.events.at(-1);
                  return latest?.outcome === "idle" && latest.queueDepth === 0;
                },
                { timeout: 30_000 },
              )
              .toBe(true);
            expect(requests).toHaveLength(explicitSteer ? 2 : 3);
            expect(
              telegramCalls.filter((call) =>
                ["sendMessage", "editMessageText", "sendPhoto", "sendDocument"].includes(
                  call.method,
                ),
              ),
            ).toEqual([]);
            evidence.passed = true;
            evidence.activeRunId = runId;
            evidence.correctionInActiveContinuation = continuation.includes(CORRECTION);
          } finally {
            firstResponse.resolve();
            secondResponse.resolve();
            evidence.modelRequests = requests;
            evidence.lifecycleEvents = readRuntimeLogs()
              .split("\n")
              .filter((line) => /embedded run (prompt start|done):/.test(line));
            evidence.visibleCalls = telegramCalls.filter((call) =>
              ["sendMessage", "editMessageText"].includes(call.method),
            );
            await mkdir(outputDir, { recursive: true });
            await writeFile(
              path.join(outputDir, "verdict.json"),
              `${JSON.stringify(evidence, null, 2)}\n`,
            );
            await stopQaGatewayFixture(owner, { preserveToDir: path.join(outputDir, "gateway") });
          }
        }),
    );
  },
  180_000,
);
