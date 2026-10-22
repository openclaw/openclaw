import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
// Tests heartbeat runner guardrails for subagent sessions.
import { bindHeartbeatReply, bindHeartbeatSend } from "./heartbeat-runner.boundary-test-support.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  setHeartbeatSilentCompletion,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

installHeartbeatRunnerTestRuntime();

afterEach(() => {
  resetSystemEventsForTest();
});

describe("runHeartbeatOnce", () => {
  it("routes single-owner dmScope=main direct event wakes to the main session", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "telegram",
            },
          },
        },
        channels: {
          telegram: {
            allowFrom: ["123"],
          },
        },
        session: { store: storePath, dmScope: "main" },
      };

      const mainSessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [mainSessionKey]: {
            sessionId: "sid-main",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastProvider: "telegram",
            lastTo: "123",
          },
          "agent:main:telegram:default:direct:123": {
            sessionId: "sid-orphan",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastProvider: "telegram",
            lastTo: "456",
          },
        }),
      );
      enqueueSystemEvent("Exec completed (run-dm, code 0)", {
        sessionKey: mainSessionKey,
      });
      replySpy.mockImplementation(async (_ctx, options) => {
        setHeartbeatSilentCompletion(options);
        return undefined;
      });

      bindHeartbeatReply(replySpy);
      bindHeartbeatSend("telegram", vi.fn().mockResolvedValue({ messageId: "m1", chatId: "123" }));
      await runHeartbeatOnce({
        cfg,
        sessionKey: "agent:main:telegram:default:direct:123",
        source: "exec-event",
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const [replyParams] = expectDefined(replySpy.mock.calls[0], "reply call");
      expect(replyParams?.SessionKey).toBe(mainSessionKey);
      expect(replyParams?.Body).toContain("async command completion event");
      expect(peekSystemEventEntries(mainSessionKey)).toStrictEqual([]);
    });
  });
});
