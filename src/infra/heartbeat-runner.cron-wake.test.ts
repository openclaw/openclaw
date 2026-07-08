// Regression for #101537: cron-sourced main-session wakes were recorded as
// status=skipped / error="disabled" whenever the target agent had no per-agent
// heartbeat config (common for the default "main" agent). A cron wake is an
// explicit deliver-to-main request, not a scheduled heartbeat poll, so the
// per-agent heartbeat-enabled and interval guards must not gate it. The global
// heartbeats toggle still applies to cron-sourced wakes.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([]),
  deliverOutboundPayloadsInternal: vi.fn().mockResolvedValue([]),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function cronWakeConfig(tmpDir: string, storePath: string): OpenClawConfig {
  // A second agent with an explicit heartbeat config makes `hasExplicit` true,
  // so the default "main" agent (no per-agent heartbeat) is treated as
  // heartbeat-disabled by isHeartbeatEnabledForAgent — reproducing the
  // status=skipped/error="disabled" outcome from #101537.
  return {
    agents: {
      defaults: { workspace: tmpDir },
      list: [
        { id: "main", default: true },
        { id: "ops", heartbeat: { every: "5m", target: "whatsapp" } },
      ],
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
  } as OpenClawConfig;
}

describe("runHeartbeatOnce – cron-sourced wake bypasses heartbeat config gate (#101537)", () => {
  it("wakes the main agent even when no per-agent heartbeat is configured", async () => {
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const cfg = cronWakeConfig(tmpDir, storePath);
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: "whatsapp",
          lastProvider: "whatsapp",
          lastTo: "+15551234567",
        });
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

        const res = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          source: "cron",
          intent: "immediate",
          reason: "cron:test-job",
          sessionKey,
          heartbeat: { target: "last" },
          deps: {
            getReplyFromConfig: replySpy,
            getQueueSize: () => 0,
            nowMs: () => 0,
          },
        });

        // Before the fix this returned { status: "skipped", reason: "disabled" }
        // because the main agent has no per-agent heartbeat config.
        expect(res.status).toBe("ran");
      },
      { prefix: "openclaw-hb-cron-wake-" },
    );
  });

  it("still skips cron wakes when global heartbeats are disabled", async () => {
    const { setHeartbeatsEnabled } = await import("./heartbeat-wake.js");
    await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const cfg = cronWakeConfig(tmpDir, storePath);
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: "whatsapp",
          lastProvider: "whatsapp",
          lastTo: "+15551234567",
        });
        replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
        setHeartbeatsEnabled(false);
        try {
          const res = await runHeartbeatOnce({
            cfg,
            agentId: "main",
            source: "cron",
            intent: "immediate",
            reason: "cron:test-job",
            sessionKey,
            heartbeat: { target: "last" },
            deps: {
              getReplyFromConfig: replySpy,
              getQueueSize: () => 0,
              nowMs: () => 0,
            },
          });
          expect(res.status).toBe("skipped");
          expect((res as { reason?: string }).reason).toBe("disabled");
        } finally {
          setHeartbeatsEnabled(true);
        }
      },
      { prefix: "openclaw-hb-cron-wake-" },
    );
  });
});
