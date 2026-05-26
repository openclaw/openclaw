import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import { clearConfigCache } from "../config/config.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { setMaxChatHistoryMessagesBytesForTest } from "./server-constants.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/shared-types.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  getReplyFromConfig,
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const FAST_WAIT_OPTS = { timeout: 250, interval: 2 } as const;
type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
let harness: GatewayHarness;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});

afterAll(async () => {
  await harness.close();
});

const sendReq = (
  ws: { send: (payload: string) => void },
  id: string,
  method: string,
  params: unknown,
) => {
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method,
      params,
    }),
  );
};

function createDeferred<T>() {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

async function withGatewayChatHarness(
  run: (ctx: { ws: GatewaySocket; createSessionDir: () => Promise<string> }) => Promise<void>,
) {
  const tempDirs: string[] = [];
  const ws = await harness.openWs();
  const createSessionDir = async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    tempDirs.push(sessionDir);
    testState.sessionStorePath = path.join(sessionDir, "sessions.json");
    return sessionDir;
  };

  try {
    await run({ ws, createSessionDir });
  } finally {
    setMaxChatHistoryMessagesBytesForTest();
    clearConfigCache();
    testState.sessionStorePath = undefined;
    ws.close();
    await Promise.all(
      tempDirs.map((dir) =>
        fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
    );
  }
}

async function writeMainSessionStore() {
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: Date.now() },
    },
  });
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  clearConfigCache();
}

async function writeMainSessionTranscript(sessionDir: string, lines: string[]) {
  await fs.writeFile(path.join(sessionDir, "sess-main.jsonl"), `${lines.join("\n")}\n`, "utf-8");
}

function transcriptMessageLine(message: Record<string, unknown>) {
  return JSON.stringify({ message });
}

function extractHistoryText(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "";
  }
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (!Array.isArray(record.content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of record.content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
    const typed = block as Record<string, unknown>;
    if (typeof typed.text === "string") {
      parts.push(typed.text);
    } else if (typeof typed.content === "string") {
      parts.push(typed.content);
    }
  }
  return parts.join("\n");
}

function historyText(messages: unknown[]): string {
  return messages.map(extractHistoryText).join("\n");
}

async function fetchHistoryMessages(
  ws: GatewaySocket,
  params?: {
    limit?: number;
    maxChars?: number;
    mode?: "messages" | "turns" | "raw-messages";
    unsafeRawToolPayloads?: boolean;
  },
): Promise<unknown[]> {
  const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
    sessionKey: "main",
    limit: params?.limit ?? 1000,
    ...(typeof params?.maxChars === "number" ? { maxChars: params.maxChars } : {}),
    ...(params?.mode ? { mode: params.mode } : {}),
    ...(params?.unsafeRawToolPayloads === true ? { unsafeRawToolPayloads: true } : {}),
  });
  expect(historyRes.ok).toBe(true);
  return historyRes.payload?.messages ?? [];
}

type ConfiguredImageModelCase = {
  id: string;
  imageModel: AgentModelConfig;
};

const configuredImageModelCases: ConfiguredImageModelCase[] = [
  {
    id: "with-image-fallback",
    imageModel: { primary: "openai/gpt-4o", fallbacks: ["openai/gpt-4o-mini"] },
  },
  {
    id: "without-image-fallback",
    imageModel: { primary: "openai/gpt-4o" },
  },
];

async function prepareMainHistoryHarness(params: {
  ws: GatewaySocket;
  createSessionDir: () => Promise<string>;
  historyMaxBytes?: number;
}) {
  if (params.historyMaxBytes !== undefined) {
    setMaxChatHistoryMessagesBytesForTest(params.historyMaxBytes);
  }
  await connectOk(params.ws);
  const sessionDir = await params.createSessionDir();
  await writeMainSessionStore();
  return sessionDir;
}

