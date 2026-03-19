import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { emitAgentEvent, registerAgentRunContext } from "../infra/agent-events.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  connectOk,
  getReplyFromConfig,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
  writeSessionStore,
} from "./test-helpers.js";
import { agentCommand } from "./test-helpers.mocks.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
const CHAT_RESPONSE_TIMEOUT_MS = 4_000;

let ws: WebSocket;
let port: number;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
  port = started.port;
});

async function waitFor(condition: () => boolean, timeoutMs = 250, stepMs = 2) {
  vi.useFakeTimers();
  try {
    for (let elapsed = 0; elapsed <= timeoutMs; elapsed += stepMs) {
      if (condition()) {
        return;
      }
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(stepMs);
    }
  } finally {
    vi.useRealTimers();
  }
  throw new Error("timeout waiting for condition");
}

describe("gateway server chat", () => {
  const buildNoReplyHistoryFixture = (includeMixedAssistant = false) => [
    {
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "NO_REPLY" }],
      timestamp: 2,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "real reply" }],
      timestamp: 3,
    },
    {
      role: "assistant",
      text: "real text field reply",
      content: "NO_REPLY",
      timestamp: 4,
    },
    {
      role: "user",
      content: [{ type: "text", text: "NO_REPLY" }],
      timestamp: 5,
    },
    ...(includeMixedAssistant
      ? [
          {
            role: "assistant",
            content: [
              { type: "text", text: "NO_REPLY" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
            ],
            timestamp: 6,
          },
        ]
      : []),
  ];

  const loadChatHistoryWithMessages = async (
    messages: Array<Record<string, unknown>>,
  ): Promise<unknown[]> => {
    return withMainSessionStore(async (dir) => {
      const lines = messages.map((message) => JSON.stringify({ message }));
      await fs.writeFile(path.join(dir, "sess-main.jsonl"), lines.join("\n"), "utf-8");

      const res = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(res.ok).toBe(true);
      return res.payload?.messages ?? [];
    });
  };

  const withMainSessionStore = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    try {
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });
      return await run(dir);
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
  };

  const collectHistoryTextValues = (historyMessages: unknown[]) =>
    historyMessages
      .map((message) => {
        if (message && typeof message === "object") {
          const entry = message as { text?: unknown };
          if (typeof entry.text === "string") {
            return entry.text;
          }
        }
        return extractFirstTextBlock(message);
      })
      .filter((value): value is string => typeof value === "string");

  const expectAgentWaitTimeout = (res: Awaited<ReturnType<typeof rpcReq>>) => {
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("timeout");
  };

  const expectAgentWaitStartedAt = (res: Awaited<ReturnType<typeof rpcReq>>, startedAt: number) => {
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("ok");
    expect(res.payload?.startedAt).toBe(startedAt);
  };

  const sendChatAndExpectStarted = async (runId: string, message = "/context list") => {
    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message,
      idempotencyKey: runId,
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("started");
    return res;
  };

  const waitForAgentRunOk = async (runId: string, timeoutMs = 1_000) => {
    const res = await rpcReq(ws, "agent.wait", {
      runId,
      timeoutMs,
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.status).toBe("ok");
    return res;
  };

  const abortChatRun = async (runId: string) => {
    const res = await rpcReq(ws, "chat.abort", {
      sessionKey: "main",
      runId,
    });
    expect(res.ok).toBe(true);
    return res;
  };

  const mockBlockedChatReply = () => {
    let releaseBlockedReply: (() => void) | undefined;
    const blockedReply = new Promise<void>((resolve) => {
      releaseBlockedReply = resolve;
    });
    const replySpy = vi.mocked(getReplyFromConfig);
    replySpy.mockImplementationOnce(async (_ctx, opts) => {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        };
        void blockedReply.then(finish);
        if (opts?.abortSignal?.aborted) {
          finish();
          return;
        }
        opts?.abortSignal?.addEventListener("abort", finish, { once: true });
      });
      return undefined;
    });
    return () => {
      releaseBlockedReply?.();
    };
  };

  test("sessions.send forwards dashboard messages into existing sessions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-send-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    try {
      await writeSessionStore({
        entries: {
          "agent:main:dashboard:test-send": {
            sessionId: "sess-dashboard-send",
            updatedAt: Date.now(),
          },
        },
      });

      const spy = vi.mocked(getReplyFromConfig);
      const callsBefore = spy.mock.calls.length;
      const res = await rpcReq(ws, "sessions.send", {
        key: "agent:main:dashboard:test-send",
        message: "hello from dashboard",
        idempotencyKey: "idem-sessions-send-1",
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.runId).toBe("idem-sessions-send-1");
      expect(res.payload?.messageSeq).toBe(1);

      await waitFor(() => spy.mock.calls.length > callsBefore, 1_000);
      const ctx = spy.mock.calls.at(-1)?.[0] as { Body?: string; SessionKey?: string } | undefined;
      expect(ctx?.Body).toContain("hello from dashboard");
      expect(ctx?.SessionKey).toBe("agent:main:dashboard:test-send");
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("sessions.steer forwards dashboard messages into existing sessions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-steer-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    try {
      await writeSessionStore({
        entries: {
          "agent:main:dashboard:test-steer": {
            sessionId: "sess-dashboard-steer",
            updatedAt: Date.now(),
          },
        },
      });

      const spy = vi.mocked(getReplyFromConfig);
      const callsBefore = spy.mock.calls.length;
      const res = await rpcReq(ws, "sessions.steer", {
        key: "agent:main:dashboard:test-steer",
        message: "follow-up from dashboard",
        idempotencyKey: "idem-sessions-steer-1",
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.runId).toBe("idem-sessions-steer-1");
      expect(res.payload?.messageSeq).toBe(1);

      await waitFor(() => spy.mock.calls.length > callsBefore, 1_000);
      const ctx = spy.mock.calls.at(-1)?.[0] as { Body?: string; SessionKey?: string } | undefined;
      expect(ctx?.Body).toContain("follow-up from dashboard");
      expect(ctx?.SessionKey).toBe("agent:main:dashboard:test-steer");
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("sessions.abort stops active dashboard runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-abort-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    try {
      await writeSessionStore({
        entries: {
          "agent:main:dashboard:test-abort": {
            sessionId: "sess-dashboard-abort",
            updatedAt: Date.now(),
          },
        },
      });

      let aborted = false;
      const spy = vi.mocked(getReplyFromConfig);
      spy.mockImplementationOnce(async (_ctx, opts) => {
        const signal = opts?.abortSignal;
        await new Promise<void>((resolve) => {
          if (!signal) {
            resolve();
            return;
          }
          if (signal.aborted) {
            aborted = true;
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

      const sendRes = await rpcReq(ws, "sessions.send", {
        key: "agent:main:dashboard:test-abort",
        message: "hello",
        idempotencyKey: "idem-sessions-abort-1",
        timeoutMs: 30_000,
      });
      expect(sendRes.ok).toBe(true);

      await waitFor(() => spy.mock.calls.length > 0, 1_000);

      const abortRes = await rpcReq(ws, "sessions.abort", {
        key: "agent:main:dashboard:test-abort",
        runId: "idem-sessions-abort-1",
      });
      expect(abortRes.ok).toBe(true);
      expect(abortRes.payload?.abortedRunId).toBe("idem-sessions-abort-1");
      expect(abortRes.payload?.status).toBe("aborted");
      await waitFor(() => aborted, 1_000);

      const idleAbortRes = await rpcReq(ws, "sessions.abort", {
        key: "agent:main:dashboard:test-abort",
        runId: "idem-sessions-abort-1",
      });
      expect(idleAbortRes.ok).toBe(true);
      expect(idleAbortRes.payload?.abortedRunId).toBeNull();
      expect(idleAbortRes.payload?.status).toBe("no-active-run");
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("sanitizes inbound chat.send message text and rejects null bytes", async () => {
    const nullByteRes = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "hello\u0000world",
      idempotencyKey: "idem-null-byte-1",
    });
    expect(nullByteRes.ok).toBe(false);
    expect((nullByteRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
      /null bytes/i,
    );

    const spy = vi.mocked(getReplyFromConfig);
    spy.mockClear();
    const spyCalls = spy.mock.calls as unknown[][];
    const callsBeforeSanitized = spyCalls.length;
    const sanitizedRes = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "Cafe\u0301\u0007\tline",
      idempotencyKey: "idem-sanitized-1",
    });
    expect(sanitizedRes.ok).toBe(true);

    await waitFor(() => spyCalls.length > callsBeforeSanitized);
    const ctx = spyCalls.at(-1)?.[0] as
      | { Body?: string; RawBody?: string; BodyForCommands?: string }
      | undefined;
    expect(ctx?.Body).toBe("Café\tline");
    expect(ctx?.RawBody).toBe("Café\tline");
    expect(ctx?.BodyForCommands).toBe("Café\tline");
  });

  test("handles chat send and history flows", async () => {
    const tempDirs: string[] = [];
    let webchatWs: WebSocket | undefined;

    try {
      webchatWs = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      trackConnectChallengeNonce(webchatWs);
      await new Promise<void>((resolve) => webchatWs?.once("open", resolve));
      await connectOk(webchatWs, {
        client: {
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          version: "dev",
          platform: "web",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
      });

      const webchatRes = await rpcReq(webchatWs, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-webchat-1",
      });
      expect(webchatRes.ok).toBe(true);

      webchatWs.close();
      webchatWs = undefined;

      const spy = vi.mocked(getReplyFromConfig);
      spy.mockClear();
      const spyCalls = spy.mock.calls as unknown[][];
      testState.agentConfig = { timeoutSeconds: 123 };
      const callsBeforeTimeout = spyCalls.length;
      const timeoutRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-timeout-1",
      });
      expect(timeoutRes.ok).toBe(true);

      await waitFor(() => spyCalls.length > callsBeforeTimeout);
      const timeoutCall = spyCalls.at(-1)?.[1] as { runId?: string } | undefined;
      expect(timeoutCall?.runId).toBe("idem-timeout-1");
      testState.agentConfig = undefined;

      const sessionRes = await rpcReq(ws, "chat.send", {
        sessionKey: "agent:main:subagent:abc",
        message: "hello",
        idempotencyKey: "idem-session-key-1",
      });
      expect(sessionRes.ok).toBe(true);
      expect(sessionRes.payload?.runId).toBe("idem-session-key-1");

      const sendPolicyDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(sendPolicyDir);
      testState.sessionStorePath = path.join(sendPolicyDir, "sessions.json");
      testState.sessionConfig = {
        sendPolicy: {
          default: "allow",
          rules: [
            {
              action: "deny",
              match: { channel: "discord", chatType: "group" },
            },
          ],
        },
      };

      await writeSessionStore({
        entries: {
          "discord:group:dev": {
            sessionId: "sess-discord",
            updatedAt: Date.now(),
            chatType: "group",
            channel: "discord",
          },
        },
      });

      const blockedRes = await rpcReq(ws, "chat.send", {
        sessionKey: "discord:group:dev",
        message: "hello",
        idempotencyKey: "idem-1",
      });
      expect(blockedRes.ok).toBe(false);
      expect((blockedRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /send blocked/i,
      );

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

      const agentBlockedDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(agentBlockedDir);
      testState.sessionStorePath = path.join(agentBlockedDir, "sessions.json");
      testState.sessionConfig = {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { keyPrefix: "cron:" } }],
        },
      };

      await writeSessionStore({
        entries: {
          "cron:job-1": {
            sessionId: "sess-cron",
            updatedAt: Date.now(),
          },
        },
      });

      const agentBlockedRes = await rpcReq(ws, "agent", {
        sessionKey: "cron:job-1",
        message: "hi",
        idempotencyKey: "idem-2",
      });
      expect(agentBlockedRes.ok).toBe(false);
      expect((agentBlockedRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /send blocked/i,
      );

      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;

      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

      const reqId = "chat-img";
      ws.send(
        JSON.stringify({
          type: "req",
          id: reqId,
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "see image",
            idempotencyKey: "idem-img",
            attachments: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: pngB64,
                },
              },
            ],
          },
        }),
      );

      const imgRes = await onceMessage(
        ws,
        (o) => o.type === "res" && o.id === reqId,
        CHAT_RESPONSE_TIMEOUT_MS,
      );
      expect(imgRes.ok).toBe(true);
      expect(imgRes.payload?.runId).toBeDefined();
      const reqIdOnly = "chat-img-only";
      ws.send(
        JSON.stringify({
          type: "req",
          id: reqIdOnly,
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "",
            idempotencyKey: "idem-img-only",
            attachments: [
              {
                type: "image",
                mimeType: "image/png",
                fileName: "dot.png",
                content: `data:image/png;base64,${pngB64}`,
              },
            ],
          },
        }),
      );

      const imgOnlyRes = await onceMessage(
        ws,
        (o) => o.type === "res" && o.id === reqIdOnly,
        CHAT_RESPONSE_TIMEOUT_MS,
      );
      expect(imgOnlyRes.ok).toBe(true);
      expect(imgOnlyRes.payload?.runId).toBeDefined();

      const historyDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(historyDir);
      testState.sessionStorePath = path.join(historyDir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const lines: string[] = [];
      for (let i = 0; i < 300; i += 1) {
        lines.push(
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "text", text: `m${i}` }],
              timestamp: Date.now() + i,
            },
          }),
        );
      }
      await fs.writeFile(path.join(historyDir, "sess-main.jsonl"), lines.join("\n"), "utf-8");

      const defaultRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(defaultRes.ok).toBe(true);
      const defaultMsgs = defaultRes.payload?.messages ?? [];
      expect(defaultMsgs.length).toBe(200);
      expect(extractFirstTextBlock(defaultMsgs[0])).toBe("m100");
    } finally {
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;
      if (webchatWs) {
        webchatWs.close();
      }
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
  });

  test("chat.history hides assistant NO_REPLY-only entries", async () => {
    const historyMessages = await loadChatHistoryWithMessages(buildNoReplyHistoryFixture());
    const textValues = collectHistoryTextValues(historyMessages);
    // The NO_REPLY assistant message (content block) should be dropped.
    // The assistant with text="real text field reply" + content="NO_REPLY" stays
    // because entry.text takes precedence over entry.content for the silent check.
    // The user message with NO_REPLY text is preserved (only assistant filtered).
    expect(textValues).toEqual(["hello", "real reply", "real text field reply", "NO_REPLY"]);
  });

  test("routes chat.send slash commands without agent runs", async () => {
    await withMainSessionStore(async () => {
      const spy = vi.mocked(agentCommand);
      const callsBefore = spy.mock.calls.length;
      const eventPromise = onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat" &&
          o.payload?.state === "final" &&
          o.payload?.runId === "idem-command-1",
        8000,
      );
      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "/context list",
        idempotencyKey: "idem-command-1",
      });
      expect(res.ok).toBe(true);
      await eventPromise;
      expect(spy.mock.calls.length).toBe(callsBefore);
    });
  });

  test("routes /btw replies through side-result events without transcript injection", async () => {
    await withMainSessionStore(async () => {
      const replyMock = vi.mocked(getReplyFromConfig);
      replyMock.mockResolvedValueOnce({
        text: "323",
        btw: { question: "what is 17 * 19?" },
      });
      const sideResultPromise = onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat.side_result" &&
          o.payload?.kind === "btw" &&
          o.payload?.runId === "idem-btw-1",
        8000,
      );
      const finalPromise = onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat" &&
          o.payload?.state === "final" &&
          o.payload?.runId === "idem-btw-1",
        8000,
      );

      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "/btw what is 17 * 19?",
        idempotencyKey: "idem-btw-1",
      });

      expect(res.ok).toBe(true);
      const sideResult = await sideResultPromise;
      const finalEvent = await finalPromise;
      expect(sideResult.payload).toMatchObject({
        kind: "btw",
        runId: "idem-btw-1",
        sessionKey: "main",
        question: "what is 17 * 19?",
        text: "323",
      });
      expect(finalEvent.payload).toMatchObject({
        runId: "idem-btw-1",
        sessionKey: "main",
        state: "final",
      });

      const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
      });
      expect(historyRes.ok).toBe(true);
      expect(historyRes.payload?.messages ?? []).toEqual([]);
    });
  });

  test("routes block-streamed /btw replies through side-result events", async () => {
    await withMainSessionStore(async () => {
      const replyMock = vi.mocked(getReplyFromConfig);
      replyMock.mockImplementationOnce(async (_ctx, opts) => {
        await opts?.onBlockReply?.({
          text: "first chunk",
          btw: { question: "what changed?" },
        });
        await opts?.onBlockReply?.({
          text: "second chunk",
          btw: { question: "what changed?" },
        });
        return undefined;
      });
      const sideResultPromise = onceMessage(
        ws,
        (o) =>
          o.type === "event" &&
          o.event === "chat.side_result" &&
          o.payload?.kind === "btw" &&
          o.payload?.runId === "idem-btw-block-1",
        8000,
      );

      const res = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "/btw what changed?",
        idempotencyKey: "idem-btw-block-1",
      });

      expect(res.ok).toBe(true);
      const sideResult = await sideResultPromise;
      expect(sideResult.payload).toMatchObject({
        kind: "btw",
        runId: "idem-btw-block-1",
        question: "what changed?",
        text: "first chunk\n\nsecond chunk",
      });
    });
  });

  test("chat.history hides assistant NO_REPLY-only entries and keeps mixed-content assistant entries", async () => {
    const historyMessages = await loadChatHistoryWithMessages(buildNoReplyHistoryFixture(true));
    const roleAndText = historyMessages
      .map((message) => {
        const role =
          message &&
          typeof message === "object" &&
          typeof (message as { role?: unknown }).role === "string"
            ? (message as { role: string }).role
            : "unknown";
        const text =
          message &&
          typeof message === "object" &&
          typeof (message as { text?: unknown }).text === "string"
            ? (message as { text: string }).text
            : (extractFirstTextBlock(message) ?? "");
        return `${role}:${text}`;
      })
      .filter((entry) => entry !== "unknown:");

    expect(roleAndText).toEqual([
      "user:hello",
      "assistant:real reply",
      "assistant:real text field reply",
      "user:NO_REPLY",
      "assistant:NO_REPLY",
    ]);
  });

  test("agent.wait resolves chat.send runs that finish without lifecycle events", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-wait-chat-1";
      await sendChatAndExpectStarted(runId);
      await waitForAgentRunOk(runId);
    });
  });

  test("agent.wait ignores stale chat dedupe when an agent run with the same runId is in flight", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    let resolveAgentRun: (() => void) | undefined;
    const blockedAgentRun = new Promise<void>((resolve) => {
      resolveAgentRun = resolve;
    });
    const agentSpy = vi.mocked(agentCommand);
    agentSpy.mockImplementationOnce(async () => {
      await blockedAgentRun;
      return undefined;
    });

    try {
      testState.sessionStorePath = path.join(dir, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const runId = "idem-wait-chat-vs-agent";
      await sendChatAndExpectStarted(runId);
      await waitForAgentRunOk(runId);

      const agentRes = await rpcReq(ws, "agent", {
        sessionKey: "main",
        message: "hold this run open",
        idempotencyKey: runId,
      });
      expect(agentRes.ok).toBe(true);
      expect(agentRes.payload?.status).toBe("accepted");

      const waitWhileAgentInFlight = await rpcReq(ws, "agent.wait", {
        runId,
        timeoutMs: 40,
      });
      expectAgentWaitTimeout(waitWhileAgentInFlight);

      resolveAgentRun?.();
      await waitForAgentRunOk(runId);
    } finally {
      resolveAgentRun?.();
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("agent.wait ignores stale agent snapshots while same-runId chat.send is active", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-wait-chat-active-vs-stale-agent";
      const seedAgentRes = await rpcReq(ws, "agent", {
        sessionKey: "main",
        message: "seed stale agent snapshot",
        idempotencyKey: runId,
      });
      expect(seedAgentRes.ok).toBe(true);
      expect(seedAgentRes.payload?.status).toBe("accepted");

      const seedWaitRes = await rpcReq(ws, "agent.wait", {
        runId,
        timeoutMs: 1_000,
      });
      expect(seedWaitRes.ok).toBe(true);
      expect(seedWaitRes.payload?.status).toBe("ok");

      const releaseBlockedReply = mockBlockedChatReply();

      try {
        await sendChatAndExpectStarted(runId, "hold chat run open");

        const waitWhileChatActive = await rpcReq(ws, "agent.wait", {
          runId,
          timeoutMs: 40,
        });
        expectAgentWaitTimeout(waitWhileChatActive);

        await abortChatRun(runId);
      } finally {
        releaseBlockedReply();
      }
    });
  });

  test("agent.wait keeps lifecycle wait active while same-runId chat.send is active", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-wait-chat-active-with-agent-lifecycle";
      const releaseBlockedReply = mockBlockedChatReply();

      try {
        await sendChatAndExpectStarted(runId, "hold chat run open");

        const waitP = rpcReq(ws, "agent.wait", {
          runId,
          timeoutMs: 1_000,
        });

        vi.useFakeTimers();
        try {
          const settle = new Promise((resolve) => setTimeout(resolve, 20));
          await vi.advanceTimersByTimeAsync(20);
          await settle;
        } finally {
          vi.useRealTimers();
        }
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "start", startedAt: 1 },
        });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end", startedAt: 1, endedAt: 2 },
        });

        const waitRes = await waitP;
        expect(waitRes.ok).toBe(true);
        expect(waitRes.payload?.status).toBe("ok");

        await abortChatRun(runId);
      } finally {
        releaseBlockedReply();
      }
    });
  });

  test("agent events include sessionKey and agent.wait covers lifecycle flows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          verboseLevel: "off",
        },
      },
    });

    const webchatWs = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    trackConnectChallengeNonce(webchatWs);
    await new Promise<void>((resolve) => webchatWs.once("open", resolve));
    await connectOk(webchatWs, {
      client: {
        id: GATEWAY_CLIENT_NAMES.WEBCHAT,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });

    try {
      registerAgentRunContext("run-tool-1", {
        sessionKey: "main",
        verboseLevel: "on",
      });

      {
        const agentEvtP = onceMessage(
          webchatWs,
          (o) => o.type === "event" && o.event === "agent" && o.payload?.runId === "run-tool-1",
          8000,
        );

        emitAgentEvent({
          runId: "run-tool-1",
          stream: "assistant",
          data: { text: "hello" },
        });

        const evt = await agentEvtP;
        const payload = evt.payload && typeof evt.payload === "object" ? evt.payload : {};
        expect(payload.sessionKey).toBe("main");
        expect(payload.stream).toBe("assistant");
      }

      {
        const waitP = rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-1",
          timeoutMs: 200,
        });

        queueMicrotask(() => {
          emitAgentEvent({
            runId: "run-wait-1",
            stream: "lifecycle",
            data: { phase: "end", startedAt: 200, endedAt: 210 },
          });
        });

        const res = await waitP;
        expectAgentWaitStartedAt(res, 200);
      }

      {
        emitAgentEvent({
          runId: "run-wait-early",
          stream: "lifecycle",
          data: { phase: "end", startedAt: 50, endedAt: 55 },
        });

        const res = await rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-early",
          timeoutMs: 200,
        });
        expect(res.ok).toBe(true);
        expect(res.payload?.status).toBe("ok");
        expect(res.payload?.startedAt).toBe(50);
      }

      {
        const res = await rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-3",
          timeoutMs: 30,
        });
        expectAgentWaitTimeout(res);
      }

      {
        const waitP = rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-err",
          timeoutMs: 50,
        });

        queueMicrotask(() => {
          emitAgentEvent({
            runId: "run-wait-err",
            stream: "lifecycle",
            data: { phase: "error", error: "boom" },
          });
        });

        const res = await waitP;
        expectAgentWaitTimeout(res);
      }

      {
        const waitP = rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-start",
          timeoutMs: 200,
        });

        emitAgentEvent({
          runId: "run-wait-start",
          stream: "lifecycle",
          data: { phase: "start", startedAt: 123 },
        });

        queueMicrotask(() => {
          emitAgentEvent({
            runId: "run-wait-start",
            stream: "lifecycle",
            data: { phase: "end", endedAt: 456 },
          });
        });

        const res = await waitP;
        expectAgentWaitStartedAt(res, 123);
        expect(res.payload?.endedAt).toBe(456);
      }
    } finally {
      webchatWs.close();
      await fs.rm(dir, { recursive: true, force: true });
      testState.sessionStorePath = undefined;
    }
  });
});
