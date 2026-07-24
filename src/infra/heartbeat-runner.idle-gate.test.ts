import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedMainSessionStore } from "./heartbeat-runner.test-utils.js";

const MS_48_HOURS = 48 * 60 * 60 * 1000;

function testConfig(
  storePath: string,
  workspaceDir: string,
  heartbeatOverrides?: { maxIdleMinutes?: number },
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        heartbeat: {
          every: "30m",
          target: "none",
          ...heartbeatOverrides,
        },
      },
      list: [{ id: "main" }],
    },
    session: { store: storePath },
  };
}

async function writeHeartbeatFile(workspaceDir: string) {
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "# Heartbeat\nActive content.");
}

describe("heartbeat idle gate", () => {
  let tmpDir: string;
  const now = 1_000_000_000_000;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-idle-gate-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows scheduled heartbeat when session is active", async () => {
    const storePath = path.join(tmpDir, "active-session.json");
    const workspaceDir = path.join(tmpDir, "ws-active");
    const cfg = testConfig(storePath, workspaceDir);
    await writeHeartbeatFile(workspaceDir);
    await seedMainSessionStore(storePath, cfg, {
      lastInteractionAt: now - 60_000,
      lastChannel: "none",
      lastProvider: "test",
      lastTo: "none",
    });

    const res = await runHeartbeatOnce({
      cfg,
      intent: "scheduled",
      deps: { nowMs: () => now },
    });

    // Active session: heartbeat should NOT be skipped by idle gate
    expect(res).not.toEqual({ status: "skipped", reason: "session-idle" });
  });

  it("skips scheduled heartbeat when session idle > default threshold (48h)", async () => {
    const storePath = path.join(tmpDir, "idle-48h.json");
    const workspaceDir = path.join(tmpDir, "ws-idle-48h");
    const cfg = testConfig(storePath, workspaceDir);
    await writeHeartbeatFile(workspaceDir);
    await seedMainSessionStore(storePath, cfg, {
      lastInteractionAt: now - MS_48_HOURS - 60_000, // 48 hours + 1 minute ago
      lastChannel: "none",
      lastProvider: "test",
      lastTo: "none",
    });

    const res = await runHeartbeatOnce({
      cfg,
      intent: "scheduled",
      deps: { nowMs: () => now },
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("session-idle");
    }
  });

  it("does not skip event-wake heartbeat on idle session", async () => {
    const storePath = path.join(tmpDir, "idle-event.json");
    const workspaceDir = path.join(tmpDir, "ws-event");
    const cfg = testConfig(storePath, workspaceDir);
    await writeHeartbeatFile(workspaceDir);
    await seedMainSessionStore(storePath, cfg, {
      lastInteractionAt: now - MS_48_HOURS - 60_000,
      lastChannel: "none",
      lastProvider: "test",
      lastTo: "none",
    });

    const res = await runHeartbeatOnce({
      cfg,
      intent: "event",
      deps: { nowMs: () => now },
    });

    // Event wakes are not gated — should NOT be session-idle
    expect(res).not.toEqual({ status: "skipped", reason: "session-idle" });
  });

  it("does not skip immediate wake on idle session", async () => {
    const storePath = path.join(tmpDir, "idle-immediate.json");
    const workspaceDir = path.join(tmpDir, "ws-immediate");
    const cfg = testConfig(storePath, workspaceDir);
    await writeHeartbeatFile(workspaceDir);
    await seedMainSessionStore(storePath, cfg, {
      lastInteractionAt: now - MS_48_HOURS - 60_000,
      lastChannel: "none",
      lastProvider: "test",
      lastTo: "none",
    });

    const res = await runHeartbeatOnce({
      cfg,
      intent: "immediate",
      deps: { nowMs: () => now },
    });

    expect(res).not.toEqual({ status: "skipped", reason: "session-idle" });
  });

  it("does not skip manual wake on idle session", async () => {
    const storePath = path.join(tmpDir, "idle-manual.json");
    const workspaceDir = path.join(tmpDir, "ws-manual");
    const cfg = testConfig(storePath, workspaceDir);
    await writeHeartbeatFile(workspaceDir);
    await seedMainSessionStore(storePath, cfg, {
      lastInteractionAt: now - MS_48_HOURS - 60_000,
      lastChannel: "none",
      lastProvider: "test",
      lastTo: "none",
    });

    const res = await runHeartbeatOnce({
      cfg,
      intent: "manual",
      deps: { nowMs: () => now },
    });

    expect(res).not.toEqual({ status: "skipped", reason: "session-idle" });
  });

  it("falls back to sessionStartedAt when lastInteractionAt is missing", async () => {
    const storePath = path.join(tmpDir, "fallback-started.json");
    const workspaceDir = path.join(tmpDir, "ws-fallback");
    const cfg = testConfig(storePath, workspaceDir);
    await writeHeartbeatFile(workspaceDir);
    await seedMainSessionStore(storePath, cfg, {
      sessionStartedAt: now - MS_48_HOURS - 60_000,
      lastChannel: "none",
      lastProvider: "test",
      lastTo: "none",
    });

    const res = await runHeartbeatOnce({
      cfg,
      intent: "scheduled",
      deps: { nowMs: () => now },
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("session-idle");
    }
  });

  it("allows scheduled heartbeat when no session entry exists", async () => {
    const storePath = path.join(tmpDir, "no-entry.json");
    const workspaceDir = path.join(tmpDir, "ws-noentry");
    const cfg = testConfig(storePath, workspaceDir);
    await writeHeartbeatFile(workspaceDir);

    const res = await runHeartbeatOnce({
      cfg,
      intent: "scheduled",
      deps: { nowMs: () => now },
    });

    // Without a session entry we cannot determine staleness
    expect(res).not.toEqual({ status: "skipped", reason: "session-idle" });
  });

  it("allows scheduled heartbeat exactly at threshold boundary", async () => {
    const storePath = path.join(tmpDir, "boundary.json");
    const workspaceDir = path.join(tmpDir, "ws-boundary");
    const cfg = testConfig(storePath, workspaceDir);
    await writeHeartbeatFile(workspaceDir);
    await seedMainSessionStore(storePath, cfg, {
      // Exactly default threshold ago — should NOT be skipped (> threshold, not >=)
      lastInteractionAt: now - MS_48_HOURS,
      lastChannel: "none",
      lastProvider: "test",
      lastTo: "none",
    });

    const res = await runHeartbeatOnce({
      cfg,
      intent: "scheduled",
      deps: { nowMs: () => now },
    });

    // Exactly at threshold boundary — should NOT be skipped
    expect(res).not.toEqual({ status: "skipped", reason: "session-idle" });
  });

  it("respects custom maxIdleMinutes config", async () => {
    const storePath = path.join(tmpDir, "custom-threshold.json");
    const workspaceDir = path.join(tmpDir, "ws-custom");
    // Custom threshold: 30 minutes (much shorter than 48h default)
    const cfg = testConfig(storePath, workspaceDir, { maxIdleMinutes: 30 });
    await writeHeartbeatFile(workspaceDir);
    await seedMainSessionStore(storePath, cfg, {
      lastInteractionAt: now - 31 * 60_000, // 31 min ago > 30 min threshold
      lastChannel: "none",
      lastProvider: "test",
      lastTo: "none",
    });

    const res = await runHeartbeatOnce({
      cfg,
      intent: "scheduled",
      deps: { nowMs: () => now },
    });

    expect(res.status).toBe("skipped");
    if (res.status === "skipped") {
      expect(res.reason).toBe("session-idle");
    }
  });

  it("does not skip when maxIdleMinutes is 0 (gate disabled)", async () => {
    const storePath = path.join(tmpDir, "gate-disabled.json");
    const workspaceDir = path.join(tmpDir, "ws-gate-disabled");
    // maxIdleMinutes=0 disables the idle gate entirely
    const cfg = testConfig(storePath, workspaceDir, { maxIdleMinutes: 0 });
    await writeHeartbeatFile(workspaceDir);
    await seedMainSessionStore(storePath, cfg, {
      lastInteractionAt: now - 10 * 24 * 60 * 60 * 1000 - 60_000, // very stale, but gate disabled
      lastChannel: "none",
      lastProvider: "test",
      lastTo: "none",
    });

    const res = await runHeartbeatOnce({
      cfg,
      intent: "scheduled",
      deps: { nowMs: () => now },
    });

    // Gate is disabled — should NOT be session-idle
    expect(res).not.toEqual({ status: "skipped", reason: "session-idle" });
  });
});
