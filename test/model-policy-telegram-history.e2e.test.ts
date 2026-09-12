import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { GatewayClient } from "../src/gateway/client.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

let instance: OpenClawTestInstance | undefined;
let provider: ChildProcess | undefined;
let botApi: Server | undefined;
let observer: GatewayClient | undefined;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      try {
        await observer?.stopAndWait();
      } finally {
        await instance?.cleanup();
      }
    } finally {
      try {
        if (provider && provider.exitCode === null && provider.signalCode === null) {
          const exited = once(provider, "exit");
          provider.kill("SIGTERM");
          await exited;
        }
      } finally {
        try {
          const api = botApi;
          if (api?.listening) {
            const closed = new Promise<void>((resolve, reject) =>
              api.close((error) => (error ? reject(error) : resolve())),
            );
            api.closeAllConnections();
            await closed;
          }
        } finally {
          cleanup();
          observer = undefined;
          instance = undefined;
          provider = undefined;
          botApi = undefined;
        }
      }
    }
  }),
);

const messageSchema = z.object({
  role: z.string(),
  content: z.union([
    z.string(),
    z.array(z.object({ type: z.string(), text: z.string().optional() })),
  ]),
});
const historySchema = z.object({
  messages: z.array(messageSchema),
  sessionInfo: z.object({ model: z.string(), modelOverrideSource: z.string().nullable() }),
});
function messageText(message: z.infer<typeof messageSchema>) {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

it.each([
  {
    name: "persists the delivered Telegram policy notice in shared history before suppressing it on web turns",
    withPhoto: false,
    failDelivery: "none",
  },
  {
    name: "preserves the delivered Telegram photo and policy notice in shared history across web turns and restart",
    withPhoto: true,
    failDelivery: "none",
  },
  {
    name: "Telegram webhook retries the notice after its send failed without recording a receipt",
    withPhoto: false,
    failDelivery: "notice",
  },
  {
    name: "Telegram webhook keeps the persisted notice receipt when a later diagnostic payload fails",
    withPhoto: false,
    failDelivery: "diagnostic",
  },
] as const)("$name", async ({ withPhoto, failDelivery }) => {
  const scratch = tempDirs.make("openclaw-telegram-policy-history-");
  const responsePath = path.join(scratch, "response.json");
  const requestPath = path.join(scratch, "requests.ndjson");
  await fs.writeFile(responsePath, JSON.stringify({ text: "Receipt response." }));
  await fs.writeFile(requestPath, "");
  const providerProcess = spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      MOCK_PORT: "0",
      MOCK_RESPONSE_CONTROL: responsePath,
      MOCK_REQUEST_LOG: requestPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  provider = providerProcess;
  let providerPort: number | undefined;
  for await (const line of createInterface({ input: providerProcess.stdout })) {
    const match = /^mock-openai listening on (\d+)$/u.exec(line);
    if (match) {
      providerPort = Number(match[1]);
      break;
    }
  }
  expect(providerPort).toBeTypeOf("number");

  const changes = new EventEmitter();
  const failures: string[] = [];
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const deliveries: Array<{ method: string; text: string; messageId: number }> = [];
  const rejectedDeliveries: Array<{ method: string; text: string }> = [];
  let failNextTextAfter: number | undefined;
  const photoUploads: Array<{ name: string; bytes: number }> = [];
  const botId = 424242;
  const botToken = `${botId}:${"A".repeat(35)}`;
  const senderId = 1357;
  const bot = { id: botId, is_bot: true, first_name: "Fixture", username: "fixture_receipt_bot" };
  const chat = { id: senderId, type: "private", first_name: "Fixture sender" };
  const webhookSecret = "FAKE_TELEGRAM_HISTORY_WEBHOOK_SECRET";
  const advertisedUrl = "https://fixture.invalid/telegram-history";
  let registrations = 0;
  let outboundId = 9000;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const prefix = `/bot${botToken}/`;
      if (!url.pathname.startsWith(prefix)) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ ok: false, error_code: 401, description: "Unexpected fixture token" }),
        );
        return;
      }
      const method = url.pathname.slice(prefix.length);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const contentType = request.headers["content-type"] ?? "application/json";
      const body = z.record(z.string(), z.unknown()).parse(
        contentType.startsWith("multipart/form-data;")
          ? Object.fromEntries(
              await new Response(new Uint8Array(raw), {
                headers: { "content-type": contentType },
              }).formData(),
            )
          : raw.length > 0
            ? JSON.parse(raw.toString("utf8"))
            : {},
      );
      calls.push({ method, body });
      if (method === "sendMessage" && failNextTextAfter !== undefined) {
        if (failNextTextAfter === 0) {
          failNextTextAfter = undefined;
          const text = z.string().parse(body.text);
          response.once("finish", () => {
            rejectedDeliveries.push({ method, text });
            changes.emit("change");
          });
          response.writeHead(403, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error_code: 403,
              description: "Forbidden: fixture delivery rejected",
            }),
          );
          return;
        }
        failNextTextAfter -= 1;
      }

      let result: unknown;
      if (method === "getMe") result = bot;
      else if (method === "getWebhookInfo")
        result = {
          url: registrations ? advertisedUrl : "",
          has_custom_certificate: false,
          pending_update_count: 0,
        };
      else if (method === "getChat") result = chat;
      else if (method === "getMyCommands") result = [];
      else if (method === "setWebhook") {
        expect(body.url).toBe(advertisedUrl);
        expect(body.secret_token).toBe(webhookSecret);
        result = true;
        response.once("finish", () => {
          registrations += 1;
          changes.emit("change");
        });
      } else if (
        [
          "deleteWebhook",
          "deleteMyCommands",
          "setMyCommands",
          "sendChatAction",
          "setMessageReaction",
        ].includes(method)
      )
        result = true;
      else if (method === "sendPhoto") {
        expect(contentType).toContain("multipart/form-data;");
        const photo = body.photo;
        let upload = photo;
        if (typeof photo === "string") {
          expect(photo.startsWith("attach://")).toBe(true);
          upload = body[photo.slice("attach://".length)];
        }
        const file = z.instanceof(File).parse(upload);
        const bytes = (await file.arrayBuffer()).byteLength;
        expect(bytes).toBeGreaterThan(0);
        photoUploads.push({ name: file.name, bytes });
        const caption = z.string().parse(body.caption);
        expect(String(body.chat_id)).toBe(String(senderId));
        const messageId = ++outboundId;
        result = {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          from: bot,
          chat,
          caption,
          photo: [
            {
              file_id: `fixture-photo-${messageId}`,
              file_unique_id: `fixture-photo-unique-${messageId}`,
              width: 1,
              height: 1,
              file_size: bytes,
            },
          ],
        };
        response.once("finish", () => {
          deliveries.push({ method, text: caption, messageId });
          changes.emit("change");
        });
      } else if (method === "sendMessage" || method === "editMessageText") {
        const text = z.string().parse(body.text);
        expect(String(body.chat_id)).toBe(String(senderId));
        const messageId =
          method === "sendMessage" ? ++outboundId : z.number().parse(body.message_id);
        result = {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          from: bot,
          chat,
          text,
        };
        response.once("finish", () => {
          deliveries.push({ method, text, messageId });
          changes.emit("change");
        });
      } else {
        failures.push(`Unsupported Bot API method: ${method}`);
        response.writeHead(404, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ ok: false, error_code: 404, description: "Unsupported fixture method" }),
        );
        changes.emit("change");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result }));
    })().catch((error: unknown) => {
      failures.push(String(error));
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ ok: false, error_code: 500, description: "Fixture request failed" }),
      );
      changes.emit("change");
    });
  });
  botApi = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture API did not bind a TCP port");
  const apiRoot = `http://127.0.0.1:${address.port}`;

  // Read on producer events, not elapsed sleeps. Subscribe before each read so
  // a committed transcript update cannot be lost between the read and wait.
  async function observe<T>(
    description: string,
    read: () => Promise<T> | T,
    ready: (value: T) => boolean,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(30_000);
    while (true) {
      const cycle = new AbortController();
      const changed = once(changes, "change", {
        signal: AbortSignal.any([deadline, cycle.signal]),
      }).then(
        () => {},
        () => {},
      );
      try {
        expect(failures).toEqual([]);
        const value = await read();
        if (ready(value)) return value;
        if (deadline.aborted) throw new Error(`${description}: ${JSON.stringify(value)}`);
        await changed;
        if (deadline.aborted) throw new Error(`${description}: ${JSON.stringify(value)}`);
      } finally {
        cycle.abort();
      }
    }
  }

  const runtime = await createOpenClawTestInstance({
    name: "telegram-policy-history",
    env: {
      OPENCLAW_SHELL: "exec",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_PROVIDERS: "0",
      OPENCLAW_SKIP_CHANNELS: "0",
      TELEGRAM_BOT_TOKEN: undefined,
    },
    config: {
      cron: { enabled: false },
      commands: { ownerAllowFrom: [`telegram:${senderId}`] },
      session: { dmScope: "main", mainKey: "main" },
      agents: {
        ownership: "explicit",
        defaults: {
          model: "openai/fixture-primary",
          modelPolicy: { allow: ["openai/*"] },
          heartbeat: { every: "0m" },
          typingMode: "never",
        },
        entries: { main: {} },
      },
      models: {
        mode: "replace",
        catalogRefresh: { enabled: false },
        providers: {
          openai: {
            api: "openai-completions",
            apiKey: "FAKE_TELEGRAM_HISTORY_CREDENTIAL",
            baseUrl: `http://127.0.0.1:${providerPort}/v1`,
            agentRuntime: { id: "openclaw" },
            models: [
              { id: "fixture-primary", name: "Primary", contextWindow: 128000 },
              { id: "fixture-pin", name: "Pinned", contextWindow: 128000 },
            ],
          },
        },
      },
      channels: {
        telegram: {
          enabled: true,
          botToken,
          apiRoot,
          dmPolicy: "allowlist",
          allowFrom: [String(senderId)],
          commands: { native: false, nativeSkills: false },
          streaming: { mode: "off" },
          reactionLevel: "off",
          ackReaction: "",
          webhookUrl: advertisedUrl,
          webhookSecret,
          webhookHost: "127.0.0.1",
          webhookPort: 0,
          webhookPath: "/telegram-history",
        },
      },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "default" } }],
      plugins: {
        allow: ["telegram", "openai"],
        entries: { telegram: { enabled: true }, openai: { enabled: true } },
      },
    },
  });
  instance = runtime;
  const imagePath = path.join(runtime.state.workspaceDir, "receipt.png");
  const attachmentSuffix = withPhoto ? `\nMEDIA:${imagePath}` : "";
  if (withPhoto) {
    await fs.writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await fs.writeFile(
      responsePath,
      JSON.stringify({ text: `Receipt response.${attachmentSuffix}` }),
    );
  }
  const sessionKey = "agent:main:main";
  let webhookUrl = "";
  const chatEvents: Array<{ runId: string; state: string; message?: unknown }> = [];
  async function startGateway() {
    const before = registrations;
    await runtime.startGateway();
    await observe(
      "Webhook registration did not settle",
      () => registrations,
      (count) => count === before + 1,
    );
    const listener = [
      ...runtime
        .logs()
        .matchAll(/webhook local listener on (http:\/\/127\.0\.0\.1:\d+\/telegram-history)/gu),
    ].at(-1);
    webhookUrl = expectDefined(
      listener?.[1],
      `Webhook listener was not reported: ${runtime.logs()}`,
    );
    const hello = createDeferred<void>();
    observer = new GatewayClient({
      url: runtime.url,
      token: runtime.gatewayToken,
      clientName: "cli",
      mode: "cli",
      scopes: ["operator.admin"],
      caps: ["session-scoped-events"],
      sharedStateMode: "read-only",
      onHelloOk: () => hello.resolve(),
      onConnectError: hello.reject,
      onEvent: (event) => {
        if (event.event === "chat")
          chatEvents.push(
            z
              .object({ runId: z.string(), state: z.string(), message: z.unknown().optional() })
              .parse(event.payload),
          );
        if (["session.message", "sessions.changed", "chat"].includes(event.event))
          changes.emit("change");
      },
    });
    observer.start();
    await hello.promise;
    expect(
      await observer.request("sessions.messages.subscribe", { key: sessionKey, agentId: "main" }),
    ).toMatchObject({ subscribed: true });
    await observer.request("sessions.subscribe", { agentId: "main" });
  }
  async function stopGateway() {
    await observer?.stopAndWait();
    observer = undefined;
    await runtime.stopGateway();
  }
  async function call(method: string, params: Record<string, unknown>) {
    if (!observer) throw new Error("Gateway observer is not connected");
    return observer.request(method, params);
  }
  async function modelRequests() {
    return (await fs.readFile(requestPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const record = z.object({ path: z.string(), body: z.unknown() }).parse(JSON.parse(line));
        return {
          path: record.path,
          body: typeof record.body === "string" ? JSON.parse(record.body) : record.body,
        };
      })
      .filter((record) => record.path === "/v1/chat/completions")
      .map((record) => z.object({ model: z.string() }).parse(record.body).model);
  }
  let updateId = 0;
  async function sendTelegramUpdate(text: string) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": webhookSecret,
      },
      body: JSON.stringify({
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat,
          from: { id: senderId, is_bot: false, first_name: "Fixture sender" },
          text,
        },
      }),
    });
    expect(response.status).toBe(200);
  }
  async function telegramTurn(
    text: string,
    expectedReply: string,
    allowPendingDeliveryNotice = false,
  ) {
    const before = deliveries.length;
    await sendTelegramUpdate(text);
    const outbound = await observe(
      "Telegram reply did not settle",
      () => deliveries.slice(before),
      (messages) =>
        messages.length >
        (allowPendingDeliveryNotice && messages[0]?.text === pendingDeliveryNotice ? 1 : 0),
    );
    const replyIndex =
      allowPendingDeliveryNotice && outbound[0]?.text === pendingDeliveryNotice ? 1 : 0;
    expect(outbound).toEqual([
      ...(replyIndex === 1
        ? [
            {
              method: "sendMessage",
              text: pendingDeliveryNotice,
              messageId: expectDefined(outbound[0], "Pending Telegram delivery notice").messageId,
            },
          ]
        : []),
      {
        method: withPhoto ? "sendPhoto" : "sendMessage",
        text: expectedReply,
        messageId: expectDefined(outbound[replyIndex], "Delivered Telegram reply").messageId,
      },
    ]);
    return observe(
      "Delivered Telegram text was not committed to shared history",
      async () => historySchema.parse(await call("chat.history", { sessionKey, limit: 20 })),
      (history) => {
        const last = history.messages.at(-1);
        return (
          last?.role === "assistant" && messageText(last) === `${expectedReply}${attachmentSuffix}`
        );
      },
    );
  }
  const notice =
    "Pinned model openai/fixture-pin is not in your allow list. This reply used the default (openai/fixture-primary). Use /model to change it.";
  const pendingDeliveryNotice =
    "I couldn’t confirm whether my previous reply reached this chat, so I won’t resend it automatically. Please ask for any missing remainder.";
  const notifiedAnswer = `${notice}\n\nReceipt response.`;
  const controlHistoryText = `Receipt response.${attachmentSuffix}`;
  const notifiedHistoryText = `${notifiedAnswer}${attachmentSuffix}`;
  await startGateway();
  await call("sessions.create", { key: sessionKey, agentId: "main", model: "openai/fixture-pin" });
  const controlHistory = await telegramTurn(
    "Please answer using my selected model.",
    "Receipt response.",
  );
  expect(controlHistory.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  if (withPhoto) {
    expect(photoUploads).toHaveLength(1);
    expect(
      controlHistory.messages.filter((message) => message.role === "assistant").map(messageText),
    ).toEqual([controlHistoryText]);
  }
  expect(await modelRequests()).toEqual(["fixture-pin"]);
  await stopGateway();
  const edit = await runtime.cli([
    "config",
    "set",
    "agents.defaults.modelPolicy.allow",
    '["openai/fixture-primary"]',
    "--strict-json",
    "--replace",
  ]);
  expect(edit.code, edit.stderr).toBe(0);
  await startGateway();
  if (failDelivery !== "none") {
    const before = deliveries.length;
    if (failDelivery === "diagnostic") {
      await call("sessions.patch", { key: sessionKey, traceLevel: "raw" });
    }
    failNextTextAfter = failDelivery === "notice" ? 0 : 1;
    await sendTelegramUpdate("Please answer during the delivery failure.");
    await observe(
      "The selected Telegram payload was not rejected",
      () => rejectedDeliveries,
      (rejected) => rejected.length === 1,
    );
    const rejected = expectDefined(rejectedDeliveries[0], "Rejected Telegram payload");
    expect(rejected.method).toBe("sendMessage");
    if (failDelivery === "notice") {
      expect(rejected.text).toContain(notice);
      expect(deliveries.slice(before)).toEqual([]);
    } else {
      expect(deliveries.slice(before).map((delivery) => delivery.text)).toEqual([notifiedAnswer]);
      expect(rejected.text).toContain("Usage (Session Total)");
      expect(rejected.text).not.toContain(notice);
      await observe(
        "The delivered notice was not retained after the diagnostic failure",
        async () => historySchema.parse(await call("chat.history", { sessionKey, limit: 20 })),
        (history) => history.messages.some((message) => messageText(message) === notifiedAnswer),
      );
      await call("sessions.patch", { key: sessionKey, traceLevel: "off" });
    }
    const retryHistory = await telegramTurn(
      "Please retry after the delivery failure.",
      failDelivery === "notice" ? notifiedAnswer : "Receipt response.",
      true,
    );
    expect(
      retryHistory.messages.filter(
        (message) => message.role === "assistant" && messageText(message).includes(notice),
      ),
    ).toHaveLength(1);
    expect(retryHistory.sessionInfo).toEqual({ model: "fixture-pin", modelOverrideSource: "user" });
    expect(await modelRequests()).toEqual(["fixture-pin", "fixture-primary", "fixture-primary"]);
    await stopGateway();
    await startGateway();
    const restarted = await telegramTurn("Please answer after restart.", "Receipt response.", true);
    expect(
      restarted.messages.filter(
        (message) => message.role === "assistant" && messageText(message).includes(notice),
      ),
    ).toHaveLength(1);
    expect(restarted.sessionInfo).toEqual({ model: "fixture-pin", modelOverrideSource: "user" });
    expect(await modelRequests()).toEqual([
      "fixture-pin",
      "fixture-primary",
      "fixture-primary",
      "fixture-primary",
    ]);
    expect(rejectedDeliveries).toHaveLength(1);
    expect(deliveries.filter((delivery) => delivery.text === pendingDeliveryNotice)).toHaveLength(
      1,
    );
    expect(deliveries).toHaveLength(failDelivery === "notice" ? 4 : 5);
    expect(
      restarted.messages.filter(
        (message) => message.role === "assistant" && messageText(message) === pendingDeliveryNotice,
      ),
    ).toHaveLength(1);
    expect(failures).toEqual([]);
    return;
  }
  const notifiedHistory = await telegramTurn(
    "Please answer after the policy change.",
    notifiedAnswer,
  );
  expect(await modelRequests()).toEqual(["fixture-pin", "fixture-primary"]);
  expect(notifiedHistory.messages.map((message) => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  expect(
    notifiedHistory.messages.filter(
      (message) => message.role === "assistant" && messageText(message).includes(notice),
    ),
  ).toHaveLength(1);
  expect(notifiedHistory.sessionInfo).toEqual({
    model: "fixture-pin",
    modelOverrideSource: "user",
  });
  if (withPhoto) {
    expect(photoUploads).toHaveLength(2);
    expect(
      notifiedHistory.messages.filter((message) => message.role === "assistant").map(messageText),
    ).toEqual([controlHistoryText, notifiedHistoryText]);
    await fs.writeFile(responsePath, JSON.stringify({ text: "Receipt response." }));
  }
  async function webTurn(expectedAnswers: string[]) {
    const runId = randomUUID();
    expect(
      await call("chat.send", {
        sessionKey,
        message: "Please answer from the shared web session.",
        idempotencyKey: runId,
      }),
    ).toMatchObject({ runId });
    expect(await call("agent.wait", { runId, timeoutMs: 20_000 })).toMatchObject({
      runId,
      status: "ok",
    });
    const terminal = await observe(
      "Web reply did not settle",
      () =>
        chatEvents.find(
          (event) => event.runId === runId && ["final", "error", "aborted"].includes(event.state),
        ),
      (event) => event !== undefined,
    );
    expect(terminal?.state).toBe("final");
    expect(messageText(messageSchema.parse(terminal?.message))).toBe("Receipt response.");
    const history = historySchema.parse(await call("chat.history", { sessionKey, limit: 20 }));
    expect(
      history.messages.filter((message) => message.role === "assistant").map(messageText),
    ).toEqual(expectedAnswers);
    expect(history.sessionInfo).toEqual({ model: "fixture-pin", modelOverrideSource: "user" });
    return history;
  }
  expect(
    (await webTurn([controlHistoryText, notifiedHistoryText, "Receipt response."])).messages,
  ).toHaveLength(6);
  await stopGateway();
  await startGateway();
  expect(
    (
      await webTurn([
        controlHistoryText,
        notifiedHistoryText,
        "Receipt response.",
        "Receipt response.",
      ])
    ).messages,
  ).toHaveLength(8);
  expect(await modelRequests()).toEqual([
    "fixture-pin",
    "fixture-primary",
    "fixture-primary",
    "fixture-primary",
  ]);
  expect(deliveries).toHaveLength(2);
  expect(photoUploads).toHaveLength(withPhoto ? 2 : 0);
  expect(calls.filter((entry) => entry.method === "editMessageText")).toHaveLength(0);
  expect(failures).toEqual([]);
});
