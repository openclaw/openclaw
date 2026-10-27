import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { buffer as readRequest } from "node:stream/consumers";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { createFixtureLifetime } from "openclaw/plugin-sdk/test-env";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createQaGatewayChild,
  type QaGatewayChild,
  startQaMockOpenAiServer,
  writeJson,
} from "../../../../extensions/qa-lab/api.js";
import { isProjectedForwardedMessage } from "../../../../src/gateway/chat-display-projection.helpers.js";
import type { SessionsListResult } from "../../../../src/gateway/session-utils.types.js";
import { listenLoopback } from "../../../helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { createQaPreparedRepoCliCommand } from "../../../helpers/qa-prepared-repo-cli.js";
import {
  bindTelegramProof,
  telegramProofChannel,
  forwardTelegramProvider,
  createTelegramApi,
  succeedTelegram as succeed,
  telegramGatewayOptions,
} from "./telegram-gateway.test-support.js";

type JsonObject = Record<string, unknown>;
const BOT_TOKEN = `424242:${"A".repeat(35)}`;
const CHAT_ID = -1001234;
const FILE_NAME = "qa-empty-response-side-effect.txt";
const FILE_CONTENT = "side effect completed once\n";
const RECOVERY_INSTRUCTION =
  "Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step:";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const fixture = createFixtureLifetime();
const setupAbort = new AbortController();
let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>>;
let owner: ReturnType<typeof createQaGatewayChild>;
let gateway: QaGatewayChild;
let workspace: string;

let sendCount = 0;
const api = createTelegramApi({
  token: BOT_TOKEN,
  bot: { id: 424242, is_bot: true, first_name: "QA", username: "qa_artifact_bot" },
  chat: { id: CHAT_ID, type: "supergroup" },
  messageId: () => 10_000 + ++sendCount,
});
api.updates.enqueue({
  update_id: 1,
  message: {
    message_id: 456,
    date: 1_754_000_000,
    chat: { id: CHAT_ID, type: "supergroup", title: "QA" },
    from: { id: 777, is_bot: false, first_name: "QA" },
    text: "Reply with exactly `TELEGRAM-ROUTE-READY`.",
  },
});
const documents: Array<{ chatId: string; name: string; content: string }> = [];
const writeCalls: JsonObject[] = [];
const toolCalls: JsonObject[] = [];
const completedWrites: JsonObject[] = [];
const finalizers: JsonObject[] = [];
const markerResponses: boolean[] = [];
let overloads = 0;
const marker = `QA-RECOVERED-ARTIFACT-${randomUUID()}`;
const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (!pathname.startsWith("/v1/") && !pathname.endsWith("/sendDocument")) {
    await api.handle(req, res);
    return;
  }
  const raw = await readRequest(req);
  if (pathname.startsWith("/v1/")) {
    const body = raw.length ? (JSON.parse(raw.toString()) as JsonObject) : {};
    const input = (body.input ?? []) as JsonObject[];
    const modelRequest = pathname === "/v1/responses";
    // A finalizer carries historical tool output too. Its current instruction
    // must take precedence over the original failed continuation.
    const finalizer =
      modelRequest &&
      JSON.stringify(input.findLast((item) => item.role === "user")?.content)?.includes(
        RECOVERY_INSTRUCTION,
      );
    const completedWrite = input.find(
      (item) =>
        (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
        writeCalls.some((call) => call.call_id === item.call_id),
    );
    if (finalizer) {
      finalizers.push(body);
    } else if (modelRequest && completedWrite) {
      completedWrites.push(completedWrite);
      overloads += 1;
      writeOpenAiResponsesSse(res, [
        {
          type: "response.failed",
          response: {
            id: "qa-overload",
            object: "response",
            status: "failed",
            output: [],
            error: {
              code: "server_is_overloaded",
              message: "QA capacity failure after completed write",
            },
          },
        },
      ]);
      return;
    }
    const upstream = await forwardTelegramProvider(req, mock.baseUrl, pathname, raw.toString());
    const payload = await upstream.text();
    if (modelRequest) {
      const events = payload
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice(6)) as JsonObject);
      for (const event of events) {
        const item = event.item as JsonObject | undefined;
        if (
          event.type === "response.output_item.done" &&
          item &&
          (item.type === "function_call" || item.type === "custom_tool_call")
        ) {
          toolCalls.push(item);
          if (JSON.stringify(item).includes(FILE_NAME)) {
            writeCalls.push(item);
          }
        }
      }
      if (
        events.some(
          (event) =>
            event.type === "response.output_text.done" && String(event.text).includes(marker),
        )
      ) {
        markerResponses.push(finalizer);
      }
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(payload);
    return;
  }

  const [, token = "", method = ""] = pathname.match(/^\/bot([^/]+)\/([^/]+)$/) ?? [];
  if (token !== BOT_TOKEN) {
    writeJson(res, 401, { ok: false });
    return;
  }
  if (method === "sendDocument") {
    const form = await new Response(new Uint8Array(raw), {
      headers: { "content-type": String(req.headers["content-type"]) },
    }).formData();
    // grammY names the upload separately and sends its attachment reference in document.
    const reference = form.get("document");
    if (typeof reference !== "string" || !reference.startsWith("attach://")) {
      throw new Error("Telegram document did not reference a multipart upload");
    }
    const document = form.get(reference.slice("attach://".length));
    expect(document).toBeInstanceOf(File);
    const file = document as File;
    const chatId = form.get("chat_id");
    if (typeof chatId !== "string") {
      throw new Error("Telegram document delivery requires a string chat_id");
    }
    documents.push({
      chatId,
      name: file.name,
      content: await file.text(),
    });
    succeed(res, {
      message_id: 20_000 + documents.length,
      date: 1_754_000_000,
      chat: { id: CHAT_ID, type: "supergroup" },
      document: { file_id: "qa-file", file_unique_id: "qa-file", file_name: file.name },
    });
  }
};

