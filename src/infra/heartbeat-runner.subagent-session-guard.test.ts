import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

installHeartbeatRunnerTestRuntime();

describe("runHeartbeatOnce", () => {
  it.each([
    {
      name: "when a subagent session key is forced",
      heartbeat: undefined,
      sessionKey: "agent:main:subagent:demo",
      expectedRunSessionKey: "agent:main:main",
    },
    {
      name: "when isolatedSession is enabled and a subagent session key is forced",
      heartbeat: { isolatedSession: true },
      sessionKey: "agent:main:subagent:demo",
      expectedRunSessionKey: "agent:main:main:heartbeat",
    },
  ])(
    "falls back to the main session %s",
    async ({ heartbeat, sessionKey, expectedRunSessionKey }) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "whatsapp",
                ...heartbeat,
              },
            },
          },
          channels: {
            whatsapp: {
              allowFrom: ["*"],
            },
          },
          session: { store: storePath },
        };

        const mainSessionKey = resolveMainSessionKey(cfg);
        await fs.writeFile(
          storePath,
          JSON.stringify({
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
          }),
        );

        replySpy.mockResolvedValue({ text: "Final alert" });
        const sendWhatsApp = vi.fn().mockResolvedValue({
          messageId: "m1",
          toJid: "jid",
        });

        await runHeartbeatOnce({
          cfg,
          sessionKey,
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
            SessionKey: expectedRunSessionKey,
            OriginatingChannel: undefined,
            OriginatingTo: undefined,
          }),
          expect.anything(),
          cfg,
        );
      });
    },
  );
});
