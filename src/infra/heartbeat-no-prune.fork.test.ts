/**
 * Fork regression test: heartbeat transcript is NOT pruned.
 *
 * Verifies that runHeartbeatOnce does not truncate/prune the session
 * transcript after a HEARTBEAT_OK run. The transcript should retain
 * all heartbeat turns so they're visible in history and available
 * for compaction.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

vi.mock("jiti", () => ({ createJiti: () => ({}) }));

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
});

describe("FORK: heartbeat transcript must NOT be pruned", () => {
  async function runHeartbeatAndCheckTranscript(params: {
    replyText: string;
    label: string;
  }) {
    await withTempTelegramHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const sessionId = `test-no-prune-${params.label}`;
        const sessionKey = resolveMainSessionKey(undefined);
        const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);

        // Seed transcript with existing content
        const header = {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date().toISOString(),
          cwd: process.cwd(),
        };
        const existingContent = [
          JSON.stringify(header),
          JSON.stringify({ role: "user", content: "Hello" }),
          JSON.stringify({ role: "assistant", content: "Hi there" }),
        ].join("\n") + "\n";

        await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
        await fs.writeFile(transcriptPath, existingContent);
        const sizeBefore = (await fs.stat(transcriptPath)).size;

        await seedSessionStore(storePath, sessionKey, {
          sessionId,
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "user123",
        });

        replySpy.mockResolvedValueOnce({
          text: params.replyText,
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        });

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

        const sizeAfter = (await fs.stat(transcriptPath)).size;

        // Transcript must NEVER shrink — pruning is forbidden
        expect(sizeAfter).toBeGreaterThanOrEqual(sizeBefore);

        // Original content must still be present
        const finalContent = await fs.readFile(transcriptPath, "utf-8");
        expect(finalContent).toContain('"Hello"');
        expect(finalContent).toContain('"Hi there"');
      },
      { prefix: `openclaw-hb-noprune-${params.label}-` },
    );
  }

  it("HEARTBEAT_OK does not prune transcript", async () => {
    await runHeartbeatAndCheckTranscript({
      replyText: "HEARTBEAT_OK",
      label: "ok",
    });
  });

  it("NO_REPLY does not prune transcript", async () => {
    await runHeartbeatAndCheckTranscript({
      replyText: "NO_REPLY",
      label: "noreply",
    });
  });

  it("actionable heartbeat does not prune transcript", async () => {
    await runHeartbeatAndCheckTranscript({
      replyText: "Alert: PR review needed on #28724",
      label: "actionable",
    });
  });

  it("source code does not contain pruneHeartbeatTranscript calls", async () => {
    const source = await fs.readFile(
      path.resolve(__dirname, "heartbeat-runner.ts"),
      "utf-8",
    );
    // The function definition should be gone
    expect(source).not.toMatch(/async function pruneHeartbeatTranscript/);
    // No calls to it
    expect(source).not.toMatch(/await pruneHeartbeatTranscript/);
    // No captureTranscriptState calls
    expect(source).not.toMatch(/await captureTranscriptState/);
  });
});