afterAll(async () => {
  // Close setup admission before joining it; a timed-out acquisition can still resolve.
  setupAbort.abort();
  await runQaGatewayFixture(
    async () => {
      if (owner) {
        await fixture.verifyCleanup(() => stopQaGatewayFixture(owner));
      }
    },
    () => fixture.cleanup(),
  );
});

// The test deadline starts after Gateway readiness; bootstrap keeps its existing hook budget.
beforeAll(async () => {
  await fixture.acquire(async (rejectAfterCleanup) => {
    const cleanups: Array<() => Promise<void>> = [];
    // One composite acquisition preserves Gateway-before-endpoint cleanup ordering.
    const cleanup = () => runQaGatewayFixture(async () => {}, ...cleanups.toReversed());
    try {
      setupAbort.signal.throwIfAborted();
      mock = await startQaMockOpenAiServer();
      cleanups.push(() => mock.stop());
      setupAbort.signal.throwIfAborted();
      const server = createServer((req, res) => {
        void handleRequest(req, res).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          writeJson(res, 500, {
            ok: false,
            error_code: 500,
            description: sliceUtf16Safe(
              redactSensitiveText(message.replaceAll(BOT_TOKEN, "<bot-token>"), { mode: "tools" }),
              0,
              2_048,
            ),
          });
        });
      });
      const sockets = new Set<Socket>();
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      cleanups.push(async () => {
        for (const poll of api.updates.pendingPolls) {
          poll.destroy();
        }
        if (!server.listening) {
          return;
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          // Retain the cross-runtime socket drain used by withServer during teardown.
          for (const socket of sockets) {
            socket.destroy();
          }
        });
      });
      const apiRoot = await listenLoopback(server);
      setupAbort.signal.throwIfAborted();
      workspace = fixture.createTempDir("openclaw-recovered-artifact-");
      // Force terminal recovery after one attempt without replaying the completed write.
      await mkdir(path.join(workspace, ".openclaw"), { recursive: true });
      setupAbort.signal.throwIfAborted();
      await writeFile(
        path.join(workspace, ".openclaw", "settings.json"),
        JSON.stringify({ retry: { provider: { maxRetries: 0 } } }),
      );
      setupAbort.signal.throwIfAborted();
      owner = createQaGatewayChild();
      // Register the synchronous owner before startup can reject or time out.
      cleanups.push(() => stopQaGatewayFixture(owner));
      gateway = await owner.start(
        telegramGatewayOptions({
          workspace,
          apiRoot,
          command: createQaPreparedRepoCliCommand(repoRoot),
          initializeCurrentRuntimeState: true,
          forcedRuntime: "codex",
          providerMode: "mock-openai",
          providerBaseUrl: `${apiRoot}/v1`,
          mockSessionObserverUrl: mock.sessionObserverUrl,
          telegram: telegramProofChannel(apiRoot, BOT_TOKEN, {
            groupPolicy: "open",
            groups: {
              [String(CHAT_ID)]: { groupPolicy: "open", requireMention: false },
            },
            streaming: { mode: "off" },
            commands: { native: false },
          }),
          runtimeEnvPatch: {
            OPENCLAW_SKIP_CHANNELS: undefined,
            OPENCLAW_SKIP_PROVIDERS: undefined,
          },
          mutateConfig: (cfg) => {
            bindTelegramProof(cfg);
            return cfg;
          },
        }),
      );
      setupAbort.signal.throwIfAborted();
      return { cleanup };
    } catch (error) {
      return await rejectAfterCleanup(error, cleanup);
    }
  });
});

