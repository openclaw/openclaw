import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as replyModule from "../auto-reply/reply.js";
import {
  DEFAULT_IDLE_TRIGGER_DELAY_MINUTES,
  DEFAULT_IDLE_TRIGGER_FILENAME,
  IDLE_TRIGGER_PROMPT,
  runIdleTriggerOnce,
  startIdleTriggerRunner,
} from "./idle-trigger-runner.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

describe("idle-trigger-runner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("runIdleTriggerOnce", () => {
    it("skips when no triggers configured (legacy disabled)", async () => {
      const result = await runIdleTriggerOnce({
        cfg: { session: {} } as OpenClawConfig,
      });

      expect(result).toEqual({ status: "skipped", reason: "disabled" });
    });

    it("skips when onIdle array is empty", async () => {
      const result = await runIdleTriggerOnce({
        cfg: {
          session: { onIdle: [] },
        } as OpenClawConfig,
      });

      expect(result).toEqual({ status: "skipped", reason: "disabled" });
    });

    it("skips when no sessions exist", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-idle-"));
      const storePath = path.join(tmpDir, "sessions.json");

      try {
        // Create IDLE.md to pass that check
        await fs.writeFile(
          path.join(tmpDir, DEFAULT_IDLE_TRIGGER_FILENAME),
          "# Idle Tasks\n- Save memories",
        );

        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
            },
          },
          session: {
            store: storePath,
            onIdle: [{ name: "test-trigger", after: "1m" }],
          },
        };

        const result = await runIdleTriggerOnce({
          cfg,
          deps: {
            getQueueSize: () => 0,
            nowMs: () => Date.now(),
          },
        });

        expect(result).toEqual({ status: "skipped", reason: "no-sessions" });
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("processes multiple triggers from onIdle array", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-idle-"));
      const storePath = path.join(tmpDir, "sessions.json");
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");

      try {
        await fs.writeFile(
          path.join(tmpDir, DEFAULT_IDLE_TRIGGER_FILENAME),
          "# Idle Tasks\n- Save memories",
        );

        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
            },
          },
          session: {
            store: storePath,
            onIdle: [
              { name: "quick-check", after: "1m" },
              { name: "deep-check", after: "30m" },
            ],
          },
        };

        const now = Date.now();
        const lastActivity = now - 5 * 60 * 1000; // 5 minutes ago (only quick-check should fire)

        await fs.writeFile(
          storePath,
          JSON.stringify(
            {
              "main:main": {
                sessionId: "sid",
                updatedAt: lastActivity,
                origin: {
                  provider: "telegram",
                  from: "123456789",
                },
              },
            },
            null,
            2,
          ),
        );

        replySpy.mockResolvedValue({ text: "IDLE_OK" });

        const result = await runIdleTriggerOnce({
          cfg,
          deps: {
            getQueueSize: () => 0,
            nowMs: () => now,
          },
        });

        expect(result.status).toBe("ran");
        // Only the quick-check should have triggered (5 min > 1 min threshold)
        // deep-check needs 30 min idle time
      } finally {
        replySpy.mockRestore();
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("skips session without deliverable origin", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-idle-"));
      const storePath = path.join(tmpDir, "sessions.json");

      try {
        await fs.writeFile(
          path.join(tmpDir, DEFAULT_IDLE_TRIGGER_FILENAME),
          "# Idle Tasks\n- Save memories",
        );

        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
            },
          },
          session: {
            store: storePath,
            onIdle: [{ name: "test", after: "1m" }],
          },
        };

        const now = Date.now();
        const lastActivity = now - 5 * 60 * 1000;

        // Session with webchat origin (not deliverable)
        await fs.writeFile(
          storePath,
          JSON.stringify(
            {
              "main:main": {
                sessionId: "sid",
                updatedAt: lastActivity,
                origin: {
                  provider: "webchat",
                  from: "user123",
                },
              },
            },
            null,
            2,
          ),
        );

        const result = await runIdleTriggerOnce({
          cfg,
          deps: {
            getQueueSize: () => 0,
            nowMs: () => now,
          },
        });

        // Should run but process 0 triggers because webchat is not deliverable
        expect(result.status).toBe("ran");
        if (result.status === "ran") {
          expect(result.triggersProcessed).toBe(0);
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("processes custom prompt triggers", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-idle-"));
      const storePath = path.join(tmpDir, "sessions.json");
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");

      try {
        // No IDLE.md file needed for prompt-based triggers
        const customPrompt = "Check in with the user warmly.";

        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
            },
          },
          session: {
            store: storePath,
            onIdle: [{ name: "re-engage", after: "1m", prompt: customPrompt }],
          },
        };

        const now = Date.now();
        const lastActivity = now - 5 * 60 * 1000;

        await fs.writeFile(
          storePath,
          JSON.stringify(
            {
              "main:main": {
                sessionId: "sid",
                updatedAt: lastActivity,
                origin: {
                  provider: "whatsapp",
                  from: "+15551234567",
                },
              },
            },
            null,
            2,
          ),
        );

        replySpy.mockResolvedValue({ text: "Hey! How's it going?" });

        const result = await runIdleTriggerOnce({
          cfg,
          deps: {
            getQueueSize: () => 0,
            nowMs: () => now,
          },
        });

        expect(result.status).toBe("ran");
        // Verify the custom prompt was passed
        expect(replySpy).toHaveBeenCalled();
        const callArgs = replySpy.mock.calls[0][0];
        expect(callArgs.Body).toBe(customPrompt);
      } finally {
        replySpy.mockRestore();
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("includes IDLE.md file content directly in prompt", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-idle-"));
      const storePath = path.join(tmpDir, "sessions.json");
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");

      try {
        const idleFileContent = "# My Idle Tasks\n- Save important memories\n- Check calendar";
        await fs.writeFile(path.join(tmpDir, DEFAULT_IDLE_TRIGGER_FILENAME), idleFileContent);

        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
            },
          },
          session: {
            store: storePath,
            onIdle: [{ name: "file-trigger", after: "1m" }],
          },
        };

        const now = Date.now();
        const lastActivity = now - 5 * 60 * 1000;

        await fs.writeFile(
          storePath,
          JSON.stringify(
            {
              "main:main": {
                sessionId: "sid",
                updatedAt: lastActivity,
                origin: {
                  provider: "whatsapp",
                  from: "+15551234567",
                },
              },
            },
            null,
            2,
          ),
        );

        replySpy.mockResolvedValue({ text: "IDLE_OK" });

        const result = await runIdleTriggerOnce({
          cfg,
          deps: {
            getQueueSize: () => 0,
            nowMs: () => now,
          },
        });

        expect(result.status).toBe("ran");
        expect(replySpy).toHaveBeenCalled();
        const callArgs = replySpy.mock.calls[0][0];
        // Verify the prompt includes the actual file content
        expect(callArgs.Body).toContain("Here is the content of IDLE.md:");
        expect(callArgs.Body).toContain(idleFileContent);
        expect(callArgs.Body).toContain("Follow these instructions strictly");
        expect(callArgs.Body).toContain("If nothing needs attention, reply IDLE_OK");
      } finally {
        replySpy.mockRestore();
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it("tracks per-trigger timestamps to prevent re-triggering", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-idle-"));
      const storePath = path.join(tmpDir, "sessions.json");
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");

      try {
        await fs.writeFile(
          path.join(tmpDir, DEFAULT_IDLE_TRIGGER_FILENAME),
          "# Idle Tasks\n- Save memories",
        );

        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
            },
          },
          session: {
            store: storePath,
            onIdle: [{ name: "test-trigger", after: "1m" }],
          },
        };

        const now = Date.now();
        const lastActivity = now - 5 * 60 * 1000;
        const lastTriggered = lastActivity + 1000; // Triggered after last activity

        await fs.writeFile(
          storePath,
          JSON.stringify(
            {
              "main:main": {
                sessionId: "sid",
                updatedAt: lastActivity,
                lastIdleTriggeredAt: {
                  "test-trigger": lastTriggered,
                },
                origin: {
                  provider: "whatsapp",
                  from: "+15551234567",
                },
              },
            },
            null,
            2,
          ),
        );

        replySpy.mockResolvedValue({ text: "IDLE_OK" });

        const result = await runIdleTriggerOnce({
          cfg,
          deps: {
            getQueueSize: () => 0,
            nowMs: () => now,
          },
        });

        // Should not trigger because lastIdleTriggeredAt > updatedAt
        expect(result.status).toBe("ran");
        if (result.status === "ran") {
          expect(result.triggersProcessed).toBe(0);
        }
      } finally {
        replySpy.mockRestore();
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("startIdleTriggerRunner", () => {
    it("starts and stops correctly with onIdle config", () => {
      vi.useFakeTimers();

      const runner = startIdleTriggerRunner({
        cfg: {
          session: {
            onIdle: [{ name: "test", after: "5m" }],
          },
        } as OpenClawConfig,
      });

      expect(runner.stop).toBeDefined();
      expect(runner.updateConfig).toBeDefined();

      runner.stop();
    });

    it("does not schedule when no onIdle triggers configured", () => {
      vi.useFakeTimers();

      const runner = startIdleTriggerRunner({
        cfg: {
          session: {},
        } as OpenClawConfig,
      });

      runner.stop();
    });

    it("updates config without restart", () => {
      vi.useFakeTimers();

      const runner = startIdleTriggerRunner({
        cfg: {
          session: {
            onIdle: [{ name: "test", after: "30m" }],
          },
        } as OpenClawConfig,
      });

      runner.updateConfig({
        session: {
          onIdle: [
            { name: "quick", after: "15m" },
            { name: "slow", after: "4h" },
          ],
        },
      } as OpenClawConfig);

      runner.stop();
    });
  });

  describe("constants and prompt", () => {
    it("uses default delay of 30 minutes", () => {
      expect(DEFAULT_IDLE_TRIGGER_DELAY_MINUTES).toBe(30);
    });

    it("uses IDLE.md as default filename", () => {
      expect(DEFAULT_IDLE_TRIGGER_FILENAME).toBe("IDLE.md");
    });

    it("includes 'do not infer old tasks' guardrail in prompt", () => {
      expect(IDLE_TRIGGER_PROMPT).toContain("Do not infer or repeat old tasks");
    });
  });
});
