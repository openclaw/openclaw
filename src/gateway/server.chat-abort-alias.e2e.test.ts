import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  connectOk,
  getReplyFromConfig,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  sessionStoreSaveDelayMs,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway chat.abort alias (#5239)", () => {
  test("abort method works as alias for chat.abort", async () => {
    const tempDirs: string[] = [];
    const { server, ws } = await startServerWithClient();
    const spy = vi.mocked(getReplyFromConfig);
    spy.mockReset();

    try {
      await connectOk(ws);

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gws-abort-alias-"));
      tempDirs.push(tmpDir);
      const storeFile = path.join(tmpDir, "sessions.json");
      testState.sessionStorePath = storeFile;
      sessionStoreSaveDelayMs.value = 10;
      const writeStore = async (
        entries: Record<string, { sessionId: string; updatedAt: number }>,
      ) => {
        await writeSessionStore({ entries });
      };

      await writeStore({ main: { sessionId: "sess-abort-alias", updatedAt: Date.now() } });

      let agentStartedResolve: (() => void) | undefined;
      const agentStartedP = new Promise<void>((resolve) => {
        agentStartedResolve = resolve;
      });

      spy.mockImplementationOnce(async (_ctx: unknown, opts?: { abortSignal?: AbortSignal }) => {
        agentStartedResolve?.();
        const signal = opts?.abortSignal;
        await new Promise<void>((resolve) => {
          if (!signal) {
            return resolve();
          }
          if (signal.aborted) {
            return resolve();
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      });

      // Start a run
      type WsMessage = { type: string; id?: string; ok?: boolean };
      const sendResP = onceMessage(
        ws,
        (o: unknown) => {
          const msg = o as WsMessage;
          return msg.type === "res" && msg.id === "send-alias-1";
        },
        10_000,
      );
      ws.send(
        JSON.stringify({
          type: "req",
          id: "send-alias-1",
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "hello",
            idempotencyKey: "idem-abort-alias-1",
            timeoutMs: 30_000,
          },
        }),
      );
      await agentStartedP;

      // Use the legacy "abort" method instead of "chat.abort"
      const abortRes = await rpcReq<{
        ok?: boolean;
        aborted?: boolean;
        runIds?: string[];
      }>(ws, "abort", { sessionKey: "main" });

      expect(abortRes.ok).toBe(true);
      expect(abortRes.payload?.aborted).toBe(true);
      expect(abortRes.payload?.runIds ?? []).toContain("idem-abort-alias-1");

      // Wait for the send to complete
      const sendRes = (await sendResP) as WsMessage;
      expect(sendRes.ok).toBe(true);
    } finally {
      testState.sessionStorePath = undefined;
      sessionStoreSaveDelayMs.value = 0;
      ws.close();
      await server.close();
      await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    }
  });
});
