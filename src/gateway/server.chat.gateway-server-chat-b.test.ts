import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import { clearConfigCache } from "../config/config.js";
import { clearSessionStoreCacheForTest, type SessionEntry } from "../config/sessions.js";
import { writeSessionStoreCache } from "../config/sessions/store-cache.js";
import * as hookRunnerGlobal from "../plugins/hook-runner-global.js";
import * as transcriptEvents from "../sessions/transcript-events.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { __setMaxChatHistoryMessagesBytesForTest } from "./server-constants.js";
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
    __setMaxChatHistoryMessagesBytesForTest();
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

async function readTranscriptRecords(
  transcriptPath: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(transcriptPath, "utf-8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw err;
  });
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readSessionTranscriptRecords(
  sessionDir: string,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  return readTranscriptRecords(path.join(sessionDir, `${sessionId}.jsonl`));
}

type ChatSendResponse = { id: string; ok: boolean; payload?: unknown; error?: unknown };

type ChatSendDispatchParams = {
  dispatcher: {
    sendFinalReply: (payload: { text: string }) => boolean;
    markComplete: () => void;
    waitForIdle: () => Promise<void>;
  };
  replyOptions?: Pick<
    GetReplyOptions,
    | "onAgentRunStart"
    | "suppressNextUserMessagePersistence"
    | "suppressNextUserMessagePersistenceSessionId"
    | "suppressNextUserMessagePersistenceEntryId"
  >;
};

function createChatSendContext(
  params: {
    activeRuns?: Map<string, { sessionKey: string; sessionId?: string }>;
  } = {},
): GatewayRequestContext {
  return {
    loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
    logGateway: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    agentRunSeq: new Map<string, number>(),
    chatAbortControllers: params.activeRuns ?? new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    registerToolEventRecipient: vi.fn(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

async function writeMainWebchatSession(entry: Partial<SessionEntry> = {}) {
  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-main",
        updatedAt: Date.now(),
        ...entry,
      },
    },
  });
}

async function callWebchatChatSend(params: {
  context: GatewayRequestContext;
  responses: ChatSendResponse[];
  requestId: string;
  message: string;
  idempotencyKey: string;
}) {
  const requestParams = {
    sessionKey: "main",
    message: params.message,
    idempotencyKey: params.idempotencyKey,
  };
  const { chatHandlers } = await import("./server-methods/chat.js");
  await chatHandlers["chat.send"]({
    req: {
      type: "req",
      id: params.requestId,
      method: "chat.send",
      params: requestParams,
    },
    params: requestParams,
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
      params.responses.push({ id: params.requestId, ok, payload, error });
    }) as RespondFn,
    context: params.context,
  });
}

function expectChatSendStarted(params: {
  responses: ChatSendResponse[];
  requestId: string;
  runId: string;
}) {
  expect(params.responses).toContainEqual({
    id: params.requestId,
    ok: true,
    payload: { runId: params.runId, status: "started" },
    error: undefined,
  });
}

function findUserTranscriptEntries(records: Array<Record<string, unknown>>, content?: string) {
  return records.filter((record) => {
    const message = record.message as { role?: unknown; content?: unknown } | undefined;
    return message?.role === "user" && (content === undefined || message.content === content);
  });
}

async function fetchHistoryMessages(
  ws: GatewaySocket,
  params?: {
    limit?: number;
    maxChars?: number;
  },
): Promise<unknown[]> {
  const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
    sessionKey: "main",
    limit: params?.limit ?? 1000,
    ...(typeof params?.maxChars === "number" ? { maxChars: params.maxChars } : {}),
  });
  expect(historyRes.ok).toBe(true);
  return historyRes.payload?.messages ?? [];
}

