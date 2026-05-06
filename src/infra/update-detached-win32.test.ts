import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StagedNpmInstall } from "./package-update-steps.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";

const spawnMock = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn(() => os.tmpdir()));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock("./tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => resolvePreferredOpenClawTmpDirMock(),
}));

import {
  readDetachedUpdateResult,
  removeDetachedUpdateResult,
  spawnDetachedUpdate,
} from "./update-detached-win32.js";

const createdFiles = new Set<string>();

function decodeCmdPathArg(value: string): string {
  const trimmed = value.trim();
  const withoutQuotes =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return withoutQuotes.replace(/\^!/g, "!").replace(/%%/g, "%");
}

function createNpmFixture(base: string): {
  stage: StagedNpmInstall;
  installTarget: ResolvedGlobalInstallTarget;
} {
  const stagePrefix = path.join(base, "stage");
  const targetPrefix = path.join(base, "target");
  return {
    stage: {
      prefix: stagePrefix,
      packageRoot: path.join(stagePrefix, "lib", "node_modules", "openclaw"),
      layout: {
        prefix: stagePrefix,
        globalRoot: path.join(stagePrefix, "lib", "node_modules"),
        binDir: path.join(stagePrefix, "bin"),
      },
    },
    installTarget: {
      manager: "npm",
      command: "npm",
      globalRoot: path.join(targetPrefix, "lib", "node_modules"),
      packageRoot: path.join(targetPrefix, "lib", "node_modules", "openclaw"),
    },
  };
}

afterEach(() => {
  spawnMock.mockReset();
  resolvePreferredOpenClawTmpDirMock.mockReset();
  resolvePreferredOpenClawTmpDirMock.mockReturnValue(os.tmpdir());
  for (const filePath of createdFiles) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // best-effort
    }
  }
  createdFiles.clear();
});

describe("spawnDetachedUpdate", () => {
  it("writes launcher and swap scripts and spawns a detached process", () => {
    const unref = vi.fn();
    let seenScriptPath = "";
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      seenScriptPath = decodeCmdPathArg(args[3]);
      createdFiles.add(seenScriptPath);
      return { unref };
    });

    const fixture = createNpmFixture(os.tmpdir());
    const result = spawnDetachedUpdate({
      ...fixture,
      packageName: "openclaw",
      afterVersion: "2.0.0",
      env: { OPENCLAW_WINDOWS_TASK_NAME: "TestTask" } as unknown as NodeJS.ProcessEnv,
    });
    createdFiles.add(result.nodeScriptPath);

    expect(result.ok).toBe(true);
    expect(result.scriptPath).toMatch(/openclaw-detached-update-.*\.cmd$/);
    expect(result.nodeScriptPath).toMatch(/openclaw-detached-update-.*\.cjs$/);
    expect(result.resultPath).toMatch(/openclaw-detached-update-.*\.json$/);

    expect(spawnMock).toHaveBeenCalledOnce();
    const [file, args, opts] = spawnMock.mock.calls[0];
    expect(file).toBe("cmd.exe");
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
    expect(opts.windowsHide).toBe(true);
    expect(opts.env).toEqual({ OPENCLAW_WINDOWS_TASK_NAME: "TestTask" });

    const launcher = fs.readFileSync(seenScriptPath, "utf8");
    expect(launcher).toContain(`PID eq ${process.pid}`);
    expect(launcher).toContain("TestTask");
    expect(launcher).toContain("schtasks /Run");
    expect(launcher).toContain(path.basename(result.nodeScriptPath));

    const swapScript = fs.readFileSync(result.nodeScriptPath, "utf8");
    expect(swapScript).toContain('"afterVersion":"2.0.0"');
    expect(swapScript).toContain(fixture.stage.packageRoot.replaceAll("\\", "\\\\"));
    expect(swapScript).toContain(fixture.installTarget.packageRoot!.replaceAll("\\", "\\\\"));
  });

  it("returns ok:false when spawn throws and removes temporary scripts", () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    const result = spawnDetachedUpdate({
      ...createNpmFixture(os.tmpdir()),
      packageName: "openclaw",
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("spawn failed");
    expect(fs.existsSync(result.scriptPath)).toBe(false);
    expect(fs.existsSync(result.nodeScriptPath)).toBe(false);
  });

  it("uses default task name when env override is not set", () => {
    const unref = vi.fn();
    let seenScriptPath = "";
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      seenScriptPath = decodeCmdPathArg(args[3]);
      createdFiles.add(seenScriptPath);
      return { unref };
    });

    const result = spawnDetachedUpdate({
      ...createNpmFixture(os.tmpdir()),
      packageName: "openclaw",
      env: {} as NodeJS.ProcessEnv,
    });
    createdFiles.add(result.nodeScriptPath);

    expect(result.ok).toBe(true);
    const scriptContent = fs.readFileSync(seenScriptPath, "utf8");
    expect(scriptContent).toContain("OpenClaw Gateway");
  });
});

describe("readDetachedUpdateResult", () => {
  it("returns parsed JSON when file exists", () => {
    const tmpPath = path.join(os.tmpdir(), `test-detached-result-${Date.now()}.json`);
    createdFiles.add(tmpPath);
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({ ok: true, reason: "install-succeeded", afterVersion: "2.0.0" }),
    );

    const result = readDetachedUpdateResult(tmpPath);
    expect(result).toEqual({ ok: true, reason: "install-succeeded", afterVersion: "2.0.0" });
  });

  it("returns null when file does not exist", () => {
    const result = readDetachedUpdateResult("/nonexistent/path.json");
    expect(result).toBeNull();
  });

  it("returns null when file contains invalid JSON", () => {
    const tmpPath = path.join(os.tmpdir(), `test-detached-result-bad-${Date.now()}.json`);
    createdFiles.add(tmpPath);
    fs.writeFileSync(tmpPath, "not json");

    const result = readDetachedUpdateResult(tmpPath);
    expect(result).toBeNull();
  });

  it("removes detached result files best-effort", () => {
    const tmpPath = path.join(os.tmpdir(), `test-detached-result-remove-${Date.now()}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify({ ok: true }));

    removeDetachedUpdateResult(tmpPath);
    expect(fs.existsSync(tmpPath)).toBe(false);
    removeDetachedUpdateResult(tmpPath);
  });
});
