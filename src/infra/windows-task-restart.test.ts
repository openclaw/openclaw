// Covers Windows scheduled-task gateway restart via Node.js handoff.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFullEnv } from "../test-utils/env.js";

const spawnMock = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn(() => os.tmpdir()));
const resolveTaskScriptPathMock = vi.hoisted(() =>
  vi.fn((env: Record<string, string | undefined>) => {
    const home = env.USERPROFILE || env.HOME || os.homedir();
    return path.join(home, ".openclaw", "gateway.cmd");
  }),
);

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: (...args: unknown[]) => spawnMock(...args),
    },
  );
});
vi.mock("./tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => resolvePreferredOpenClawTmpDirMock(),
}));
vi.mock("../daemon/schtasks.js", () => ({
  resolveTaskScriptPath: (env: Record<string, string | undefined>) =>
    resolveTaskScriptPathMock(env),
}));

type WindowsTaskRestartModule = typeof import("./windows-task-restart.js");

let relaunchGatewayScheduledTask: WindowsTaskRestartModule["relaunchGatewayScheduledTask"];

const envSnapshot = captureFullEnv();
const createdScriptPaths = new Set<string>();

function requireCall(mock: { mock: { calls: unknown[][] } }, index: number, label: string) {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function getCreatedScriptPath(): string {
  const scriptPath = [...createdScriptPaths][0];
  if (!scriptPath) {
    throw new Error("expected restart launcher script path");
  }
  return scriptPath;
}

afterEach(() => {
  envSnapshot.restore();
  for (const scriptPath of createdScriptPaths) {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Best-effort cleanup for temp helper scripts created in tests.
    }
  }
  createdScriptPaths.clear();
});

describe("relaunchGatewayScheduledTask", () => {
  beforeAll(async () => {
    ({ relaunchGatewayScheduledTask } = await import("./windows-task-restart.js"));
  });

  beforeEach(() => {
    spawnMock.mockReset();
    resolvePreferredOpenClawTmpDirMock.mockReset();
    resolvePreferredOpenClawTmpDirMock.mockReturnValue(os.tmpdir());
    resolveTaskScriptPathMock.mockReset();
    resolveTaskScriptPathMock.mockImplementation((env: Record<string, string | undefined>) => {
      const home = env.USERPROFILE || env.HOME || os.homedir();
      return path.join(home, ".openclaw", "gateway.cmd");
    });
  });

  it("spawns a detached Node.js handoff launcher", () => {
    const unref = vi.fn();
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      if (args.length === 1 && args[0]?.endsWith(".mjs")) {
        createdScriptPaths.add(args[0]);
      }
      return { unref };
    });

    const result = relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    expect(result.ok).toBe(true);
    expect(result.method).toBe("schtasks");
    expect(spawnMock).toHaveBeenCalledTimes(2);

    const endCall = requireCall(spawnMock, 0, "schtasks end");
    expect(endCall[0]).toBe("cmd.exe");

    const launcherCall = requireCall(spawnMock, 1, "node launcher");
    expect(launcherCall[0]).toBe(process.execPath);
    expect(launcherCall[1]).toHaveLength(1);
    expect((launcherCall[1] as string[])[0]).toContain("openclaw-node-restart-");
    expect(launcherCall[2]).toStrictEqual({
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    expect(unref).toHaveBeenCalledTimes(2);

    expect(fs.readFileSync(getCreatedScriptPath(), "utf8")).toContain("node-handoff");
  });

  it("prefers OPENCLAW_WINDOWS_TASK_NAME overrides", () => {
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      if (args.length === 1 && args[0]?.endsWith(".mjs")) {
        createdScriptPaths.add(args[0]);
      }
      return { unref: vi.fn() };
    });

    relaunchGatewayScheduledTask({
      OPENCLAW_PROFILE: "work",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (custom)",
    });

    expect(fs.readFileSync(getCreatedScriptPath(), "utf8")).toContain("OpenClaw Gateway (custom)");
  });

  it("includes stop-wait-start sequence in the launcher script", () => {
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      if (args.length === 1 && args[0]?.endsWith(".mjs")) {
        createdScriptPaths.add(args[0]);
      }
      return { unref: vi.fn() };
    });

    relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    const script = fs.readFileSync(getCreatedScriptPath(), "utf8");
    expect(script).toContain("schtasks");
    expect(script).toContain("/Run");
    expect(script).toContain("stopped");
    expect(script).toContain("openclaw restart finished");
  });

  it("includes gateway port force-kill fallback in the launcher script", () => {
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      if (args.length === 1 && args[0]?.endsWith(".mjs")) {
        createdScriptPaths.add(args[0]);
      }
      return { unref: vi.fn() };
    });

    relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    const script = fs.readFileSync(getCreatedScriptPath(), "utf8");
    expect(script).toContain("18789");
    expect(script).toContain("taskkill");
  });

  it("includes gateway.cmd fallback in the launcher script", () => {
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      if (args.length === 1 && args[0]?.endsWith(".mjs")) {
        createdScriptPaths.add(args[0]);
      }
      return { unref: vi.fn() };
    });

    relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    const script = fs.readFileSync(getCreatedScriptPath(), "utf8");
    expect(script).toContain("fallback");
    expect(script).toContain("gateway.cmd");
  });

  it("returns failed when the launcher cannot be spawned", () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn failed");
    });

    const result = relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    expect(result.ok).toBe(false);
    expect(result.method).toBe("schtasks");
    expect(result.detail).toContain("spawn failed");
  });

  it("uses windowsHide: true on all spawned processes", () => {
    spawnMock.mockImplementation(() => ({ unref: vi.fn() }));

    relaunchGatewayScheduledTask({ OPENCLAW_PROFILE: "work" });

    for (const call of spawnMock.mock.calls) {
      expect(call[2]).toMatchObject({ windowsHide: true });
    }
  });
});