async function prepareMainHistoryHarness(params: {
  ws: GatewaySocket;
  createSessionDir: () => Promise<string>;
  historyMaxBytes?: number;
}) {
  if (params.historyMaxBytes !== undefined) {
    __setMaxChatHistoryMessagesBytesForTest(params.historyMaxBytes);
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
      expect(responses).toContainEqual({
        id: "duplicate",
        ok: true,
        payload: { runId: "idem-attachment-race", status: "started" },
        error: undefined,
      });

      firstCatalog.resolve([
        {
          id: "vision-model",
          name: "Vision Model",
          provider: "test-provider",
          input: ["text", "image"],
        },
      ]);
      await first;

      expect(responses).toContainEqual({
        id: "first",
        ok: true,
        payload: { runId: "idem-attachment-race", status: "in_flight" },
        error: undefined,
      });
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
        expect(responses).toContainEqual({
          id: "first",
          ok: true,
          payload: { runId: "idem-active-a", status: "started" },
          error: undefined,
        });
      }, FAST_WAIT_OPTS);

      await callSend("duplicate", "idem-active-b");

      expect(responses).toContainEqual({
        id: "duplicate",
        ok: true,
        payload: { runId: "idem-active-a", status: "in_flight" },
        error: undefined,
      });
      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
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

      expect(responses).toContainEqual({
        id: "first",
        ok: true,
        payload: { runId: "idem-sequential-a", status: "started" },
        error: undefined,
      });
      expect(responses).toContainEqual({
        id: "second",
        ok: true,
        payload: { runId: "idem-sequential-b", status: "started" },
        error: undefined,
      });
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(context.addChatRun).toHaveBeenCalledTimes(2);
    } finally {
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send persists WebChat user turns before dispatch enters the agent lane", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const dispatchRelease = createDeferred<void>();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeMainWebchatSession();

      const responses: ChatSendResponse[] = [];
      const context = createChatSendContext();
      let dispatchParams: ChatSendDispatchParams | undefined;
      dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
        dispatchParams = params as ChatSendDispatchParams;
        dispatchParams?.replyOptions?.onAgentRunStart?.("idem-eager-user");
        await dispatchRelease.promise;
      });

      await callWebchatChatSend({
        context,
        responses,
        requestId: "send-eager-user",
        message: "show quickly",
        idempotencyKey: "idem-eager-user",
      });

      expectChatSendStarted({
        responses,
        requestId: "send-eager-user",
        runId: "idem-eager-user",
      });
      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
      expect(dispatchParams?.replyOptions?.suppressNextUserMessagePersistence).toBe(true);
      expect(dispatchParams?.replyOptions?.suppressNextUserMessagePersistenceSessionId).toBe(
        "sess-main",
      );
      expect(dispatchParams?.replyOptions?.suppressNextUserMessagePersistenceEntryId).toEqual(
        expect.any(String),
      );
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:main",
          messageId: expect.any(String),
          message: expect.objectContaining({
            role: "user",
            content: "show quickly",
          }),
        }),
      );

      const records = await readSessionTranscriptRecords(sessionDir, "sess-main");
      const durableUserEntries = findUserTranscriptEntries(records);
      expect(durableUserEntries).toHaveLength(1);
      expect(durableUserEntries[0]).toEqual(
        expect.objectContaining({
          type: "message",
          id: expect.any(String),
          parentId: null,
          message: expect.objectContaining({
            role: "user",
            content: "show quickly",
          }),
        }),
      );

      dispatchRelease.resolve();
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
    } finally {
      emitSpy.mockRestore();
      dispatchRelease.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send skips WebChat transcript persistence for reset commands", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeMainWebchatSession();

      const responses: ChatSendResponse[] = [];
      const context = createChatSendContext();
      let dispatchParams: ChatSendDispatchParams | undefined;
      dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
        dispatchParams = params as ChatSendDispatchParams;
        dispatchParams.dispatcher.sendFinalReply({ text: "reset handled" });
        dispatchParams.dispatcher.markComplete();
        await dispatchParams.dispatcher.waitForIdle();
        return {
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
        };
      });

      await callWebchatChatSend({
        context,
        responses,
        requestId: "send-reset-user",
        message: "/new clean branch",
        idempotencyKey: "idem-reset-user",
      });

      expectChatSendStarted({
        responses,
        requestId: "send-reset-user",
        runId: "idem-reset-user",
      });
      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
      expect(dispatchParams?.replyOptions?.suppressNextUserMessagePersistence).toBeUndefined();
      expect(
        dispatchParams?.replyOptions?.suppressNextUserMessagePersistenceSessionId,
      ).toBeUndefined();
      expect(
        dispatchParams?.replyOptions?.suppressNextUserMessagePersistenceEntryId,
      ).toBeUndefined();
      expect(emitSpy).not.toHaveBeenCalled();
      expect(await readSessionTranscriptRecords(sessionDir, "sess-main")).toHaveLength(0);

      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
    } finally {
      emitSpy.mockRestore();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send applies transcript redaction before eager WebChat persistence", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const dispatchRelease = createDeferred<void>();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    const secret = "sk-1234567890abcdef";
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeMainWebchatSession();

      const responses: ChatSendResponse[] = [];
      const context = createChatSendContext();
      dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
        (params as ChatSendDispatchParams).replyOptions?.onAgentRunStart?.("idem-redacted-user");
        await dispatchRelease.promise;
      });

      await callWebchatChatSend({
        context,
        responses,
        requestId: "send-redacted-user",
        message: `please inspect OPENAI_API_KEY=${secret}`,
        idempotencyKey: "idem-redacted-user",
      });

      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
      const records = await readSessionTranscriptRecords(sessionDir, "sess-main");
      const rawTranscript = JSON.stringify(records);
      expect(rawTranscript).not.toContain(secret);
      expect(rawTranscript).toContain("OPENAI_API_KEY=");
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            role: "user",
            content: expect.not.stringContaining(secret),
          }),
        }),
      );

      dispatchRelease.resolve();
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
    } finally {
      emitSpy.mockRestore();
      dispatchRelease.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send skips eager WebChat persistence when message-write hooks are registered", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const dispatchRelease = createDeferred<void>();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    const hookRunnerSpy = vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue({
      hasHooks: (hookName: string) => hookName === "before_message_write",
    } as never);
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeMainWebchatSession();

      const responses: ChatSendResponse[] = [];
      const context = createChatSendContext();
      let dispatchParams: ChatSendDispatchParams | undefined;
      dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
        dispatchParams = params as ChatSendDispatchParams;
        dispatchParams?.replyOptions?.onAgentRunStart?.("idem-hooked-user");
        await dispatchRelease.promise;
      });

      await callWebchatChatSend({
        context,
        responses,
        requestId: "send-hooked-user",
        message: "do not bypass hooks",
        idempotencyKey: "idem-hooked-user",
      });

      expectChatSendStarted({
        responses,
        requestId: "send-hooked-user",
        runId: "idem-hooked-user",
      });
      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
      expect(dispatchParams?.replyOptions?.suppressNextUserMessagePersistence).toBeUndefined();
      expect(
        dispatchParams?.replyOptions?.suppressNextUserMessagePersistenceSessionId,
      ).toBeUndefined();
      expect(
        dispatchParams?.replyOptions?.suppressNextUserMessagePersistenceEntryId,
      ).toBeUndefined();
      expect(emitSpy).not.toHaveBeenCalled();
      expect(await readSessionTranscriptRecords(sessionDir, "sess-main")).toHaveLength(0);

      dispatchRelease.resolve();
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
    } finally {
      hookRunnerSpy.mockRestore();
      emitSpy.mockRestore();
      dispatchRelease.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send retries fallback persistence when eager WebChat persistence has no session yet", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");

      const responses: ChatSendResponse[] = [];
      const context = createChatSendContext();
      let dispatchParams: ChatSendDispatchParams | undefined;
      dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
        dispatchParams = params as ChatSendDispatchParams;
        await writeMainWebchatSession();
        dispatchParams.dispatcher.sendFinalReply({ text: "first non-agent reply" });
        dispatchParams.dispatcher.markComplete();
        await dispatchParams.dispatcher.waitForIdle();
        return {
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
        };
      });

      await callWebchatChatSend({
        context,
        responses,
        requestId: "send-first-fallback-user",
        message: "first fallback user",
        idempotencyKey: "idem-first-fallback-user",
      });

      expectChatSendStarted({
        responses,
        requestId: "send-first-fallback-user",
        runId: "idem-first-fallback-user",
      });
      await vi.waitFor(
        () => {
          expect(context.removeChatRun).toHaveBeenCalledTimes(1);
        },
        { timeout: 1000, interval: 5 },
      );
      expect(dispatchParams?.replyOptions?.suppressNextUserMessagePersistence).toBeUndefined();
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:main",
          message: expect.objectContaining({
            role: "user",
            content: "first fallback user",
          }),
        }),
      );
      const emitCall = emitSpy.mock.calls.find((call) => {
        const payload = call[0] as { message?: { role?: unknown; content?: unknown } };
        return (
          payload.message?.role === "user" && payload.message.content === "first fallback user"
        );
      });
      const sessionFile = (emitCall?.[0] as { sessionFile?: string } | undefined)?.sessionFile;
      expect(sessionFile).toEqual(expect.any(String));
      const records = await readTranscriptRecords(sessionFile as string);
      const userEntries = findUserTranscriptEntries(records, "first fallback user");
      expect(userEntries).toHaveLength(1);
    } finally {
      emitSpy.mockRestore();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send applies message-write hooks when fallback persistence records a non-agent WebChat turn", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    const runBeforeMessageWrite = vi.fn(
      (event: { message: { role?: string; content?: unknown } }) => ({
        message: {
          ...event.message,
          content: "hook transformed fallback user",
        },
      }),
    );
    const hookRunnerSpy = vi.spyOn(hookRunnerGlobal, "getGlobalHookRunner").mockReturnValue({
      hasHooks: (hookName: string) => hookName === "before_message_write",
      runBeforeMessageWrite,
    } as never);
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeMainWebchatSession();

      const responses: ChatSendResponse[] = [];
      const context = createChatSendContext();
      let dispatchParams: ChatSendDispatchParams | undefined;
      dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
        dispatchParams = params as ChatSendDispatchParams;
        dispatchParams.dispatcher.sendFinalReply({ text: "non-agent hook reply" });
        dispatchParams.dispatcher.markComplete();
        await dispatchParams.dispatcher.waitForIdle();
        return {
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
        };
      });

      await callWebchatChatSend({
        context,
        responses,
        requestId: "send-hook-fallback-user",
        message: "fallback hook original",
        idempotencyKey: "idem-hook-fallback-user",
      });

      expectChatSendStarted({
        responses,
        requestId: "send-hook-fallback-user",
        runId: "idem-hook-fallback-user",
      });
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
      expect(dispatchParams?.replyOptions?.suppressNextUserMessagePersistence).toBeUndefined();
      expect(runBeforeMessageWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            role: "user",
            content: "fallback hook original",
          }),
        }),
        expect.objectContaining({
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
      );
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:main",
          message: expect.objectContaining({
            role: "user",
            content: "hook transformed fallback user",
          }),
        }),
      );
      const records = await readSessionTranscriptRecords(sessionDir, "sess-main");
      const userEntries = findUserTranscriptEntries(records);
      expect(userEntries).toHaveLength(1);
      expect((userEntries[0]?.message as { content?: unknown } | undefined)?.content).toBe(
        "hook transformed fallback user",
      );
      expect(JSON.stringify(records)).not.toContain("fallback hook original");
    } finally {
      hookRunnerSpy.mockRestore();
      emitSpy.mockRestore();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send defers eager WebChat persistence while the same session has an active run", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const dispatchRelease = createDeferred<void>();
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      await writeMainWebchatSession();

      const responses: ChatSendResponse[] = [];
      const context = createChatSendContext({
        activeRuns: new Map([
          [
            "active-existing",
            {
              sessionKey: "main",
              sessionId: "sess-main",
            },
          ],
        ]),
      });
      let dispatchParams: ChatSendDispatchParams | undefined;
      dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
        dispatchParams = params as ChatSendDispatchParams;
        dispatchParams?.replyOptions?.onAgentRunStart?.("idem-queued-user");
        await dispatchRelease.promise;
      });

      await callWebchatChatSend({
        context,
        responses,
        requestId: "send-queued-user",
        message: "wait behind active run",
        idempotencyKey: "idem-queued-user",
      });

      expectChatSendStarted({
        responses,
        requestId: "send-queued-user",
        runId: "idem-queued-user",
      });
      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
      expect(dispatchParams?.replyOptions?.suppressNextUserMessagePersistence).toBeUndefined();
      expect(
        dispatchParams?.replyOptions?.suppressNextUserMessagePersistenceSessionId,
      ).toBeUndefined();
      expect(
        dispatchParams?.replyOptions?.suppressNextUserMessagePersistenceEntryId,
      ).toBeUndefined();
      expect(emitSpy).not.toHaveBeenCalled();
      expect(await readSessionTranscriptRecords(sessionDir, "sess-main")).toHaveLength(0);

      dispatchRelease.resolve();
      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
    } finally {
      emitSpy.mockRestore();
      dispatchRelease.resolve();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send persists WebChat user turns into the active session after daily rollover", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    try {
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");
      const staleAt = Date.now() - 72 * 60 * 60 * 1000;
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            sessionStartedAt: staleAt,
            lastInteractionAt: staleAt,
            updatedAt: staleAt,
          },
        },
      });
      await writeMainSessionTranscript(sessionDir, [
        JSON.stringify({
          type: "session",
          id: "sess-main",
          timestamp: new Date(staleAt).toISOString(),
        }),
      ]);

      const responses: ChatSendResponse[] = [];
      const context = createChatSendContext();
      let dispatchParams: ChatSendDispatchParams | undefined;
      dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
        dispatchParams = params as ChatSendDispatchParams;
      });

      await callWebchatChatSend({
        context,
        responses,
        requestId: "send-rollover-eager-user",
        message: "visible after rollover",
        idempotencyKey: "idem-rollover-eager-user",
      });

      expectChatSendStarted({
        responses,
        requestId: "send-rollover-eager-user",
        runId: "idem-rollover-eager-user",
      });
      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);

      const store = JSON.parse(
        await fs.readFile(path.join(sessionDir, "sessions.json"), "utf-8"),
      ) as Record<string, { sessionFile?: string; sessionId?: string }>;
      const activeEntry = store["agent:main:main"];
      const activeSessionId = activeEntry?.sessionId;
      expect(activeSessionId).toEqual(expect.any(String));
      expect(activeSessionId).not.toBe("sess-main");
      expect(dispatchParams?.replyOptions?.suppressNextUserMessagePersistence).toBe(true);
      expect(dispatchParams?.replyOptions?.suppressNextUserMessagePersistenceSessionId).toBe(
        activeSessionId,
      );
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:main",
          message: expect.objectContaining({
            role: "user",
            content: "visible after rollover",
          }),
        }),
      );

      const activeTranscriptPath =
        activeEntry?.sessionFile ?? path.join(sessionDir, `${activeSessionId}.jsonl`);
      const activeRecords = await readTranscriptRecords(activeTranscriptPath);
      const activeUserEntries = findUserTranscriptEntries(activeRecords, "visible after rollover");
      expect(activeUserEntries).toHaveLength(1);

      const staleFiles = (await fs.readdir(sessionDir)).filter((name) =>
        name.startsWith("sess-main.jsonl"),
      );
      for (const staleFile of staleFiles) {
        const staleRaw = await fs.readFile(path.join(sessionDir, staleFile), "utf-8");
        expect(staleRaw).not.toContain("visible after rollover");
      }

      await vi.waitFor(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
    } finally {
      emitSpy.mockRestore();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  test("chat.send ignores stale session-store cache before eager WebChat persistence", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      const storePath = path.join(sessionDir, "sessions.json");
      testState.sessionStorePath = storePath;
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-fresh",
            updatedAt: Date.now(),
          },
        },
      });
      const staleStore: Record<string, SessionEntry> = {
        "agent:main:main": {
          sessionId: "sess-stale",
          updatedAt: Date.now() - 1_000,
        },
      };
      const stat = await fs.stat(storePath);
      writeSessionStoreCache({
        storePath,
        store: staleStore,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        serialized: JSON.stringify(staleStore),
      });

      const responses: ChatSendResponse[] = [];
      const context = createChatSendContext();
      let dispatchParams: ChatSendDispatchParams | undefined;
      dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
        dispatchParams = params as ChatSendDispatchParams;
      });

      await callWebchatChatSend({
        context,
        responses,
        requestId: "send-cache-race-eager-user",
        message: "fresh cache target",
        idempotencyKey: "idem-cache-race-eager-user",
      });

      expectChatSendStarted({
        responses,
        requestId: "send-cache-race-eager-user",
        runId: "idem-cache-race-eager-user",
      });
      await vi.waitFor(() => {
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
      expect(dispatchParams?.replyOptions?.suppressNextUserMessagePersistence).toBe(true);
      expect(dispatchParams?.replyOptions?.suppressNextUserMessagePersistenceSessionId).toBe(
        "sess-fresh",
      );

      const freshRecords = await readSessionTranscriptRecords(sessionDir, "sess-fresh");
      const freshUserEntries = findUserTranscriptEntries(freshRecords, "fresh cache target");
      expect(freshUserEntries).toHaveLength(1);

      const staleRecords = await readSessionTranscriptRecords(sessionDir, "sess-stale");
      const staleUserEntries = findUserTranscriptEntries(staleRecords, "fresh cache target");
      expect(staleUserEntries).toHaveLength(0);
    } finally {
      clearSessionStoreCacheForTest();
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
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
      const messages = await fetchHistoryMessages(ws);
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
      const messages = await fetchHistoryMessages(ws);
      const serialized = JSON.stringify(messages);
      const bytes = Buffer.byteLength(serialized, "utf8");

      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeGreaterThan(1);
      expect(serialized).toContain("small-29:");
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
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
