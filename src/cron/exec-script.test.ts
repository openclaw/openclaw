// Authored by: cc (Claude Code) | 2026-03-20
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execCronScript, resolveScriptInterpreter } from "./exec-script.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-script-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeScript(name: string, content: string, mode = 0o755): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  fs.chmodSync(p, mode);
  return p;
}

describe("execCronScript", () => {
  it("captures stdout as summary on success", async () => {
    const script = writeScript("ok.sh", "#!/bin/sh\necho hello");
    const result = await execCronScript({
      payload: { kind: "script", command: script },
      basePath: tmpDir,
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("hello");
  });

  it("captures stderr and returns error on non-zero exit", async () => {
    const script = writeScript("fail.sh", "#!/bin/sh\necho bad >&2\nexit 1");
    const result = await execCronScript({
      payload: { kind: "script", command: script },
      basePath: tmpDir,
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("bad");
  });

  it("passes args to the script", async () => {
    const script = writeScript("args.sh", "#!/bin/sh\necho $1 $2");
    const result = await execCronScript({
      payload: { kind: "script", command: script, args: ["foo", "bar"] },
      basePath: tmpDir,
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("foo bar");
  });

  it("merges env into child environment", async () => {
    const script = writeScript("env.sh", "#!/bin/sh\necho $MY_VAR");
    const result = await execCronScript({
      payload: { kind: "script", command: script, env: { MY_VAR: "injected" } },
      basePath: tmpDir,
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("injected");
  });

  it("resolves relative command paths against basePath", async () => {
    writeScript("relative.sh", "#!/bin/sh\necho relative");
    const result = await execCronScript({
      payload: { kind: "script", command: "relative.sh" },
      basePath: tmpDir,
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("relative");
  });

  it("returns error when script file does not exist", async () => {
    const result = await execCronScript({
      payload: { kind: "script", command: "nonexistent.sh" },
      basePath: tmpDir,
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("script not found");
  });

  it("aborts when abortSignal is already aborted", async () => {
    const script = writeScript("sleep.sh", "#!/bin/sh\nsleep 10");
    const controller = new AbortController();
    controller.abort();
    const result = await execCronScript({
      payload: { kind: "script", command: script },
      basePath: tmpDir,
      abortSignal: controller.signal,
    });
    expect(result.status).toBe("error");
    expect(result.error).toContain("aborted");
  });

  it("kills script and returns error when aborted mid-run", async () => {
    const script = writeScript("slow.sh", "#!/bin/sh\nsleep 30");
    const controller = new AbortController();
    const resultPromise = execCronScript({
      payload: { kind: "script", command: script },
      basePath: tmpDir,
      abortSignal: controller.signal,
    });
    // Abort after a delay long enough for the process to start reliably on slow CI.
    setTimeout(() => controller.abort(), 500);
    const result = await resultPromise;
    expect(result.status).toBe("error");
    expect(result.error).toContain("aborted");
  });

  it("runs .sh script without executable bit via sh interpreter", async () => {
    const scriptPath = path.join(tmpDir, "no-x.sh");
    fs.writeFileSync(scriptPath, "#!/bin/sh\necho hello-no-x", { mode: 0o644 });
    const result = await execCronScript({
      payload: { kind: "script", command: scriptPath },
      basePath: tmpDir,
    });
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("hello-no-x");
  });

  it("uses cwd when provided", async () => {
    const script = writeScript("pwd.sh", "#!/bin/sh\npwd");
    const result = await execCronScript({
      payload: { kind: "script", command: script, cwd: tmpDir },
      basePath: tmpDir,
    });
    expect(result.status).toBe("ok");
    // Resolves to realpath in case tmpDir is a symlink (macOS /var -> /private/var).
    expect(fs.realpathSync(result.summary ?? "")).toBe(fs.realpathSync(tmpDir));
  });
});

describe("resolveScriptInterpreter — Windows extensions", () => {
  // Mocks process.platform to verify win32 branch without a real Windows host.

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubWin32() {
    vi.stubGlobal("process", { ...process, platform: "win32" });
  }

  it("maps .bat to cmd.exe /C on win32", () => {
    stubWin32();
    expect(resolveScriptInterpreter("script.bat")).toEqual({ cmd: "cmd.exe", args: ["/C"] });
  });

  it("maps .cmd to cmd.exe /C on win32", () => {
    stubWin32();
    expect(resolveScriptInterpreter("script.cmd")).toEqual({ cmd: "cmd.exe", args: ["/C"] });
  });

  it("maps .ps1 to powershell.exe with bypass flags on win32", () => {
    stubWin32();
    expect(resolveScriptInterpreter("script.ps1")).toEqual({
      cmd: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"],
    });
  });

  it("returns null for .bat on non-Windows", () => {
    // On macOS/Linux .bat has no mapping — caller falls back to direct exec.
    vi.stubGlobal("process", { ...process, platform: "linux" });
    expect(resolveScriptInterpreter("script.bat")).toBeNull();
  });

  it("returns null for .cmd on non-Windows", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(resolveScriptInterpreter("script.cmd")).toBeNull();
  });

  it("returns null for .ps1 on non-Windows", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    expect(resolveScriptInterpreter("script.ps1")).toBeNull();
  });

  it("existing POSIX mappings are unaffected on win32", () => {
    stubWin32();
    expect(resolveScriptInterpreter("script.sh")).toEqual({ cmd: "sh", args: [] });
    expect(resolveScriptInterpreter("script.py")).toEqual({ cmd: "python3", args: [] });
    expect(resolveScriptInterpreter("script.js")).toEqual({ cmd: "node", args: [] });
  });
});
