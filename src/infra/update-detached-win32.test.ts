import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn(() => os.tmpdir()));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock("./tmp-openclaw-dir.js", () => ({
  resolvePreferredOpenClawTmpDir: () => resolvePreferredOpenClawTmpDirMock(),
}));

import { readDetachedUpdateResult, spawnDetachedUpdate } from "./update-detached-win32.js";

const createdFiles = new Set<string>();

function decodeCmdPathArg(value: string): string {
  const trimmed = value.trim();
  const withoutQuotes =
    trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return withoutQuotes.replace(/\^!/g, "!").replace(/%%/g, "%");
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
  it("writes a batch script and spawns a detached process", () => {
    const unref = vi.fn();
    let seenScriptPath = "";
    spawnMock.mockImplementation((_file: string, args: string[]) => {
      seenScriptPath = decodeCmdPathArg(args[3]);
      createdFiles.add(seenScriptPath);
      return { unref };
    });

    const result = spawnDetachedUpdate({
      installArgv: ["npm", "i", "-g", "openclaw@latest"],
      env: { OPENCLAW_WINDOWS_TASK_NAME: "TestTask" } as unknown as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(true);
    expect(result.scriptPath).toMatch(/openclaw-detached-update-.*\.cmd$/);
    expect(result.resultPath).toMatch(/openclaw-detached-update-.*\.json$/);

    // Verify spawn was called correctly
    expect(spawnMock).toHaveBeenCalledOnce();
    const [file, args, opts] = spawnMock.mock.calls[0];
    expect(file).toBe("cmd.exe");
    expect(args[0]).toBe("/d");
    expect(args[1]).toBe("/s");
    expect(args[2]).toBe("/c");
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
    expect(opts.windowsHide).toBe(true);

    // Verify the script content
    const scriptContent = fs.readFileSync(seenScriptPath, "utf8");
    expect(scriptContent).toContain("npm i -g openclaw@latest");
    expect(scriptContent).toContain(`PID eq ${process.pid}`);
    expect(scriptContent).toContain("TestTask");
    expect(scriptContent).toContain("schtasks /Run");
  });

  it("returns ok:false when spawn throws", () => {
    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    const result = spawnDetachedUpdate({
      installArgv: ["npm", "i", "-g", "openclaw@latest"],
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("spawn failed");
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
      installArgv: ["npm", "i", "-g", "openclaw@latest"],
      env: {} as NodeJS.ProcessEnv,
    });

    expect(result.ok).toBe(true);
    const scriptContent = fs.readFileSync(seenScriptPath, "utf8");
    expect(scriptContent).toContain("OpenClaw Gateway");
  });
});

describe("readDetachedUpdateResult", () => {
  it("returns parsed JSON when file exists", () => {
    const tmpPath = path.join(os.tmpdir(), `test-detached-result-${Date.now()}.json`);
    createdFiles.add(tmpPath);
    fs.writeFileSync(tmpPath, JSON.stringify({ ok: true, reason: "install-succeeded" }));

    const result = readDetachedUpdateResult(tmpPath);
    expect(result).toEqual({ ok: true, reason: "install-succeeded" });
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
});