test("delivers a recovered artifact once while preserving its inter-session transcript", async ({
  signal,
}) => {
  return fixture.run(async () => {
    signal.throwIfAborted();
    const sessions = async () =>
      (await gateway.call("sessions.list", { agentId: "qa", limit: 100 })) as SessionsListResult;
    await expect
      .poll(
        () =>
          api.calls.some(
            ({ method, body }) =>
              method === "sendMessage" &&
              String(body.chat_id) === String(CHAT_ID) &&
              body.text === "TELEGRAM-ROUTE-READY",
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    const matchingSessions = (await sessions()).sessions.filter(
      (row) =>
        row.lastChannel === "telegram" &&
        row.lastTo === `telegram:${CHAT_ID}` &&
        row.lastAccountId === "proof",
    );
    expect(matchingSessions.map(({ key }) => typeof key)).toEqual(["string"]);
    const sessionKey = matchingSessions[0]!.key;
    const activeRun = async () =>
      (await sessions()).sessions.find((row) => row.key === sessionKey)?.hasActiveRun;
    const expectSettled = () => expect.poll(activeRun, { timeout: 30_000 }).toBe(false);
    await expectSettled();
    expect(documents).toHaveLength(0);
    // Exclude seed-run context reads, but count every recovery tool call.
    const recoveryToolStart = toolCalls.length;
    const receipt = (await gateway.call("chat.send", {
      sessionKey,
      message: `Empty response after write recovery QA check: write ${FILE_NAME}, then reply with exact marker: \`${marker}\nMEDIA:./${FILE_NAME}\`.`,
      deliver: false,
      idempotencyKey: randomUUID(),
      systemInputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceSessionKey: "agent:qa:artifact-requester",
      },
    })) as { runId: string };
    expect(receipt.runId).toBeTypeOf("string");
    const waited = await gateway.call(
      "agent.wait",
      { runId: receipt.runId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
    expect(waited).toMatchObject({ status: "ok" });
    await expect.poll(() => documents.length, { timeout: 30_000 }).toBe(1);
    const history = (await gateway.call("chat.history", { sessionKey, limit: 30 })) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const markerMessages = history.messages.filter(
      (message) => message.role === "assistant" && JSON.stringify(message.content).includes(marker),
    );
    // Forwarded requests display as assistants; distinguish them from authored recovery.
    const forwardedMessages = markerMessages.filter(isProjectedForwardedMessage);
    expect(forwardedMessages).toHaveLength(1);
    expect(forwardedMessages[0]).toMatchObject({
      provenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceSessionKey: "agent:qa:artifact-requester",
      },
      senderSession: { sessionKey: "agent:qa:artifact-requester" },
    });
    expect(markerMessages.filter((message) => !isProjectedForwardedMessage(message))).toHaveLength(
      1,
    );
    await expectSettled();
    expect(await readFile(path.join(workspace, FILE_NAME), "utf8")).toBe(FILE_CONTENT);
    // Freeze delivery counts after Gateway exit, keeping both endpoints alive until then.
    await stopQaGatewayFixture(owner);
    for (const calls of [toolCalls.slice(recoveryToolStart), writeCalls, finalizers]) {
      expect(calls).toHaveLength(1);
    }
    expect(completedWrites).toHaveLength(1);
    expect(completedWrites[0]?.call_id).toBe(writeCalls[0]?.call_id);
    expect(overloads).toBe(1);
    // Codex 0.164 advertises apply_patch without an environment; native execution rejects it.
    expect(finalizers[0]?.tools).toEqual([
      expect.objectContaining({ type: "custom", name: "apply_patch" }),
    ]);
    expect(JSON.stringify(finalizers[0]?.input)).toContain(
      "Tools are unavailable in this step: it is a text-only pass",
    );
    expect(markerResponses).toEqual([true]);
    expect(documents).toEqual([
      { chatId: String(CHAT_ID), name: FILE_NAME, content: FILE_CONTENT },
    ]);
  });
}, 120_000);
