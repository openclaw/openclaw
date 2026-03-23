import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { __setMaxChatHistoryMessagesBytesForTest } from "./server-constants.js";
import {
  connectOk,
  getReplyFromConfig,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function waitFor(condition: () => boolean, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timeout waiting for condition");
}

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

describe("gateway server chat", () => {
  test("smoke: caps history payload and preserves routing metadata", async () => {
    const tempDirs: string[] = [];
    const { server, ws } = await startServerWithClient();
    try {
      const historyMaxBytes = 192 * 1024;
      __setMaxChatHistoryMessagesBytesForTest(historyMaxBytes);
      await connectOk(ws);

      const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(sessionDir);
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");

      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-main", updatedAt: Date.now() },
        },
      });

      const bigText = "x".repeat(4_000);
      const historyLines: string[] = [];
      for (let i = 0; i < 60; i += 1) {
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
      await fs.writeFile(
        path.join(sessionDir, "sess-main.jsonl"),
        historyLines.join("\n"),
        "utf-8",
      );

      const historyRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "main",
        limit: 1000,
      });
      expect(historyRes.ok).toBe(true);
      const messages = historyRes.payload?.messages ?? [];
      const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
      expect(bytes).toBeLessThanOrEqual(historyMaxBytes);
      expect(messages.length).toBeLessThan(60);

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

      const stored = JSON.parse(await fs.readFile(testState.sessionStorePath, "utf-8")) as Record<
        string,
        { lastChannel?: string; lastTo?: string } | undefined
      >;
      expect(stored["agent:main:main"]?.lastChannel).toBe("whatsapp");
      expect(stored["agent:main:main"]?.lastTo).toBe("+1555");
    } finally {
      __setMaxChatHistoryMessagesBytesForTest();
      testState.sessionStorePath = undefined;
      ws.close();
      await server.close();
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
  });

  test("smoke: supports abort and idempotent completion", async () => {
    const tempDirs: string[] = [];
    const { server, ws } = await startServerWithClient();
    const spy = vi.mocked(getReplyFromConfig);
    let aborted = false;

    try {
      await connectOk(ws);

      const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(sessionDir);
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");

      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-main", updatedAt: Date.now() },
        },
      });

      spy.mockReset();
      spy.mockImplementationOnce(async (_ctx, opts) => {
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
      });

      const sendResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-abort-1", 8_000);
      sendReq(ws, "send-abort-1", "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-abort-1",
        timeoutMs: 30_000,
      });

      const sendRes = await sendResP;
      expect(sendRes.ok).toBe(true);
      await waitFor(() => spy.mock.calls.length > 0, 2_000);

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
      await waitFor(() => aborted, 2_000);

      spy.mockReset();
      spy.mockResolvedValueOnce(undefined);

      const completeRes = await rpcReq<{ status?: string }>(ws, "chat.send", {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-complete-1",
      });
      expect(completeRes.ok).toBe(true);

      let completed = false;
      for (let i = 0; i < 20; i += 1) {
        const again = await rpcReq<{ status?: string }>(ws, "chat.send", {
          sessionKey: "main",
          message: "hello",
          idempotencyKey: "idem-complete-1",
        });
        if (again.ok && again.payload?.status === "ok") {
          completed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(completed).toBe(true);
    } finally {
      __setMaxChatHistoryMessagesBytesForTest();
      testState.sessionStorePath = undefined;
      ws.close();
      await server.close();
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
  });

  test("direct routing keeps the main session state intact", async () => {
    const tempDirs: string[] = [];
    const { server, ws } = await startServerWithClient();
    const spy = vi.mocked(getReplyFromConfig);

    try {
      await connectOk(ws);

      const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(sessionDir);
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");

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

      spy.mockReset();
      spy.mockResolvedValueOnce(undefined);

      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "@legal review this NDA",
        idempotencyKey: "idem-direct-routing",
      });
      expect(sendRes.ok).toBe(true);
      await waitFor(() => spy.mock.calls.length > 0, 2_000);

      const firstCall = spy.mock.calls[0];
      const ctx = firstCall?.[0] as { Body?: string; BodyForAgent?: string; SessionKey?: string };
      expect(ctx?.Body).toBe("review this NDA");
      expect(ctx?.BodyForAgent).toContain("[Direct routing request]");
      expect(ctx?.BodyForAgent).toContain("Target specialist: legal");
      expect(ctx?.SessionKey).toBe("agent:main:main");

      const stored = JSON.parse(await fs.readFile(testState.sessionStorePath, "utf-8")) as Record<
        string,
        { lastChannel?: string; lastTo?: string } | undefined
      >;
      expect(stored["agent:main:main"]?.lastChannel).toBe("whatsapp");
      expect(stored["agent:main:main"]?.lastTo).toBe("+1555");
    } finally {
      testState.sessionStorePath = undefined;
      ws.close();
      await server.close();
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
  });

  test("hard-limit preflight compacts once and preserves last user input", async () => {
    const tempDirs: string[] = [];
    const { server, ws } = await startServerWithClient();
    const spy = vi.mocked(getReplyFromConfig);

    try {
      await connectOk(ws);

      const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(sessionDir);
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");

      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-preflight",
            updatedAt: Date.now(),
            totalTokens: 180_000,
            totalTokensFresh: true,
            contextTokens: 200_000,
          },
        },
      });

      const transcriptPath = path.join(sessionDir, "sess-preflight.jsonl");
      await fs.writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "session",
            version: 1,
            id: "sess-preflight",
            timestamp: new Date().toISOString(),
            cwd: process.cwd(),
          }),
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "text", text: "old request" }],
              timestamp: Date.now() - 2000,
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              content: [{ type: "text", text: "old reply" }],
              timestamp: Date.now() - 1000,
            },
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      spy.mockClear();
      const sendRes = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "latest hard limit input",
        idempotencyKey: "idem-hard-limit-preflight",
      });
      expect(sendRes.ok).toBe(true);

      await waitFor(() => spy.mock.calls.length > 0, 2_000);
      const ctx = spy.mock.calls.at(-1)?.[0] as
        | { Body?: string; RawBody?: string; BodyForCommands?: string }
        | undefined;
      expect(ctx?.Body).toBe("latest hard limit input");
      expect(ctx?.RawBody).toBe("latest hard limit input");
      expect(ctx?.BodyForCommands).toBe("latest hard limit input");

      const transcript = await fs.readFile(transcriptPath, "utf-8");
      const summaryCount = transcript
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as { synthetic?: boolean; summary?: boolean };
          } catch {
            return null;
          }
        })
        .filter((line) => line?.synthetic === true && line?.summary === true).length;
      expect(summaryCount).toBe(1);
    } finally {
      testState.sessionStorePath = undefined;
      ws.close();
      await server.close();
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
  });

  test("archive active chat mid-run does not write a late assistant message into archived transcript", async () => {
    const tempDirs: string[] = [];
    const { server, ws } = await startServerWithClient();
    const spy = vi.mocked(getReplyFromConfig);

    try {
      await connectOk(ws);

      const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
      tempDirs.push(sessionDir);
      testState.sessionStorePath = path.join(sessionDir, "sessions.json");

      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-archive-mid-run", updatedAt: Date.now() },
        },
      });

      const transcriptPath = path.join(sessionDir, "sess-archive-mid-run.jsonl");
      await fs.writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "session", version: 1, id: "sess-archive-mid-run", timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`,
        "utf-8",
      );

      let released = false;
      spy.mockReset();
      spy.mockImplementationOnce(async (_ctx, opts) => {
        opts?.onAgentRunStart?.(opts.runId ?? "idem-archive-mid-run");
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        released = true;
      });

      const sendResP = onceMessage(
        ws,
        (o) => o.type === "res" && o.id === "send-archive-mid-run",
        8_000,
      );
      sendReq(ws, "send-archive-mid-run", "chat.send", {
        sessionKey: "main",
        message: "hello archive",
        idempotencyKey: "idem-archive-mid-run",
        timeoutMs: 30_000,
      });
      const sendRes = await sendResP;
      expect(sendRes.ok).toBe(true);
      await waitFor(() => spy.mock.calls.length > 0, 2_000);

      const archiveRes = await rpcReq<{ ok?: boolean }>(ws, "sessions.archive", {
        key: "main",
      });
      expect(archiveRes.ok).toBe(true);
      await waitFor(() => released, 2_000);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const transcript = await fs.readFile(transcriptPath, "utf-8");
      expect(transcript).not.toContain("hello archive");
      expect(transcript).not.toContain("gateway-injected");
    } finally {
      testState.sessionStorePath = undefined;
      ws.close();
      await server.close();
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
  });
});
