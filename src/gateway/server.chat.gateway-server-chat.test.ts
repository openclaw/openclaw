import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { emitAgentEvent, registerAgentRunContext } from "../infra/agent-events.js";
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

async function waitFor(condition: () => boolean, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("timeout waiting for condition");
}

describe("gateway server chat", () => {
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
                mimeType: "image/png",
                fileName: "dot.png",
                content: `data:image/png;base64,${pngB64}`,
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
      const firstContentText = (msg: unknown): string | undefined => {
        if (!msg || typeof msg !== "object") {
          return undefined;
        }
        const content = (msg as { content?: unknown }).content;
        if (!Array.isArray(content) || content.length === 0) {
          return undefined;
        }
        const first = content[0];
        if (!first || typeof first !== "object") {
          return undefined;
        }
        const text = (first as { text?: unknown }).text;
        return typeof text === "string" ? text : undefined;
      };
      expect(defaultMsgs.length).toBe(200);
      expect(firstContentText(defaultMsgs[0])).toBe("m100");
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

  test("routes chat.send slash commands without agent runs", async () => {
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
    } finally {
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
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
        expect(res.ok).toBe(true);
        expect(res.payload?.status).toBe("ok");
        expect(res.payload?.startedAt).toBe(200);
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
        expect(res.ok).toBe(true);
        expect(res.payload?.status).toBe("timeout");
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
        expect(res.ok).toBe(true);
        expect(res.payload?.status).toBe("timeout");
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
        expect(res.ok).toBe(true);
        expect(res.payload?.status).toBe("ok");
        expect(res.payload?.startedAt).toBe(123);
        expect(res.payload?.endedAt).toBe(456);
      }
    } finally {
      webchatWs.close();
      await fs.rm(dir, { recursive: true, force: true });
      testState.sessionStorePath = undefined;
    }
  });

  test("webchat final message includes pre-tool and post-tool text", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
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
          platform: "test",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
      });

      registerAgentRunContext("run-multi-msg", {
        sessionKey: "main",
        verboseLevel: "on",
      });

      const chatEvents: Array<{ state: string; text?: string }> = [];
      webchatWs.on("message", (raw) => {
        try {
          const data = raw instanceof Buffer ? raw : Buffer.from(raw as ArrayLike<number>);
          const msg = JSON.parse(data.toString("utf8"));
          if (msg.type === "event" && msg.event === "chat") {
            chatEvents.push({
              state: msg.payload?.state,
              text: msg.payload?.message?.content?.[0]?.text ?? msg.payload?.message?.text,
            });
          }
        } catch {
          // ignore
        }
      });

      // Simulate pre-tool text streaming
      emitAgentEvent({
        runId: "run-multi-msg",
        stream: "assistant",
        data: { text: "The file is being checked." },
      });

      // Simulate tool execution (no assistant event during tool)

      // Simulate post-tool text streaming (incremental chunks, new assistant message)
      emitAgentEvent({
        runId: "run-multi-msg",
        stream: "assistant",
        data: { text: "The file" }, // first chunk
      });
      emitAgentEvent({
        runId: "run-multi-msg",
        stream: "assistant",
        data: { text: "The file contains" }, // second chunk extends first
      });
      emitAgentEvent({
        runId: "run-multi-msg",
        stream: "assistant",
        data: { text: "The file contains 42 lines." }, // final chunk
      });

      // Simulate lifecycle end
      emitAgentEvent({
        runId: "run-multi-msg",
        stream: "lifecycle",
        data: { phase: "end", endedAt: Date.now() },
      });

      await new Promise((r) => setTimeout(r, 200));

      const finalEvent = chatEvents.find((e) => e.state === "final");
      expect(finalEvent).toBeDefined();
      expect(finalEvent?.text).toContain("The file is being checked.");
      expect(finalEvent?.text).toContain("The file contains 42 lines.");

      webchatWs.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      testState.sessionStorePath = undefined;
    }
  });
});
