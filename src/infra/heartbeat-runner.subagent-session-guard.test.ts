import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedHeartbeatSessionRows,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce", () => {
  it("falls back to the main session when a subagent session key is forced", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, agentId, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
            },
          },
        },
        channels: {
          whatsapp: {
            allowFrom: ["*"],
          },
        },
        session: {},
      };

      const mainSessionKey = resolveMainSessionKey(cfg);
      await seedHeartbeatSessionRows(agentId, {
        [mainSessionKey]: {
          sessionId: "sid-main",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastProvider: "whatsapp",
          lastTo: "120363401234567890@g.us",
        },
        "agent:main:subagent:demo": {
          sessionId: "sid-subagent",
          updatedAt: Date.now(),
          lastChannel: "whatsapp",
          lastProvider: "whatsapp",
          lastTo: "120363409999999999@g.us",
        },
      });

      replySpy.mockResolvedValue({ text: "Final alert" });
      const sendWhatsApp = vi.fn().mockResolvedValue({
        messageId: "m1",
        toJid: "jid",
      });

      await runHeartbeatOnce({
        cfg,
        sessionKey: "agent:main:subagent:demo",
        deps: {
          getReplyFromConfig: replySpy,
          whatsapp: sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          SessionKey: mainSessionKey,
          OriginatingChannel: undefined,
          OriginatingTo: undefined,
        }),
        expect.anything(),
        cfg,
      );
    });
  });
});
