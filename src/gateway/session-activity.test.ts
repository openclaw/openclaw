import { describe, expect, it } from "vitest";
import { createSessionActivityRegistry } from "./session-activity.js";

describe("session activity registry", () => {
  it("tracks a run from start to finish", () => {
    const registry = createSessionActivityRegistry();

    registry.markRunStarted({
      sessionKey: "agent:main:main",
      runId: "run-1",
      source: "chat",
      startedAt: 100,
    });

    expect(registry.getRunning("agent:main:main")).toEqual({
      key: "agent:main:main",
      phase: "running",
      source: "chat",
      runId: "run-1",
      startedAt: 100,
      lastActivityAt: 100,
    });

    registry.markRunFinished("run-1");

    expect(registry.getRunning("agent:main:main")).toBeNull();
  });

  it("prefers the most recently active run for a session", () => {
    const registry = createSessionActivityRegistry();

    registry.markRunStarted({
      sessionKey: "agent:main:main",
      runId: "run-1",
      source: "chat",
      startedAt: 100,
    });
    registry.markRunStarted({
      sessionKey: "agent:main:main",
      runId: "run-2",
      source: "heartbeat",
      startedAt: 200,
    });

    expect(registry.getRunning("agent:main:main")?.runId).toBe("run-2");
    expect(registry.getRunning("agent:main:main")?.source).toBe("heartbeat");

    registry.touchRun("run-1", 300);

    expect(registry.getRunning("agent:main:main")?.runId).toBe("run-1");
    expect(registry.getRunning("agent:main:main")?.lastActivityAt).toBe(300);
  });

  it("moves a reused run id to the new session", () => {
    const registry = createSessionActivityRegistry();

    registry.markRunStarted({
      sessionKey: "agent:main:main",
      runId: "run-1",
      source: "chat",
      startedAt: 100,
    });
    registry.markRunStarted({
      sessionKey: "agent:ops:main",
      runId: "run-1",
      source: "cron",
      startedAt: 150,
    });

    expect(registry.getRunning("agent:main:main")).toBeNull();
    expect(registry.getRunning("agent:ops:main")).toEqual({
      key: "agent:ops:main",
      phase: "running",
      source: "cron",
      runId: "run-1",
      startedAt: 100,
      lastActivityAt: 150,
    });
  });
});
