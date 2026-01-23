import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  agentCommand,
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks();

async function waitFor(condition: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for condition");
}

describe("gateway server chat", () => {
  test("handles chat send and history flows", async () => {
    const tempDirs: string[] = [];
    const { server, ws, port } = await startServerWithClient();
    let webchatWs: WebSocket | undefined;

    try {
      await connectOk(ws);

      webchatWs = new WebSocket(`ws://127.0.0.1:${port}`);
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

      const spy = vi.mocked(agentCommand);
      spy.mockClear();
      testState.agentConfig = { timeoutSeconds: 123 };
      const callsBeforeTimeout = spy.mock.calls.length;
      const timeoutRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-timeout-1",
      });
      expect(timeoutRes.ok).toBe(true);

      await waitFor(() => spy.mock.calls.length > callsBeforeTimeout);
      const timeoutCall = spy.mock.calls.at(-1)?.[0] as { timeout?: string } | undefined;
      expect(timeoutCall?.timeout).toBe("123");
      testState.agentConfig = undefined;

      spy.mockClear();
      const callsBeforeSession = spy.mock.calls.length;
      const sessionRes = await rpcReq(ws, "chat.send", {
        sessionKey: "agent:main:subagent:abc",
        message: "hello",
        idempotencyKey: "idem-session-key-1",
      });
      expect(sessionRes.ok).toBe(true);

      await waitFor(() => spy.mock.calls.length > callsBeforeSession);
      const sessionCall = spy.mock.calls.at(-1)?.[0] as { sessionKey?: string } | undefined;
      expect(sessionCall?.sessionKey).toBe("agent:main:subagent:abc");

      const sendPolicyDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
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

      const agentBlockedDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
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

      spy.mockClear();
      const callsBeforeImage = spy.mock.calls.length;
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

      const imgRes = await onceMessage(ws, (o) => o.type === "res" && o.id === reqId, 8000);
      expect(imgRes.ok).toBe(true);
      expect(imgRes.payload?.runId).toBeDefined();

      await waitFor(() => spy.mock.calls.length > callsBeforeImage, 8000);
      const imgCall = spy.mock.calls.at(-1)?.[0] as
        | { images?: Array<{ type: string; data: string; mimeType: string }> }
        | undefined;
      expect(imgCall?.images).toEqual([{ type: "image", data: pngB64, mimeType: "image/png" }]);

      const historyDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
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
        if (!msg || typeof msg !== "object") return undefined;
        const content = (msg as { content?: unknown }).content;
        if (!Array.isArray(content) || content.length === 0) return undefined;
        const first = content[0];
        if (!first || typeof first !== "object") return undefined;
        const text = (first as { text?: unknown }).text;
        return typeof text === "string" ? text : undefined;
      };
      expect(defaultMsgs.length).toBe(200);
      expect(firstContentText(defaultMsgs[0])).toBe("m100");
    } finally {
      testState.agentConfig = undefined;
      testState.sessionStorePath = undefined;
      testState.sessionConfig = undefined;
      if (webchatWs) webchatWs.close();
      ws.close();
      await server.close();
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
  });
});
