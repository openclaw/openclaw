import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

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

  async function withTempTelegramHeartbeatSandbox<T>(
    fn: (ctx: {
      tmpDir: string;
      storePath: string;
      replySpy: ReturnType<typeof vi.spyOn>;
    }) => Promise<T>,
  ) {
    return withTempHeartbeatSandbox(fn, {
      prefix: "openclaw-hb-prune-",
      unsetEnvVars: ["TELEGRAM_BOT_TOKEN"],
    });
  }

  it("prunes transcript when heartbeat returns HEARTBEAT_OK", async () => {
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const sessionKey = resolveMainSessionKey(undefined);
      const sessionId = "test-session-prune";
      const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

      // Create a transcript with some existing content
      const originalContent = await createTranscriptWithContent(transcriptPath, sessionId);
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
      const cfg = {
        version: 1,
        model: "test-model",
        agent: { workspace: tmpDir },
        sessionStore: storePath,
        channels: { telegram: {} },
      } as unknown as OpenClawConfig;

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
    await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
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
      const cfg = {
        version: 1,
        model: "test-model",
        agent: { workspace: tmpDir },
        sessionStore: storePath,
        channels: { telegram: {} },
      } as unknown as OpenClawConfig;

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
