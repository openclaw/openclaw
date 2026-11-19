import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getWindowsPowerShellExePath } from "../infra/windows-install-roots.js";
import { installDesktopTerminalPath } from "./terminal-cli.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform !== "win32").each([
  ["String", "append"],
  ["ExpandString", "append"],
  ["ExpandString", "duplicate"],
  ["String", "selected"],
  ["String", "refused"],
  ["String", "concurrent"],
  ["String", "suffix"],
] as const)("preserves %s user registry data during %s terminal setup", async (kind, mode) => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-terminal-registry-"));
  const key = "Software\\OpenClawTerminalTests\\" + path.basename(root);
  const powershell = getWindowsPowerShellExePath();
  const run = (script: string, env: NodeJS.ProcessEnv = {}) =>
    actual.execFileSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; " + script],
      { encoding: "utf8", env: { ...process.env, ...env }, windowsHide: true },
    );
  try {
    const launcher = path.join(root, ".openclaw/bin/openclaw.cmd");
    const bin = path.dirname(launcher);
    await fs.mkdir(bin, { recursive: true });
    const marker = {
      purpose: "gateway",
      runtime: { bun: process.execPath },
      entry: process.argv[1],
    };
    await fs.writeFile(
      launcher,
      "@echo off\r\n@rem # OpenClaw-Tauri runtime v1 " +
        JSON.stringify(marker) +
        "\r\n@echo desktop\r\n",
    );
    const operator = path.join(root, "operator bin");
    await fs.mkdir(operator);
    if (mode === "selected") {
      await fs.writeFile(path.join(operator, "openclaw.cmd"), "@echo operator\r\n");
    }
    const before =
      "%SystemRoot%\\system32;" +
      operator +
      (mode === "duplicate" ? ";" + bin.toUpperCase() + "\\" : "");
    run(
      "$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:FIXTURE_KEY); try { $k.SetValue('Path',$env:FIXTURE_PATH,([Microsoft.Win32.RegistryValueKind]$env:FIXTURE_KIND)) } finally { $k.Dispose() }",
      { FIXTURE_KEY: key, FIXTURE_PATH: before, FIXTURE_KIND: kind },
    );
    vi.mocked(execFileSync).mockImplementation((file, args, options) => {
      const argv = Array.from(args ?? []);
      const script = argv.at(-1);
      // Substitute only the registry/message OS boundary. Never touch the real user PATH
      // or broadcast a fixture environment; execute the production read/merge/write logic.
      if (typeof script !== "string" || !script.includes("CreateSubKey('Environment')")) {
        throw new Error("Unknown registry adapter; refusing non-fixture writes");
      }
      const notification = script.indexOf("Add-Type -Namespace OpenClaw");
      if (notification < 0) {
        throw new Error("Unknown notification adapter; refusing fixture broadcast");
      }
      let sandboxed = script
        .slice(0, notification)
        .replace("CreateSubKey('Environment')", "CreateSubKey('" + key + "')");
      if (mode === "refused") {
        throw new Error("fixture registry write refused");
      }
      if (mode === "concurrent") {
        sandboxed = sandboxed.replace(
          "    if ($key.GetValue",
          "    $key.SetValue('Path', 'operator-changed', $kind)\n    if ($key.GetValue",
        );
      }
      if (sandboxed.includes("CreateSubKey('Environment')")) {
        throw new Error("Registry fixture isolation failed");
      }
      return actual.execFileSync(file, [...argv.slice(0, -1), sandboxed], options);
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: undefined,
    };
    for (const name of Object.keys(env)) {
      if (["PATH", "PATHEXT"].includes(name.toUpperCase())) {
        delete env[name];
      }
    }
    env.pAtH = mode === "selected" ? operator : "C:\\missing-terminal-fixture";
    env.PatHeXt = mode === "suffix" ? ".EXE;.BAT" : ".EXE;.CMD;.BAT";
    if (mode === "refused" || mode === "concurrent" || mode === "suffix") {
      await expect(installDesktopTerminalPath(launcher, env)).rejects.toThrow(
        mode === "suffix"
          ? ".CMD in PATHEXT"
          : mode === "refused"
            ? "fixture registry write refused"
            : "User PATH changed",
      );
    } else {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await installDesktopTerminalPath(launcher, env)).toContain(
          mode === "selected" ? "Terminal default unchanged" : "CLI available",
        );
      }
    }
    const snapshot = JSON.parse(
      run(
        "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:FIXTURE_KEY); try { @{value=$k.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=$k.GetValueKind('Path').ToString()} | ConvertTo-Json -Compress } finally { $k.Dispose() }",
        { FIXTURE_KEY: key },
      ),
    );
    expect(snapshot).toEqual({
      value:
        mode === "concurrent"
          ? "operator-changed"
          : mode === "append"
            ? before + ";" + bin
            : before,
      kind,
    });
    await expect(fs.stat(path.join(root, ".openclaw/openclaw.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (mode === "refused" || mode === "concurrent" || mode === "suffix") {
      return;
    }
    const commandEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(commandEnv)) {
      if (name.toUpperCase() === "PATH") {
        delete commandEnv[name];
      }
    }
    commandEnv.PATH = snapshot.value;
    const output = actual.execFileSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", "openclaw qr"],
      { encoding: "utf8", env: commandEnv },
    );
    expect(output.trim()).toBe(mode === "selected" ? "operator" : "desktop");
  } finally {
    run("[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:FIXTURE_KEY,$false)", {
      FIXTURE_KEY: key,
    });
    await fs.rm(root, { recursive: true, force: true });
  }
});
