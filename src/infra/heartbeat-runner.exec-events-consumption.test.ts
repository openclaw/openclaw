import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

describe("heartbeat exec event consumption", () => {
  it("consumes exec events after a successful run so they are not replayed", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "none" },
          },
        },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });
      enqueueSystemEvent("exec finished: codex task completed", {
        sessionKey,
        contextKey: "exec:codex-task",
      });

      vi.spyOn(replyModule, "getReplyFromConfig").mockResolvedValue({
        text: "Handled internally",
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "exec-event",
      });

      expect(result.status).toBe("ran");
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    });
  });

  it("requeues exec events when the heartbeat run fails", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "none" },
          },
        },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "-100155462274",
      });
      enqueueSystemEvent("exec finished: codex task completed", {
        sessionKey,
        contextKey: "exec:codex-task",
      });

      vi.spyOn(replyModule, "getReplyFromConfig").mockRejectedValue(new Error("model failed"));

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "exec-event",
      });

      expect(result).toMatchObject({ status: "failed" });
      expect(peekSystemEvents(sessionKey)).toEqual(["exec finished: codex task completed"]);
    });
  });
});
