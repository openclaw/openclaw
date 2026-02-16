import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import * as replyModule from "../auto-reply/reply.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
  );
});

describe("heartbeat transcript pruning", () => {
  async function seedSessionStore(
    storePath: string,
    sessionKey: string,
    session: {
      sessionId?: string;
      updatedAt?: number;
      lastChannel: string;
      lastProvider: string;
      lastTo: string;
    },
  ) {
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: session.sessionId ?? "sid",
            updatedAt: session.updatedAt ?? Date.now(),
            ...session,
          },
        },
        null,
        2,
      ),
    );
  }

  async function createTranscriptWithContent(transcriptPath: string, sessionId: string) {
    const header = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const existingContent = `${JSON.stringify(header)}\n{"role":"user","content":"Hello"}\n{"role":"assistant","content":"Hi there"}\n`;
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, existingContent);
    return existingContent;
  }

  async function withTempHeartbeatSandbox<T>(
    fn: (ctx: {
      tmpDir: string;
      storePath: string;
      replySpy: ReturnType<typeof vi.spyOn>;
    }) => Promise<T>,
  ) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-prune-"));
    const storePath = path.join(tmpDir, "sessions.json");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "";
    try {
      return await fn({ tmpDir, storePath, replySpy });
    } finally {
      replySpy.mockRestore();
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  it("prunes transcript when heartbeat returns HEARTBEAT_OK", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sessionKey = resolveMainSessionKey(undefined);
      const sessionId = "test-session-prune";
      const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

      // Create a transcript with some existing content
      await createTranscriptWithContent(transcriptPath, sessionId);
      const originalSize = (await fs.stat(transcriptPath)).size;

      // Seed session store
      await seedSessionStore(storePath, sessionKey, {
        sessionId,
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "user123",
      });

      // Mock reply to return HEARTBEAT_OK (which triggers pruning)
      replySpy.mockResolvedValueOnce({
        text: "HEARTBEAT_OK",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });

      // Run heartbeat
      const cfg: OpenClawConfig = {
        version: 1,
        model: "test-model",
        agent: { workspace: tmpDir },
        sessionStore: storePath,
        channels: { telegram: { showOk: true, showAlerts: true } },
      };

      await runHeartbeatOnce({
        agentId: undefined,
        reason: "test",
        cfg,
        deps: { sendTelegram: vi.fn() },
      });

      // Verify transcript was truncated back to original size
      const finalContent = await fs.readFile(transcriptPath, "utf-8");
      expect(finalContent).toBe(originalContent);
      const finalSize = (await fs.stat(transcriptPath)).size;
      expect(finalSize).toBe(originalSize);
    });
  });

  it("does not prune transcript when heartbeat returns meaningful content", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sessionKey = resolveMainSessionKey(undefined);
      const sessionId = "test-session-no-prune";
      const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

      // Create a transcript with some existing content
      await createTranscriptWithContent(transcriptPath, sessionId);
      const originalSize = (await fs.stat(transcriptPath)).size;

      // Seed session store
      await seedSessionStore(storePath, sessionKey, {
        sessionId,
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "user123",
      });

      // Mock reply to return meaningful content (should NOT trigger pruning)
      replySpy.mockResolvedValueOnce({
        text: "Alert: Something needs your attention!",
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });

      // Run heartbeat
      const cfg: OpenClawConfig = {
        version: 1,
        model: "test-model",
        agent: { workspace: tmpDir },
        sessionStore: storePath,
        channels: { telegram: { showOk: true, showAlerts: true } },
      };

      await runHeartbeatOnce({
        agentId: undefined,
        reason: "test",
        cfg,
        deps: { sendTelegram: vi.fn() },
      });

      // Verify transcript was NOT truncated (it may have grown with new entries)
      const finalSize = (await fs.stat(transcriptPath)).size;
      expect(finalSize).toBeGreaterThanOrEqual(originalSize);
    });
  });
});