describe("gateway server chat", () => {
  test("chat.history does not wait for model catalog discovery to return history", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      testState.agentConfig = {
        model: { primary: "test-provider/slow-catalog-model" },
      };
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            modelProvider: "test-provider",
            model: "slow-catalog-model",
            updatedAt: Date.now(),
          },
        },
      });
      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = {
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(
          async () => {
            throw new Error("model catalog should not load for chat.history");
          },
        ),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      } as unknown as GatewayRequestContext;
      const { chatHandlers } = await import("./server-methods/chat.js");

      await chatHandlers["chat.history"]({
        req: {
          type: "req",
          id: "history-no-catalog",
          method: "chat.history",
          params: { sessionKey: "main" },
        },
        params: { sessionKey: "main" },
        client: null,
        isWebchatConnect: () => false,
        respond: ((ok, payload, error) => {
          responses.push({ ok, payload, error });
        }) as RespondFn,
        context,
      });

      expect(context.loadGatewayModelCatalog).not.toHaveBeenCalled();
      expect(responses).toHaveLength(1);
      expect(responses[0]?.ok).toBe(true);
      const payload = responses[0]?.payload as
        | { sessionKey?: string; sessionId?: string; messages?: unknown }
        | undefined;
      expect(payload?.sessionKey).toBe("main");
      expect(payload?.sessionId).toBe("sess-main");
      expect(Array.isArray(payload?.messages)).toBe(true);
    } finally {
      clearConfigCache();
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send returns in_flight when duplicate attachment send wins parsing race", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const dispatchRelease = createDeferred<void>();
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            modelProvider: "test-provider",
            model: "vision-model",
            updatedAt: Date.now(),
          },
        },
      });

      const firstCatalog =
        createDeferred<Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>>();
      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = {
        loadGatewayModelCatalog: vi
          .fn<GatewayRequestContext["loadGatewayModelCatalog"]>()
          .mockImplementationOnce(() => firstCatalog.promise)
          .mockResolvedValue([
            {
              id: "vision-model",
              name: "Vision Model",
              provider: "test-provider",
              input: ["text", "image"],
            },
          ]),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        agentRunSeq: new Map<string, number>(),
        chatAbortControllers: new Map(),
        chatAbortedRuns: new Map(),
        chatRunBuffers: new Map(),
        chatDeltaSentAt: new Map(),
        chatDeltaLastBroadcastLen: new Map(),
        chatDeltaLastBroadcastText: new Map(),
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        dedupe: new Map(),
      } as unknown as GatewayRequestContext;
      dispatchInboundMessageMock.mockImplementation(async () => dispatchRelease.promise);

      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
      const params = {
        sessionKey: "main",
        message: "see image",
        idempotencyKey: "idem-attachment-race",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: pngB64,
          },
        ],
      };
      const { chatHandlers } = await import("./server-methods/chat.js");
      const callSend = (id: string) =>
        chatHandlers["chat.send"]({
          req: { type: "req", id, method: "chat.send", params },
          params,
          client: null,
          isWebchatConnect: () => false,
          respond: ((ok, payload, error) => {
            responses.push({ id, ok, payload, error });
          }) as RespondFn,
          context,
        });

      const first = Promise.resolve(callSend("first"));
      await vi.waitFor(() => {
        expect(context.loadGatewayModelCatalog).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);

      await callSend("duplicate");
      expect(responses).toEqual([
        {
          id: "duplicate",
          ok: true,
          payload: { runId: "idem-attachment-race", status: "started" },
          error: undefined,
        },
      ]);

      firstCatalog.resolve([
        {
          id: "vision-model",
          name: "Vision Model",
          provider: "test-provider",
          input: ["text", "image"],
        },
      ]);
      await first;

      expect(responses).toEqual([
        {
          id: "duplicate",
          ok: true,
          payload: { runId: "idem-attachment-race", status: "started" },
          error: undefined,
        },
        {
          id: "first",
          ok: true,
          payload: { runId: "idem-attachment-race", status: "in_flight" },
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(context.addChatRun).toHaveBeenCalledTimes(1);
      dispatchRelease.resolve();
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
    } finally {
      dispatchRelease.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test.each(configuredImageModelCases)(
    "chat.send preserves text-only image uploads as MediaPaths even with configured imageModel: $id",
    async ({ id, imageModel }) => {
      const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      try {
        testState.sessionStorePath = path.join(sessionDir, "sessions.json");
        testState.agentConfig = {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["anthropic/claude-haiku-4-6"],
          },
          imageModel,
          models: {
            "anthropic/claude-opus-4-6": {},
          },
        };
        await writeSessionStore({
          entries: {
            main: {
              sessionId: "sess-main",
              modelProvider: "anthropic",
              model: "claude-opus-4-6",
              updatedAt: Date.now(),
            },
          },
        });

        const context = {
          loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(
            async () => [
              {
                id: "claude-opus-4-6",
                name: "Claude Opus 4.6",
                provider: "anthropic",
                input: ["text"],
              },
              {
                id: "gpt-4o",
                name: "GPT-4o",
                provider: "openai",
                input: ["text", "image"],
              },
              {
                id: "gpt-4o-mini",
                name: "GPT-4o mini",
                provider: "openai",
                input: ["text", "image"],
              },
              {
                id: "claude-haiku-4-6",
                name: "Claude Haiku 4.6",
                provider: "anthropic",
                input: ["text"],
              },
            ],
          ),
          logGateway: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          },
          agentRunSeq: new Map<string, number>(),
          chatAbortControllers: new Map(),
          chatAbortedRuns: new Map(),
          chatRunBuffers: new Map(),
          chatDeltaSentAt: new Map(),
          chatDeltaLastBroadcastLen: new Map(),
          chatDeltaLastBroadcastText: new Map(),
          addChatRun: vi.fn(),
          removeChatRun: vi.fn(),
          broadcast: vi.fn(),
          nodeSendToSession: vi.fn(),
          registerToolEventRecipient: vi.fn(),
          dedupe: new Map(),
        } as unknown as GatewayRequestContext;
        const pngB64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
        let captured: { ctx?: Record<string, unknown>; replyOptions?: GetReplyOptions } | undefined;
        dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
          const [params] = args as [
            {
              ctx: Record<string, unknown>;
              replyOptions?: GetReplyOptions;
            },
          ];
          captured = {
            ctx: params.ctx,
            replyOptions: params.replyOptions,
          };
        });

        const { chatHandlers } = await import("./server-methods/chat.js");
        const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
        await chatHandlers["chat.send"]({
          req: {
            type: "req",
            id: `configured-image-model-${id}`,
            method: "chat.send",
            params: {
              sessionKey: "main",
              message: "see image",
              idempotencyKey: `idem-configured-image-model-${id}`,
              attachments: [
                {
                  type: "image",
                  mimeType: "image/png",
                  fileName: "dot.png",
                  content: pngB64,
                },
              ],
            },
          },
          params: {
            sessionKey: "main",
            message: "see image",
            idempotencyKey: `idem-configured-image-model-${id}`,
            attachments: [
              {
                type: "image",
                mimeType: "image/png",
                fileName: "dot.png",
                content: pngB64,
              },
            ],
          },
          client: null,
          isWebchatConnect: () => false,
          respond: ((ok, payload, error) => {
            responses.push({ ok, payload, error });
          }) as RespondFn,
          context,
        });

        expect(responses[0]?.ok).toBe(true);
        await vi.waitFor(() => expect(captured).toBeDefined(), FAST_WAIT_OPTS);
        expect(captured?.replyOptions?.images).toBeUndefined();
        expect(captured?.ctx?.MediaPath).toEqual(expect.any(String));
        expect(captured?.ctx?.MediaPaths).toEqual([expect.any(String)]);
        expect(captured?.ctx?.MediaType).toBe("image/png");
        expect(captured?.ctx?.MediaTypes).toEqual(["image/png"]);
        expect(captured?.ctx?.MediaStaged).toBe(true);
        await vi.waitFor(() => expect(context.removeChatRun).toHaveBeenCalledTimes(1));
      } finally {
        dispatchInboundMessageMock.mockReset();
        testState.agentConfig = undefined;
        testState.sessionStorePath = undefined;
        clearConfigCache();
        await fs.rm(sessionDir, { recursive: true, force: true });
      }
    },
  );

  test("chat.send reuses an active internal run for duplicate WebChat text sends", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const dispatchRelease = createDeferred<void>();
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = {
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        agentRunSeq: new Map<string, number>(),
        chatAbortControllers: new Map(),
        chatAbortedRuns: new Map(),
        chatRunBuffers: new Map(),
        chatDeltaSentAt: new Map(),
        chatDeltaLastBroadcastLen: new Map(),
        chatDeltaLastBroadcastText: new Map(),
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        dedupe: new Map(),
      } as unknown as GatewayRequestContext;
      dispatchInboundMessageMock.mockImplementation(async () => dispatchRelease.promise);

      const { chatHandlers } = await import("./server-methods/chat.js");
      const callSend = (id: string, idempotencyKey: string) =>
        chatHandlers["chat.send"]({
          req: {
            type: "req",
            id,
            method: "chat.send",
            params: {
              sessionKey: "main",
              message: "?",
              idempotencyKey,
            },
          },
          params: {
            sessionKey: "main",
            message: "?",
            idempotencyKey,
          },
          client: {
            connect: {
              client: {
                id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
                mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              },
              scopes: ["operator.write"],
            },
          } as never,
          isWebchatConnect: () => true,
          respond: ((ok, payload, error) => {
            responses.push({ id, ok, payload, error });
          }) as RespondFn,
          context,
        });

      const first = Promise.resolve(callSend("first", "idem-active-a"));
      await vi.waitFor(() => {
        expect(responses).toEqual([
          {
            id: "first",
            ok: true,
            payload: { runId: "idem-active-a", status: "started" },
            error: undefined,
          },
        ]);
      }, FAST_WAIT_OPTS);

      await callSend("duplicate", "idem-active-b");

      expect(responses).toEqual([
        {
          id: "first",
          ok: true,
          payload: { runId: "idem-active-a", status: "started" },
          error: undefined,
        },
        {
          id: "duplicate",
          ok: true,
          payload: { runId: "idem-active-a", status: "in_flight" },
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(context.addChatRun).toHaveBeenCalledTimes(1);

      dispatchRelease.resolve();
      await first;
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
    } finally {
      dispatchRelease.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send starts the next WebChat turn after the prior internal run finishes", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = {
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
        agentRunSeq: new Map<string, number>(),
        chatAbortControllers: new Map(),
        chatAbortedRuns: new Map(),
        chatRunBuffers: new Map(),
        chatDeltaSentAt: new Map(),
        chatDeltaLastBroadcastLen: new Map(),
        chatDeltaLastBroadcastText: new Map(),
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        nodeSendToSession: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        dedupe: new Map(),
      } as unknown as GatewayRequestContext;
      dispatchInboundMessageMock.mockResolvedValue(undefined);

      const { chatHandlers } = await import("./server-methods/chat.js");
      const callSend = (id: string, message: string, idempotencyKey: string) =>
        chatHandlers["chat.send"]({
          req: {
            type: "req",
            id,
            method: "chat.send",
            params: {
              sessionKey: "main",
              message,
              idempotencyKey,
            },
          },
          params: {
            sessionKey: "main",
            message,
            idempotencyKey,
          },
          client: {
            connect: {
              client: {
                id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
                mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              },
              scopes: ["operator.write"],
            },
          } as never,
          isWebchatConnect: () => true,
          respond: ((ok, payload, error) => {
            responses.push({ id, ok, payload, error });
          }) as RespondFn,
          context,
        });

      await callSend("first", "first message", "idem-sequential-a");
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);

      await callSend("second", "second message", "idem-sequential-b");
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(2);
      }, FAST_WAIT_OPTS);

      expect(responses).toEqual([
        {
          id: "first",
          ok: true,
          payload: { runId: "idem-sequential-a", status: "started" },
          error: undefined,
        },
        {
          id: "second",
          ok: true,
          payload: { runId: "idem-sequential-b", status: "started" },
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(context.addChatRun).toHaveBeenCalledTimes(2);
    } finally {
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.history fast-paths missing session entries without transcript reads", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({ entries: {} });
      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const logInfo = vi.fn();
      const context = {
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(
          async () => {
            throw new Error("model catalog should not load for missing chat.history sessions");
          },
        ),
        logGateway: {
          info: logInfo,
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      } as unknown as GatewayRequestContext;
      const { chatHandlers } = await import("./server-methods/chat.js");

      await chatHandlers["chat.history"]({
        req: {
          type: "req",
          id: "history-missing-session",
          method: "chat.history",
          params: {
            sessionKey: "agent:chisel:webchat:clawdash-dev",
            mode: "turns",
          },
        },
        params: {
          sessionKey: "agent:chisel:webchat:clawdash-dev",
          mode: "turns",
        },
        client: null,
        isWebchatConnect: () => false,
        respond: ((ok, payload, error) => {
          responses.push({ ok, payload, error });
        }) as RespondFn,
        context,
      });

      expect(context.loadGatewayModelCatalog).not.toHaveBeenCalled();
      expect(responses).toHaveLength(1);
      expect(responses[0]?.ok).toBe(true);
      const payload = responses[0]?.payload as
        | { sessionKey?: string; sessionId?: string; messages?: unknown[] }
        | undefined;
      expect(payload?.sessionKey).toBe("agent:chisel:webchat:clawdash-dev");
      expect(payload?.sessionId).toBeUndefined();
      expect(payload?.messages).toStrictEqual([]);
      const metricsLine = logInfo.mock.calls
        .map((call: unknown[]) => {
          const value = call[0];
          return typeof value === "string" ? value : JSON.stringify(value ?? "");
        })
        .find((line: string) => line.includes("chat.history metrics"));
      expect(metricsLine).toContain("sessionKnown=false");
      expect(metricsLine).toContain("transcriptRead=false");
      expect(metricsLine).toContain("localMessages=0");
      expect(metricsLine).toContain("returnedMessages=0");
    } finally {
      clearConfigCache();
      testState.sessionStorePath = undefined;
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.history defaults omitted mode to turns for display clients only", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeSessionStore({ entries: {} });
      const context = {
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(
          async () => [],
        ),
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      } as unknown as GatewayRequestContext;
      const { chatHandlers } = await import("./server-methods/chat.js");
      const requestHistory = async (client: unknown) => {
        let response: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
        await chatHandlers["chat.history"]({
          req: {
            type: "req",
            id: "history-default-mode",
            method: "chat.history",
            params: { sessionKey: "agent:forge:webchat:main" },
          },
          params: { sessionKey: "agent:forge:webchat:main" },
          client: client as Parameters<(typeof chatHandlers)["chat.history"]>[0]["client"],
          isWebchatConnect: () => false,
          respond: ((ok, payload, error) => {
            response = { ok, payload, error };
          }) as RespondFn,
          context,
        });
        expect(response?.ok).toBe(true);
        return response?.payload as { mode?: string } | undefined;
      };

      await expect(
        requestHistory({
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.WEBCHAT_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              version: "test",
              platform: "test",
            },
          },
        }),
      ).resolves.toMatchObject({ mode: "turns" });
      await expect(
        requestHistory({
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
              mode: GATEWAY_CLIENT_MODES.BACKEND,
              version: "test",
              platform: "test",
            },
          },
        }),
      ).resolves.toMatchObject({ mode: "messages" });
    } finally {
      clearConfigCache();
      testState.sessionStorePath = undefined;
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.history backfills claude-cli sessions from Claude project files", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const originalHome = process.env.HOME;
      const homeDir = path.join(sessionDir, "home");
      const cliSessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
      const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "workspace");
      await fs.mkdir(claudeProjectsDir, { recursive: true });
      await fs.writeFile(
        path.join(claudeProjectsDir, `${cliSessionId}.jsonl`),
        [
          JSON.stringify({
            type: "queue-operation",
            operation: "enqueue",
            timestamp: "2026-03-26T16:29:54.722Z",
            sessionId: cliSessionId,
            content: "[Thu 2026-03-26 16:29 GMT] hi",
          }),
          JSON.stringify({
            type: "user",
            uuid: "user-1",
            timestamp: "2026-03-26T16:29:54.800Z",
            message: {
              role: "user",
              content:
                'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
            },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "assistant-1",
            timestamp: "2026-03-26T16:29:55.500Z",
            message: {
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "hello from Claude" }],
            },
          }),
        ].join("\n"),
        "utf-8",
      );
      process.env.HOME = homeDir;
      try {
        await writeSessionStore({
          entries: {
            main: {
              sessionId: "sess-main",
              updatedAt: Date.now(),
              modelProvider: "claude-cli",
              model: "claude-sonnet-4-6",
              cliSessionBindings: {
                "claude-cli": {
                  sessionId: cliSessionId,
                },
              },
            },
          },
        });

        const messages = await fetchHistoryMessages(ws);
        expect(messages).toHaveLength(2);
        const userMessage = messages[0] as { role?: string; content?: string };
        expect(userMessage.role).toBe("user");
        expect(userMessage.content).toBe("hi");
        const assistantMessage = messages[1] as { role?: string; provider?: string };
        expect(assistantMessage.role).toBe("assistant");
        expect(assistantMessage.provider).toBe("claude-cli");
      } finally {
        if (originalHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = originalHome;
        }
      }
    });
  });

  test("chat.history overreads one local message to drop stale announce pairs at the limit boundary", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const sessionStartedAt = Date.parse("2026-05-23T04:02:30.000Z");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            sessionStartedAt,
          },
        },
      });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:31.000Z",
          message: {
            role: "user",
            content: [
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
              "stale announce payload",
            ].join("\n"),
            provenance: {
              kind: "inter_session",
              sourceSessionKey: "agent:main:subagent:child",
              sourceTool: "subagent_announce",
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:33.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "stale announce reply" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-23T04:03:10.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "fresh turn" }],
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { limit: 2 });
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages)).not.toContain("stale announce reply");
      expect(JSON.stringify(messages)).toContain("fresh turn");
    });
  });

  test("chat.history does not surface an older stale assistant when overreading for pair context", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const sessionStartedAt = Date.parse("2026-05-23T04:02:30.000Z");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            sessionStartedAt,
          },
        },
      });
      const announce = {
        kind: "inter_session",
        sourceSessionKey: "agent:main:subagent:child",
        sourceTool: "subagent_announce",
      };
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:29.000Z",
          message: {
            role: "user",
            content:
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
            provenance: announce,
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:30.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "older stale announce reply" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:31.000Z",
          message: {
            role: "user",
            content:
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
            provenance: announce,
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:33.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "newer stale announce reply" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-23T04:03:10.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "fresh turn" }],
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { limit: 3 });
      const serialized = JSON.stringify(messages);
      expect(serialized).not.toContain("older stale announce reply");
      expect(serialized).not.toContain("newer stale announce reply");
      expect(serialized).toContain("fresh turn");
    });
  });

  test("smoke: caps history payload and preserves routing metadata", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        historyMaxBytes,
      });

      const bigText = "x".repeat(2_000);
      const historyLines: string[] = [];
      for (let i = 0; i < 45; i += 1) {
        historyLines.push(
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "text", text: `${i}:${bigText}` }],
              timestamp: Date.now() + i,
            },
          }),
        );
      }
      await writeMainSessionTranscript(sessionDir, historyLines);
      const messages = await fetchHistoryMessages(ws);
      const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeLessThan(45);

      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
            lastChannel: "whatsapp",
            lastTo: "+1555",
          },
        },
      });

      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-route",
      });
      expect(sendRes.ok).toBe(true);

      const sessionStorePath = testState.sessionStorePath;
      if (!sessionStorePath) {
        throw new Error("expected session store path");
      }
      const stored = JSON.parse(await fs.readFile(sessionStorePath, "utf-8")) as Record<
        string,
        { lastChannel?: string; lastTo?: string } | undefined
      >;
      expect(stored["agent:main:main"]?.lastChannel).toBe("whatsapp");
      expect(stored["agent:main:main"]?.lastTo).toBe("+1555");
    });
  });

  test("chat.send does not force-disable block streaming", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();
      testState.agentConfig = { blockStreamingDefault: "on" };
      try {
        let capturedOpts: GetReplyOptions | undefined;
        mockGetReplyFromConfigOnce(async (_ctx, opts) => {
          capturedOpts = opts;
          return undefined;
        });

        const sendRes = await rpcReq(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-block-streaming",
        });
        expect(sendRes.ok).toBe(true);

        await vi.waitFor(() => {
          expect(spy.mock.calls.length).toBeGreaterThan(0);
        }, FAST_WAIT_OPTS);

        expect(capturedOpts?.disableBlockStreaming).toBeUndefined();
      } finally {
        testState.agentConfig = undefined;
      }
    });
  });

  test("chat.history hard-caps single oversized nested payloads", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        historyMaxBytes,
      });

      const hugeNestedText = "n".repeat(120_000);
      const oversizedLine = JSON.stringify({
        message: {
          role: "assistant",
          timestamp: Date.now(),
          content: [
            {
              type: "tool_result",
              toolUseId: "tool-1",
              output: {
                nested: {
                  payload: hugeNestedText,
                },
              },
            },
          ],
        },
      });
      await writeMainSessionTranscript(sessionDir, [oversizedLine]);
      const messages = await fetchHistoryMessages(ws, { mode: "raw-messages" });
      expect(messages.length).toBe(1);

      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("chat.history keeps recent small messages when latest message is oversized", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 64 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        historyMaxBytes,
      });

      const baseText = "s".repeat(1_200);
      const lines: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        lines.push(
          JSON.stringify({
            message: {
              role: "user",
              timestamp: Date.now() + i,
              content: [{ type: "text", text: `small-${i}:${baseText}` }],
            },
          }),
        );
      }

      const hugeNestedText = "z".repeat(120_000);
      lines.push(
        JSON.stringify({
          message: {
            role: "assistant",
            timestamp: Date.now() + 1_000,
            content: [
              {
                type: "tool_result",
                toolUseId: "tool-1",
                output: {
                  nested: {
                    payload: hugeNestedText,
                  },
                },
              },
            ],
          },
        }),
      );

      await writeMainSessionTranscript(sessionDir, lines);
      const messages = await fetchHistoryMessages(ws, { mode: "raw-messages" });
      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");

      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeGreaterThan(1);
      expect(serialized).toContain("small-29:");
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("chat.history messages mode omits raw tool payloads by default", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      const rawAssistantArgs = "RAW_ASSISTANT_TOOL_ARGS_SHOULD_NOT_RENDER";
      const rawToolResult = "RAW_TOOL_RESULT_PAYLOAD_SHOULD_NOT_RENDER";
      const canvasPreview = JSON.stringify({
        kind: "canvas",
        view: {
          id: "cv_safe_history_messages",
          url: "/__openclaw__/canvas/documents/cv_safe_history_messages/index.html",
          title: "Safe history canvas",
        },
        presentation: { target: "assistant_message" },
      });
      await writeMainSessionTranscript(sessionDir, [
        transcriptMessageLine({
          role: "user",
          content: [{ type: "text", text: "please inspect" }],
          timestamp: 1,
        }),
        transcriptMessageLine({
          role: "assistant",
          content: [
            { type: "text", text: "checking with a tool" },
            {
              type: "toolCall",
              id: "call-read",
              name: "read",
              arguments: { path: `/tmp/${rawAssistantArgs}.txt` },
            },
          ],
          timestamp: 2,
        }),
        transcriptMessageLine({
          role: "toolResult",
          toolCallId: "call-read",
          toolName: "read",
          content: [{ type: "text", text: `${rawToolResult}:${"x".repeat(96_000)}` }],
          timestamp: 3,
        }),
        transcriptMessageLine({
          role: "toolResult",
          toolCallId: "call-canvas",
          toolName: "canvas",
          content: [{ type: "text", text: canvasPreview }],
          timestamp: 3.5,
        }),
        transcriptMessageLine({
          role: "assistant",
          content: [{ type: "text", text: "inspection complete" }],
          timestamp: 4,
        }),
      ]);

      const res = await rpcReq<{ mode?: string; messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 10,
        maxChars: 100_000,
        mode: "messages",
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.mode).toBe("messages");
      expect(res.payload?.messages).toHaveLength(5);

      const serialized = JSON.stringify(res.payload?.messages ?? []);
      expect(serialized).toContain("[chat.history tool payload omitted]");
      expect(serialized).toContain('"toolPayloadOmitted":true');
      expect(serialized).toContain('"toolName":"read"');
      expect(serialized).toContain('"toolCallId":"call-read"');
      expect(serialized).toContain('"type":"canvas"');
      expect(serialized).toContain("cv_safe_history_messages");
      expect(serialized).toContain("please inspect");
      expect(serialized).toContain("checking with a tool");
      expect(serialized).toContain("inspection complete");
      expect(serialized).not.toContain(rawAssistantArgs);
      expect(serialized).not.toContain(rawToolResult);
    });
  });

  test("chat.history messages mode preserves safe text within the configured history budget", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        historyMaxBytes: 160 * 1024,
      });
      const longSafeText = `SAFE_TEXT_${"x".repeat(96 * 1024)}`;
      await writeMainSessionTranscript(sessionDir, [
        transcriptMessageLine({
          role: "user",
          content: [{ type: "text", text: "show me the long answer" }],
          timestamp: 1,
        }),
        transcriptMessageLine({
          role: "assistant",
          content: [{ type: "text", text: longSafeText }],
          timestamp: 2,
        }),
      ]);

      const res = await rpcReq<{ mode?: string; messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 10,
        maxChars: 120_000,
        mode: "messages",
      });

      const serialized = JSON.stringify(res.payload?.messages ?? []);
      expect(res.ok).toBe(true);
      expect(res.payload?.mode).toBe("messages");
      expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(64 * 1024);
      expect(serialized).toContain("SAFE_TEXT_");
      expect(serialized).not.toContain("...(truncated)...");
    });
  });

  test("chat.history messages mode ignores unsafeRawToolPayloads for admin callers", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      const rawAssistantArgs = "RAW_ASSISTANT_TOOL_ARGS_FOR_MESSAGES_MODE";
      const rawToolResult = "RAW_TOOL_RESULT_PAYLOAD_FOR_MESSAGES_MODE";
      await writeMainSessionTranscript(sessionDir, [
        transcriptMessageLine({
          role: "user",
          content: [{ type: "text", text: "please inspect" }],
          timestamp: 1,
        }),
        transcriptMessageLine({
          role: "assistant",
          content: [
            { type: "text", text: "checking with a tool" },
            {
              type: "toolCall",
              id: "call-messages-mode",
              name: "read",
              arguments: { path: `/tmp/${rawAssistantArgs}.txt` },
            },
          ],
          timestamp: 2,
        }),
        transcriptMessageLine({
          role: "toolResult",
          toolCallId: "call-messages-mode",
          toolName: "read",
          content: [{ type: "text", text: rawToolResult }],
          timestamp: 3,
        }),
      ]);

      const res = await rpcReq<{ mode?: string; messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 10,
        maxChars: 10_000,
        mode: "messages",
        unsafeRawToolPayloads: true,
      });
      expect(res.ok).toBe(true);
      // The documented contract is that unsafeRawToolPayloads only takes
      // effect with mode === "raw-messages". An admin caller that sends
      // mode === "messages" with the flag must still get the safe display
      // projection so raw tool args/results are not silently leaked.
      expect(res.payload?.mode).toBe("messages");
      const serialized = JSON.stringify(res.payload?.messages ?? []);
      expect(serialized).toContain("[chat.history tool payload omitted]");
      expect(serialized).toContain('"toolPayloadOmitted":true');
      expect(serialized).not.toContain(rawAssistantArgs);
      expect(serialized).not.toContain(rawToolResult);
    });
  });

  test("chat.history raw-messages requires an admin or debug caller", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      await connectOk(ws, { scopes: ["operator.read"] });
      const res = await rpcReq(ws, "chat.history", {
        sessionKey: "main",
        mode: "raw-messages",
      });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res.error)).toContain("operator.admin");
    });
  });

  test("chat.history raw-messages preserves raw tool payloads for admin callers", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      const rawAssistantArgs = "RAW_ASSISTANT_TOOL_ARGS_FOR_ADMIN";
      const rawToolResult = "RAW_TOOL_RESULT_PAYLOAD_FOR_ADMIN";
      await writeMainSessionTranscript(sessionDir, [
        transcriptMessageLine({
          role: "assistant",
          content: [
            { type: "text", text: "checking with a tool" },
            {
              type: "toolCall",
              id: "call-admin",
              name: "read",
              arguments: { path: `/tmp/${rawAssistantArgs}.txt` },
            },
          ],
          timestamp: 1,
        }),
        transcriptMessageLine({
          role: "toolResult",
          toolCallId: "call-admin",
          toolName: "read",
          content: [{ type: "text", text: rawToolResult }],
          timestamp: 2,
        }),
      ]);

      const res = await rpcReq<{ mode?: string; messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 10,
        maxChars: 10_000,
        mode: "raw-messages",
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.mode).toBe("raw-messages");
      const serialized = JSON.stringify(res.payload?.messages ?? []);
      expect(serialized).toContain(rawAssistantArgs);
      expect(serialized).toContain(rawToolResult);
      expect(serialized).not.toContain("[chat.history tool payload omitted]");
    });
  });

  test("chat.history preserves usage and cost metadata for assistant messages", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "assistant",
            timestamp: Date.now(),
            content: [{ type: "text", text: "hello" }],
            usage: { input: 12, output: 5, totalTokens: 17 },
            cost: { total: 0.0123 },
            details: { debug: true },
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      expect(messages).toHaveLength(1);
      const message = messages[0] as {
        role?: string;
        usage?: { input?: number; output?: number; totalTokens?: number };
        cost?: { total?: number };
      };
      expect(message.role).toBe("assistant");
      expect(message.usage?.input).toBe(12);
      expect(message.usage?.output).toBe(5);
      expect(message.usage?.totalTokens).toBe(17);
      expect(message.cost?.total).toBe(0.0123);
      expect(messages[0]).not.toHaveProperty("details");
    });
  });

  test("chat.history strips inline directives from displayed message text", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      const sessionDir = await createSessionDir();
      await writeMainSessionStore();

      const lines = [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Hello [[reply_to_current]] world [[audio_as_voice]]" },
            ],
            timestamp: Date.now(),
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "A [[reply_to:abc-123]] B",
            timestamp: Date.now() + 1,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            text: "[[ reply_to : 456 ]] C",
            timestamp: Date.now() + 2,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "  keep padded  " }],
            timestamp: Date.now() + 3,
          },
        }),
      ];
      await writeMainSessionTranscript(sessionDir, lines);
      const messages = await fetchHistoryMessages(ws);
      expect(messages.length).toBe(4);

      const serialized = JSON.stringify(messages);
      expect(serialized.includes("[[reply_to")).toBe(false);
      expect(serialized.includes("[[audio_as_voice]]")).toBe(false);

      const first = messages[0] as { content?: Array<{ text?: string }> };
      const second = messages[1] as { content?: string };
      const third = messages[2] as { text?: string };
      const fourth = messages[3] as { content?: Array<{ text?: string }> };

      expect(first.content?.[0]?.text?.replace(/\s+/g, " ").trim()).toBe("Hello world");
      expect(second.content?.replace(/\s+/g, " ").trim()).toBe("A B");
      expect(third.text?.replace(/\s+/g, " ").trim()).toBe("C");
      expect(fourth.content?.[0]?.text).toBe("  keep padded  ");
    });
  });

  test("chat.history keeps visible assistant progress text from mixed tool-use transcript messages", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "fix it" }],
            timestamp: 1,
          },
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private reasoning" },
              {
                type: "text",
                text: "I will clean that up now.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg-progress",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call-read",
                name: "read",
                arguments: { path: "AGENTS.md" },
              },
            ],
            timestamp: 2,
          },
        }),
        JSON.stringify({
          message: {
            role: "toolResult",
            toolCallId: "call-read",
            toolName: "read",
            content: [{ type: "text", text: "file contents" }],
            timestamp: 3,
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      const assistantMessage = messages[1] as {
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
        timestamp?: number;
      };
      expect(assistantMessage.role).toBe("assistant");
      expect(assistantMessage.content).toEqual([
        { type: "text", text: "I will clean that up now." },
      ]);
      expect(assistantMessage.timestamp).toBe(2);
    });
  });

  test("chat.history turns mode preserves recent visible turns from tool-heavy transcripts", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      const lines: string[] = [];
      let timestamp = 1;
      for (let turn = 1; turn <= 8; turn += 1) {
        const turnId = `turn-${turn}`;
        lines.push(
          transcriptMessageLine({
            role: "user",
            turnId,
            content: [{ type: "text", text: `user turn ${turn}` }],
            timestamp: timestamp++,
          }),
        );
        for (let tool = 1; tool <= 6; tool += 1) {
          const toolCallId = `${turnId}-tool-${tool}`;
          lines.push(
            transcriptMessageLine({
              role: "assistant",
              turnId,
              content: [
                {
                  type: "toolCall",
                  id: toolCallId,
                  name: `tool_${tool}`,
                  arguments: { path: `file-${tool}.ts` },
                },
              ],
              timestamp: timestamp++,
            }),
          );
          lines.push(
            transcriptMessageLine({
              role: "toolResult",
              turnId,
              toolCallId,
              toolName: `tool_${tool}`,
              content: [{ type: "text", text: `tool result ${turn}.${tool}` }],
              timestamp: timestamp++,
            }),
          );
        }
        lines.push(
          transcriptMessageLine({
            role: "assistant",
            turnId,
            content: [{ type: "text", text: `assistant final turn ${turn}` }],
            provider: "codex",
            model: "gpt-5.5",
            timestamp: timestamp++,
          }),
        );
      }
      await writeMainSessionTranscript(sessionDir, lines);

      const res = await rpcReq<{
        mode?: string;
        messages?: unknown[];
        items?: Array<{
          user?: { preview?: string };
          assistant?: { preview?: string };
          tools?: { count?: number; names?: string[] };
        }>;
        meta?: { toolRecordsCollapsed?: number; displayItemsReturned?: number };
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 3,
        maxChars: 1_000,
        mode: "turns",
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.mode).toBe("turns");
      expect(res.payload?.items).toHaveLength(3);
      expect(res.payload?.meta?.displayItemsReturned).toBe(3);
      expect(res.payload?.meta?.toolRecordsCollapsed).toBeGreaterThan(0);

      const text = historyText(res.payload?.messages ?? []);
      for (const turn of [6, 7, 8]) {
        expect(text).toContain(`user turn ${turn}`);
        expect(text).toContain(`assistant final turn ${turn}`);
      }
      expect(text).toContain("6 tool activities");
      expect(text).not.toContain("user turn 5");
      expect(text).not.toContain("assistant final turn 5");
    });
  });

  test("chat.history turns mode scans past tool-heavy current turns", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      const turnId = "tool-heavy-current-turn";
      const lines: string[] = [
        transcriptMessageLine({
          role: "user",
          turnId,
          content: [{ type: "text", text: "please inspect the large patch" }],
          timestamp: 1,
        }),
      ];
      let timestamp = 2;
      for (let tool = 1; tool <= 30; tool += 1) {
        const toolCallId = `${turnId}-tool-${tool}`;
        lines.push(
          transcriptMessageLine({
            role: "assistant",
            turnId,
            content: [
              {
                type: "toolCall",
                id: toolCallId,
                name: "read",
                arguments: { path: `src/file-${tool}.ts` },
              },
            ],
            timestamp: timestamp++,
          }),
        );
        lines.push(
          transcriptMessageLine({
            role: "toolResult",
            turnId,
            toolCallId,
            toolName: "read",
            content: [{ type: "text", text: `tool result ${tool}` }],
            timestamp: timestamp++,
          }),
        );
      }
      lines.push(
        transcriptMessageLine({
          role: "assistant",
          turnId,
          content: [{ type: "text", text: "the patch is safe to publish" }],
          timestamp: timestamp++,
        }),
      );
      await writeMainSessionTranscript(sessionDir, lines);

      const res = await rpcReq<{
        mode?: string;
        messages?: unknown[];
        items?: Array<{
          user?: { preview?: string };
          assistant?: { preview?: string };
          tools?: { count?: number };
        }>;
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1,
        maxChars: 1_000,
        mode: "turns",
      });

      expect(res.ok).toBe(true);
      expect(res.payload?.mode).toBe("turns");
      expect(res.payload?.items).toHaveLength(1);
      expect(res.payload?.items?.[0]?.user?.preview).toContain("please inspect");
      expect(res.payload?.items?.[0]?.assistant?.preview).toContain("safe to publish");
      expect(res.payload?.items?.[0]?.tools?.count).toBe(30);
      const text = historyText(res.payload?.messages ?? []);
      expect(text).toContain("please inspect the large patch");
      expect(text).toContain("the patch is safe to publish");
    });
  });

  test("chat.history turns mode reports earlier history when the scan window saturates", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      const lines: string[] = [];
      for (let turn = 1; turn <= 1001; turn += 1) {
        lines.push(
          transcriptMessageLine({
            role: "user",
            turnId: `saturated-turn-${turn}`,
            content: [{ type: "text", text: `saturated user turn ${turn}` }],
            timestamp: turn,
          }),
        );
      }
      await writeMainSessionTranscript(sessionDir, lines);

      const res = await rpcReq<{
        mode?: string;
        items?: unknown[];
        meta?: { hasMoreBefore?: boolean; displayItemsReturned?: number };
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1000,
        maxChars: 200,
        mode: "turns",
      });

      expect(res.ok).toBe(true);
      expect(res.payload?.mode).toBe("turns");
      expect(res.payload?.items).toHaveLength(1000);
      expect(res.payload?.meta?.displayItemsReturned).toBe(1000);
      expect(res.payload?.meta?.hasMoreBefore).toBe(true);
    });
  });

  test("chat.history turns mode bounds response items by the history byte budget", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const historyMaxBytes = 6 * 1024;
      const sessionDir = await prepareMainHistoryHarness({
        ws,
        createSessionDir,
        historyMaxBytes,
      });
      const lines: string[] = [];
      let timestamp = 1;
      for (let turn = 1; turn <= 10; turn += 1) {
        const turnId = `large-turn-${turn}`;
        lines.push(
          transcriptMessageLine({
            role: "user",
            turnId,
            content: [{ type: "text", text: `user-${turn}:${"u".repeat(2_000)}` }],
            timestamp: timestamp++,
          }),
        );
        lines.push(
          transcriptMessageLine({
            role: "assistant",
            turnId,
            content: [{ type: "text", text: `assistant-${turn}:${"a".repeat(2_000)}` }],
            timestamp: timestamp++,
          }),
        );
      }
      await writeMainSessionTranscript(sessionDir, lines);

      const res = await rpcReq<{ messages?: unknown[]; items?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 10,
        maxChars: 4_000,
        mode: "turns",
      });

      expect(res.ok).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(res.payload), "utf8")).toBeLessThanOrEqual(
        historyMaxBytes,
      );
    });
  });

  test("chat.history turns mode exposes compact tool summaries without raw tool payloads", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      const canvasPreview = JSON.stringify({
        kind: "canvas",
        view: {
          id: "cv_safe_history_turns",
          url: "/__openclaw__/canvas/documents/cv_safe_history_turns/index.html",
          title: "Safe turns canvas",
        },
        presentation: { target: "assistant_message" },
      });
      await writeMainSessionTranscript(sessionDir, [
        transcriptMessageLine({
          role: "user",
          turnId: "turn-1",
          content: [{ type: "text", text: "inspect this" }],
          timestamp: 1,
        }),
        transcriptMessageLine({
          role: "assistant",
          turnId: "turn-1",
          content: [
            { type: "toolCall", id: "call-rg", name: "rg", arguments: { q: "needle" } },
            { type: "toolCall", id: "call-sed", name: "sed", arguments: { path: "file.ts" } },
          ],
          timestamp: 2,
        }),
        transcriptMessageLine({
          role: "toolResult",
          turnId: "turn-1",
          toolCallId: "call-rg",
          toolName: "rg",
          content: [{ type: "text", text: "needle payload that should not render raw" }],
          timestamp: 3,
        }),
        transcriptMessageLine({
          role: "tool",
          turnId: "turn-1",
          toolCallId: "call-sed",
          toolName: "sed",
          content: [{ type: "text", text: canvasPreview }],
          timestamp: 4,
        }),
        transcriptMessageLine({
          role: "assistant",
          turnId: "turn-1",
          content: [{ type: "text", text: "done" }],
          timestamp: 5,
        }),
      ]);

      const res = await rpcReq<{
        messages?: unknown[];
        items?: Array<{ tools?: { count?: number; names?: string[]; status?: string } }>;
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1,
        maxChars: 1_000,
        mode: "turns",
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.items?.[0]?.tools).toMatchObject({
        count: 2,
        names: ["rg", "sed"],
        status: "completed",
      });

      const text = historyText(res.payload?.messages ?? []);
      expect(text).toContain("2 tool activities: rg, sed");
      expect(text).toContain("inspect this");
      expect(text).toContain("done");
      expect(text).not.toContain("needle payload that should not render raw");
      const serialized = JSON.stringify(res.payload?.messages ?? []);
      expect(serialized).toContain('"type":"canvas"');
      expect(serialized).toContain("cv_safe_history_turns");
    });
  });

  test("chat.history turns mode keeps timestamp-less transcripts stable", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(sessionDir, [
        transcriptMessageLine({
          role: "user",
          content: [{ type: "text", text: "timestamp-less user" }],
        }),
        transcriptMessageLine({
          role: "assistant",
          content: [{ type: "text", text: "timestamp-less assistant" }],
        }),
      ]);

      const first = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1,
        mode: "turns",
      });
      const second = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1,
        mode: "turns",
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(second.payload?.messages).toStrictEqual(first.payload?.messages);
      for (const message of first.payload?.messages ?? []) {
        expect(message).not.toHaveProperty("timestamp");
      }
    });
  });

  test("chat.history turns mode groups fallback transcripts with snake_case tool results", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(sessionDir, [
        transcriptMessageLine({
          role: "user",
          content: [{ type: "text", text: "inspect fallback transcript" }],
          timestamp: 1,
        }),
        transcriptMessageLine({
          role: "assistant",
          content: [
            { type: "toolCall", id: "call-read", name: "read", arguments: { path: "file.ts" } },
          ],
          timestamp: 2,
        }),
        transcriptMessageLine({
          role: "tool_result",
          toolCallId: "call-read",
          toolName: "read",
          content: [{ type: "text", text: "raw fallback payload should not render" }],
          timestamp: 3,
        }),
        transcriptMessageLine({
          role: "assistant",
          content: [{ type: "text", text: "fallback transcript complete" }],
          timestamp: 4,
        }),
      ]);

      const res = await rpcReq<{
        messages?: unknown[];
        items?: Array<{
          user?: { preview?: string };
          assistant?: { preview?: string };
          tools?: { count?: number; names?: string[]; status?: string };
        }>;
      }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1,
        maxChars: 1_000,
        mode: "turns",
      });

      expect(res.ok).toBe(true);
      expect(res.payload?.items).toHaveLength(1);
      expect(res.payload?.items?.[0]?.user?.preview).toBe("inspect fallback transcript");
      expect(res.payload?.items?.[0]?.assistant?.preview).toBe("fallback transcript complete");
      expect(res.payload?.items?.[0]?.tools).toMatchObject({
        count: 1,
        names: ["read"],
        status: "completed",
      });

      const text = historyText(res.payload?.messages ?? []);
      expect(text).toContain("inspect fallback transcript");
      expect(text).toContain("fallback transcript complete");
      expect(text).toContain("1 tool activity: read");
      expect(text).not.toContain("raw fallback payload should not render");
    });
  });

  test("chat.history applies gateway.webchat.chatHistoryMaxChars from config", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig({
        gateway: {
          webchat: {
            chatHistoryMaxChars: 5,
          },
        },
      });
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "abcdefghij" }],
            timestamp: Date.now(),
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      expect(JSON.stringify(messages)).toContain("abcde\\n...(truncated)...");
    });
  });

  test("chat.history prefers RPC maxChars over config", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig({
        gateway: {
          webchat: {
            chatHistoryMaxChars: 3,
          },
        },
      });
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "abcdefghij" }],
            timestamp: Date.now(),
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { maxChars: 7 });
      const serialized = JSON.stringify(messages);
      expect(serialized).toContain("abcdefg\\n...(truncated)...");
      expect(serialized).not.toContain("abc\\n...(truncated)...");
    });
  });

  test("chat.history rejects invalid RPC maxChars values", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });

      const zeroRes = await rpcReq(ws, "chat.history", {
        sessionKey: "main",
        maxChars: 0,
      });
      expect(zeroRes.ok).toBe(false);
      expect((zeroRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /invalid chat\.history params/i,
      );

      const tooLargeRes = await rpcReq(ws, "chat.history", {
        sessionKey: "main",
        maxChars: 500_001,
      });
      expect(tooLargeRes.ok).toBe(false);
      expect((tooLargeRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /invalid chat\.history params/i,
      );
    });
  });

  test("chat.history still drops assistant NO_REPLY entries before truncation", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "NO_REPLY" }],
            timestamp: Date.now(),
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { maxChars: 3 });
      expect(messages).toStrictEqual([]);
    });
  });

  test("smoke: supports abort and idempotent completion", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = getReplyFromConfig;
      let aborted = false;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();

      mockGetReplyFromConfigOnce(async (_ctx, opts) => {
        opts?.onAgentRunStart?.(opts.runId ?? "idem-abort-1");
        const signal = opts?.abortSignal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) {
            aborted = Boolean(signal?.aborted);
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return undefined;
      });

      const sendResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-abort-1", 2_000);
      sendReq(ws, "send-abort-1", "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
        timeoutMs: 30_000,
      });

      const sendRes = await sendResP;
      expect(sendRes.ok).toBe(true);
      await vi.waitFor(() => {
        expect(spy.mock.calls.length).toBeGreaterThan(0);
      }, FAST_WAIT_OPTS);

      const inFlight = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
      });
      expect(inFlight.ok).toBe(true);
      expect(["started", "in_flight", "ok"]).toContain(inFlight.payload?.status ?? "");

      const abortRes = await rpcReq<{ aborted?: boolean }>(ws, "chat.abort", {
        sessionKey: "main",
        runId: "idem-abort-1",
      });
      expect(abortRes.ok).toBe(true);
      expect(abortRes.payload?.aborted).toBe(true);
      await vi.waitFor(() => {
        expect(aborted).toBe(true);
      }, FAST_WAIT_OPTS);

      spy.mockClear();
      spy.mockResolvedValueOnce(undefined);

      const completeRes = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-complete-1",
      });
      expect(completeRes.ok).toBe(true);

      await vi.waitFor(async () => {
        const again = await rpcReq<{ status?: string }>(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-complete-1",
        });
        expect(again.ok).toBe(true);
        expect(again.payload?.status).toBe("ok");
      }, FAST_WAIT_OPTS);
    });
  });
});
