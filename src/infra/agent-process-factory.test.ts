import { describe, it, expect, vi, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { spawnAgentProcess, type AgentProcessConfig } from "./agent-process-factory.js";

// Use mock mode so tests never actually spawn an openclaw subprocess
process.env.OPENCLAW_WORKER_MOCK = "1";

const tmpBase = join(tmpdir(), "agent-process-factory-test-" + Date.now());

function makeConfig(overrides: Partial<AgentProcessConfig> = {}): AgentProcessConfig {
  return {
    teamName: "test-team",
    memberName: "researcher",
    role: "research",
    notifyPort: 7701,
    configPath: join(tmpBase, "config.json"),
    ...overrides,
  };
}

describe("spawnAgentProcess", () => {
  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("should spawn a child process and return it", () => {
    mkdirSync(tmpBase, { recursive: true });
    const child = spawnAgentProcess(makeConfig());
    expect(child).toBeDefined();
    expect(typeof child.pid).toBe("number");
    child.kill();
  });

  it("should create the logs directory", () => {
    mkdirSync(tmpBase, { recursive: true });
    spawnAgentProcess(makeConfig()).kill();
    const logDir = join(tmpBase, "logs");
    expect(existsSync(logDir)).toBe(true);
  });

  it("should throw for memberName containing forward slash", () => {
    mkdirSync(tmpBase, { recursive: true });
    expect(() =>
      spawnAgentProcess(makeConfig({ memberName: "../etc/passwd" }))
    ).toThrow(/Invalid memberName/);
  });

  it("should throw for memberName containing backslash", () => {
    mkdirSync(tmpBase, { recursive: true });
    expect(() =>
      spawnAgentProcess(makeConfig({ memberName: "foo\\bar" }))
    ).toThrow(/Invalid memberName/);
  });

  it("should throw for empty memberName", () => {
    mkdirSync(tmpBase, { recursive: true });
    expect(() =>
      spawnAgentProcess(makeConfig({ memberName: "" }))
    ).toThrow(/Invalid memberName/);
  });

  it("should pass team env vars to the spawned process", () => {
    mkdirSync(tmpBase, { recursive: true });
    // In mock mode the process is a no-op EventEmitter, so we verify via
    // the spawn call — use vi.spyOn to capture the env
    const { spawn } = await import("node:child_process");
    const spawnSpy = vi.spyOn(await import("node:child_process"), "spawn");

    spawnAgentProcess(makeConfig({
      teamName: "my-team",
      memberName: "writer",
      role: "write",
      notifyPort: 7702,
    })).kill();

    // Env vars should include team context
    const call = spawnSpy.mock.calls[0];
    const env = (call?.[2] as any)?.env as NodeJS.ProcessEnv | undefined;
    expect(env?.OPENCLAW_TEAM_NAME).toBe("my-team");
    expect(env?.OPENCLAW_MEMBER_NAME).toBe("writer");
    expect(env?.OPENCLAW_ROLE).toBe("write");
    expect(env?.OPENCLAW_NOTIFY_PORT).toBe("7702");

    spawnSpy.mockRestore();
  });
});
