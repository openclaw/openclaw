import { afterEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runHeartbeatOnce – isolated session key stability (#59493)", () => {
  /**
   * Simulates the wake-request feedback loop:
   *   1. Normal heartbeat tick produces sessionKey "agent:main:main:heartbeat"
   *   2. An exec/subagent event during that tick calls requestHeartbeatNow()
   *      with the already-suffixed key "agent:main:main:heartbeat"
   *   3. The wake handler passes that key back into runHeartbeatOnce(sessionKey: ...)
   *
   * Before the fix, step 3 would append another ":heartbeat" producing
   * "agent:main:main:heartbeat:heartbeat". After the fix, the key remains
   * stable at "agent:main:main:heartbeat".
   */
  async function runIsolatedHeartbeat(params: {
    tmpDir: string;
    storePath: string;
    cfg: OpenClawConfig;
    sessionKey: string;
  }) {
    await seedSessionStore(params.storePath, params.sessionKey, {
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: "+1555",
    });

    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

    await runHeartbeatOnce({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      deps: {
        getQueueSize: () => 0,
        nowMs: () => 0,
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    return replySpy.mock.calls[0]?.[0];
  }

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

  function makeNamedIsolatedHeartbeatConfig(
    tmpDir: string,
    storePath: string,
    heartbeatSession: string,
  ): OpenClawConfig {
    return {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: {
            every: "5m",
            target: "whatsapp",
            isolatedSession: true,
            session: heartbeatSession,
          },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
  }

  it("does not accumulate :heartbeat suffix when wake passes an already-suffixed key", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);

      // Simulate wake-request path: key already has :heartbeat from a previous tick.
      const alreadySuffixedKey = `${baseSessionKey}:heartbeat`;

      const ctx = await runIsolatedHeartbeat({
        tmpDir,
        storePath,
        cfg,
        sessionKey: alreadySuffixedKey,
      });

      // Key must remain stable — no double :heartbeat suffix.
      expect(ctx?.SessionKey).toBe(`${baseSessionKey}:heartbeat`);
    });
  });

  it("appends :heartbeat exactly once from a clean base key", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);

      const ctx = await runIsolatedHeartbeat({
        tmpDir,
        storePath,
        cfg,
        sessionKey: baseSessionKey,
      });

      expect(ctx?.SessionKey).toBe(`${baseSessionKey}:heartbeat`);
    });
  });

  it("stays stable even with multiply-accumulated suffixes", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeIsolatedHeartbeatConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);

      // Simulate a key that already accumulated several :heartbeat suffixes
      // (from an unpatched gateway running for many ticks).
      const deeplyAccumulatedKey = `${baseSessionKey}:heartbeat:heartbeat:heartbeat`;

      const ctx = await runIsolatedHeartbeat({
        tmpDir,
        storePath,
        cfg,
        sessionKey: deeplyAccumulatedKey,
      });

      // After the fix, ALL trailing :heartbeat suffixes are stripped by the
      // (:heartbeat)+$ regex in a single pass, then exactly one is re-appended.
      // A deeply accumulated key converges to "<base>:heartbeat" in one call.
      expect(ctx?.SessionKey).toBe(`${baseSessionKey}:heartbeat`);
    });
  });

  it("keeps isolated keys distinct when the configured base key already ends with :heartbeat", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeNamedIsolatedHeartbeatConfig(tmpDir, storePath, "alerts:heartbeat");
      const baseSessionKey = "agent:main:alerts:heartbeat";

      const ctx = await runIsolatedHeartbeat({
        tmpDir,
        storePath,
        cfg,
        sessionKey: baseSessionKey,
      });

      expect(ctx?.SessionKey).toBe(`${baseSessionKey}:heartbeat`);
    });
  });

  it("stays stable for wake re-entry when the configured base key already ends with :heartbeat", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg = makeNamedIsolatedHeartbeatConfig(tmpDir, storePath, "alerts:heartbeat");
      const baseSessionKey = "agent:main:alerts:heartbeat";
      const alreadyIsolatedKey = `${baseSessionKey}:heartbeat`;

      const ctx = await runIsolatedHeartbeat({
        tmpDir,
        storePath,
        cfg,
        sessionKey: alreadyIsolatedKey,
      });

      expect(ctx?.SessionKey).toBe(alreadyIsolatedKey);
    });
  });
});
