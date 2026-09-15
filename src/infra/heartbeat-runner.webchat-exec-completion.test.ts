import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent } from "./system-events.js";

describe("exec-completion reply on a WebChat-internal session (#147387)", () => {
  it("tells the model to relay the completion instead of suppressing it", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last" },
          },
        },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
      });
      enqueueSystemEvent(
        "Exec completed (background-report, code 0) :: COMPANION_COMPLETION_TEST",
        { sessionKey },
      );

      const getReplyFromConfig = vi.fn().mockResolvedValue({ text: "COMPANION_COMPLETION_TEST" });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig },
      });

      expect(result.status).toBe("ran");
      expect(getReplyFromConfig).toHaveBeenCalledOnce();
      const [ctx] = getReplyFromConfig.mock.calls[0] as [Record<string, unknown>];
      expect(ctx.Body).toContain("Please relay the command output to the user");
      expect(ctx.Body).not.toContain("user delivery is disabled");
    });
  });

  it("still suppresses a genuinely routeless cron reminder on the same WebChat session", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last" },
          },
        },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
      });
      enqueueSystemEvent("Reminder: Check the overnight report", {
        sessionKey,
        contextKey: "cron:overnight-report",
      });

      const getReplyFromConfig = vi.fn().mockResolvedValue({ text: "Reminder handled" });
      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "cron",
        intent: "event",
        reason: "cron",
        deps: { getReplyFromConfig },
      });

      expect(getReplyFromConfig).toHaveBeenCalledOnce();
      const [ctx] = getReplyFromConfig.mock.calls[0] as [Record<string, unknown>];
      expect(ctx.Body).not.toContain("Please relay this reminder to the user");
    });
  });

  it("does not relay into a hidden internal-effects session sharing the same delivery.kind", async () => {
    // internal-session-effects.ts and voice bare rows also persist
    // `delivery: { kind: "internal" }`, but they are never a real
    // WebChat/Companion client. `createdVia: "internal"` is how those hidden
    // sessions identify themselves; the bypass must not treat them the same
    // as an ordinary WebChat session with no external route configured.
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last" },
          },
        },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
        createdVia: "internal",
      });
      enqueueSystemEvent(
        "Exec completed (background-report, code 0) :: HIDDEN_SESSION_COMPLETION_TEST",
        { sessionKey },
      );

      const getReplyFromConfig = vi
        .fn()
        .mockResolvedValue({ text: "HIDDEN_SESSION_COMPLETION_TEST" });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig },
      });

      expect(result.status).toBe("ran");
      expect(getReplyFromConfig).toHaveBeenCalledOnce();
      const [ctx] = getReplyFromConfig.mock.calls[0] as [Record<string, unknown>];
      expect(ctx.Body).not.toContain("Please relay the command output to the user");
      expect(ctx.Body).toContain("user delivery is disabled");
    });
  });
});
