import { afterEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import * as deliverModule from "./outbound/deliver.js";
import { resetSystemEventsForTest } from "./system-events.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
});

/**
 * Regression: when `heartbeat.isolatedSession: true`, the outbound delivery's
 * `session.key` must be the isolated `:heartbeat` session key, NOT the base
 * session key.
 *
 * Why this matters: outbound delivery uses `session.key` to resolve the mirror
 * sessionKey passed to `appendAssistantMessageToSessionTranscript`. When the
 * base key is used, the heartbeat assistant text is appended to the base
 * session's `sessionFile` instead of the isolated heartbeat session's file.
 * That leaves the isolated session entry registered in `sessions.json` with a
 * `sessionFile` path that is never created on disk, breaking heartbeat
 * transcript history and causing downstream consumers (e.g. file-watchers) to
 * miscategorize heartbeat output as DM messages.
 *
 * Fixes: #56941, #57577
 */
describe("runHeartbeatOnce – isolated session outbound mirror routing", () => {
  function makeIsolatedHeartbeatConfig(tmpDir: string, storePath: string): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "whatsapp",
            isolatedSession: true,
          },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
  }

  it("uses the isolated :heartbeat session key for outbound mirror, not the base key", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const expectedIsolatedKey = `${baseSessionKey}:heartbeat`;

      await seedSessionStore(storePath, baseSessionKey, {
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+1555",
      });

      const deliverSpy = vi
        .spyOn(deliverModule, "deliverOutboundPayloads")
        .mockResolvedValue(undefined);
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "Heartbeat reply" });

      await runHeartbeatOnce({
        cfg,
        sessionKey: baseSessionKey,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(deliverSpy).toHaveBeenCalled();
      const deliverCall = deliverSpy.mock.calls[0]?.[0];
      expect(deliverCall?.session?.key).toBe(expectedIsolatedKey);
      // Must NOT be the base key — that would cause the mirror append to write
      // to the base session's sessionFile.
      expect(deliverCall?.session?.key).not.toBe(baseSessionKey);
    });
  });

  it("uses the isolated key on wake re-entry from an already-suffixed session", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedKey = `${baseSessionKey}:heartbeat`;

      await seedSessionStore(storePath, isolatedKey, {
        sessionId: "sid",
        updatedAt: 1,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+1555",
      });

      const deliverSpy = vi
        .spyOn(deliverModule, "deliverOutboundPayloads")
        .mockResolvedValue(undefined);
      const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
      replySpy.mockResolvedValue({ text: "Heartbeat reply" });

      // Simulate wake handler passing an already-suffixed key.
      await runHeartbeatOnce({
        cfg,
        sessionKey: isolatedKey,
        deps: {
          getQueueSize: () => 0,
          nowMs: () => 0,
        },
      });

      expect(deliverSpy).toHaveBeenCalled();
      const deliverCall = deliverSpy.mock.calls[0]?.[0];
      // Key should remain stable at the single :heartbeat suffix and be used
      // as the outbound session key (not double-suffixed, not the base key).
      expect(deliverCall?.session?.key).toBe(isolatedKey);
    });
  });
});
