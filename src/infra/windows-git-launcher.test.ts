// Windows Git launcher tests cover rendering, installer creation, and Doctor migration ownership.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNodeRuntimeInfo } from "../daemon/runtime-paths.js";
import { runExec } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { reconcileWindowsGitLauncher } from "./windows-git-launcher.js";
import { decodeWindowsLauncherScript } from "./windows-launcher-encoding.js";

vi.mock("../process/exec.js", () => ({ runExec: vi.fn() }));

const runRuntimeProbe = vi.mocked(runExec);

function runtimeProbeOutput(overrides: Record<string, unknown> = {}) {
  return {
    stdout: JSON.stringify({
      nodeVersion: "24.16.0",
      sqliteVersion: "3.51.3",
      sqliteSelectionError: null,
      nodeSharedSqlite: false,
      sqliteProbe: { available: true, version: "3.51.3", text: true, blob: true, json: true },
      ...overrides,
    }),
    stderr: "",
  };
}

function useRealRuntimeProbe() {
  const exec = promisify(execFile);
  runRuntimeProbe.mockImplementation((file, args, options) =>
    exec(file, args, {
      encoding: "utf8",
      timeout: typeof options === "number" ? options : options?.timeoutMs,
      env: typeof options === "object" ? options.baseEnv : undefined,
    }),
  );
}

async function createLauncherFixture(root: string) {
  const nodePath = path.join(root, "runtime", "node.exe");
  const entryPath = path.join(root, "checkout", "dist", "entry.js");
  const launcherPath = path.join(root, "home", ".local", "bin", "openclaw.cmd");
  await fs.mkdir(path.dirname(nodePath), { recursive: true });
  await fs.mkdir(path.dirname(entryPath), { recursive: true });
  await fs.mkdir(path.dirname(launcherPath), { recursive: true });
  await fs.writeFile(nodePath, "node", "utf8");
  await fs.writeFile(entryPath, "entry", "utf8");
  return { nodePath, entryPath, launcherPath };
}

describe("reconcileWindowsGitLauncher", () => {
  beforeEach(() => {
    runRuntimeProbe.mockReset();
    runRuntimeProbe.mockResolvedValue(runtimeProbeOutput());
  });

  it("preserves quoted CMD metacharacters and escapes expansion", async () => {
    await withTestDir(
      {
        prefix: "openclaw-windows-git-launcher-",
        subdir: "paths ^ & (approved)! %USER%",
      },
      async (root) => {
        const fixture = await createLauncherFixture(root);
        await reconcileWindowsGitLauncher({
          root,
          repair: true,
          create: true,
          platform: "win32",
          ...fixture,
        });
        const launcher = decodeWindowsLauncherScript({
          buffer: await fs.readFile(fixture.launcherPath),
        });

        expect(launcher).toContain("setlocal DisableDelayedExpansion");
        expect(launcher).toContain(fixture.nodePath.replaceAll("%", "%%"));
        expect(launcher).toContain(fixture.entryPath.replaceAll("%", "%%"));
        expect(launcher).toContain(" & (approved)!");
      },
    );
  });

  it("rejects path characters that cannot be represented in a quoted CMD argument", async () => {
    await expect(
      reconcileWindowsGitLauncher({
        root: "C:\\OpenClaw",
        repair: true,
        create: true,
        platform: "win32",
        nodePath: 'C:\\bad"path\\node.exe',
        entryPath: "C:\\OpenClaw\\dist\\entry.js",
        launcherPath: "C:\\Users\\alice\\.local\\bin\\openclaw.cmd",
      }),
    ).rejects.toThrow(/cannot contain/);
  });

  it("migrates the exact legacy PATH launcher and is then idempotent", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      const legacy = `@echo off\r\nnode "${fixture.entryPath}" %*\r\n`;
      await fs.writeFile(
        fixture.launcherPath,
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(legacy, "utf16le")]),
      );

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: false,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "needs-repair", launcherPath: fixture.launcherPath });
      expect(await fs.readFile(fixture.launcherPath)).toEqual(
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(legacy, "utf16le")]),
      );

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "updated", launcherPath: fixture.launcherPath });
      const migrated = decodeWindowsLauncherScript({
        buffer: await fs.readFile(fixture.launcherPath),
      });
      expect(migrated).toContain("rem OpenClaw Git launcher");
      expect(migrated).toContain(`"${fixture.nodePath}" "${fixture.entryPath}" %*`);

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "unchanged", launcherPath: fixture.launcherPath });

      const replacementNodePath = path.join(root, "replacement ^^ %% runtime", "node.exe");
      await fs.mkdir(path.dirname(replacementNodePath), { recursive: true });
      await fs.writeFile(replacementNodePath, "node", "utf8");
      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          ...fixture,
          nodePath: replacementNodePath,
        }),
      ).resolves.toEqual({ status: "updated", launcherPath: fixture.launcherPath });
      expect(
        decodeWindowsLauncherScript({ buffer: await fs.readFile(fixture.launcherPath) }),
      ).toContain("replacement ^^ %%%% runtime");
      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          ...fixture,
          nodePath: replacementNodePath,
        }),
      ).resolves.toEqual({ status: "unchanged", launcherPath: fixture.launcherPath });
    });
  });

  it("refuses mismatched launcher code pages before runtime validation", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      const params = { root, repair: true, create: true, platform: "win32" as const, ...fixture };
      await reconcileWindowsGitLauncher(params);
      // Corrupt only the encoding declaration around a production-generated body.
      // The real Windows fixture separately proves non-ASCII launcher execution.
      const mismatched = Buffer.concat([
        Buffer.from("@chcp 437 >nul\r\n@rem openclaw-launcher-encoding=utf-8\r\n"),
        await fs.readFile(fixture.launcherPath),
      ]);
      await fs.writeFile(fixture.launcherPath, mismatched);
      runRuntimeProbe.mockClear();
      await expect(reconcileWindowsGitLauncher(params)).resolves.toEqual({
        status: "skipped",
        reason: "foreign",
      });
      expect(runRuntimeProbe).not.toHaveBeenCalled();
      expect(await fs.readFile(fixture.launcherPath)).toEqual(mismatched);
    });
  });

  it("revalidates an unchanged launcher after an in-place runtime downgrade", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      const params = { root, repair: true, create: true, platform: "win32" as const, ...fixture };
      await reconcileWindowsGitLauncher(params);
      const original = await fs.readFile(fixture.launcherPath);
      runRuntimeProbe.mockResolvedValue(runtimeProbeOutput({ nodeVersion: "24.14.0" }));
      await expect(reconcileWindowsGitLauncher(params)).resolves.toEqual({
        status: "needs-reinstall",
        launcherPath: fixture.launcherPath,
      });
      expect(await fs.readFile(fixture.launcherPath)).toEqual(original);
    });
  });

  it("refuses capability-qualified backports and failed probes without changing the launcher", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      const params = { root, repair: true, create: true, platform: "win32" as const, ...fixture };
      await reconcileWindowsGitLauncher(params);
      const original = await fs.readFile(fixture.launcherPath);
      runRuntimeProbe.mockResolvedValue(runtimeProbeOutput({ nodeVersion: "24.15.0" }));
      await expect(reconcileWindowsGitLauncher(params)).resolves.toEqual({
        status: "needs-reinstall",
        launcherPath: fixture.launcherPath,
      });
      runRuntimeProbe.mockRejectedValue(new Error("probe unavailable"));
      await expect(reconcileWindowsGitLauncher(params)).resolves.toEqual({
        status: "needs-reinstall",
        launcherPath: fixture.launcherPath,
      });
      expect(await fs.readFile(fixture.launcherPath)).toEqual(original);
    });
  });

  it("probes launcher runtimes without inheriting preloads or unrelated credentials", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      await reconcileWindowsGitLauncher({
        root,
        repair: true,
        create: true,
        platform: "win32",
        ...fixture,
        env: {
          PATH: "runtime-bin",
          NODE_OPTIONS: "--require hostile.cjs",
          SYNTHETIC_SECRET: "fixture",
        },
      });
      expect(runRuntimeProbe).toHaveBeenCalledWith(fixture.nodePath, expect.any(Array), {
        baseEnv: { PATH: "runtime-bin" },
        logOutput: false,
        timeoutMs: 5000,
      });
    });
  });

  it("does not accept an unchanged launcher with a missing entrypoint", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      const params = { root, repair: true, create: true, platform: "win32" as const, ...fixture };
      await reconcileWindowsGitLauncher(params);
      const original = await fs.readFile(fixture.launcherPath);
      await fs.unlink(fixture.entryPath);
      await expect(reconcileWindowsGitLauncher(params)).rejects.toThrow(
        "OpenClaw build entrypoint not found",
      );
      expect(await fs.readFile(fixture.launcherPath)).toEqual(original);
    });
  });

  it("repairs the installer-owned USERPROFILE launcher when HOME differs", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      const userProfile = path.join(root, "windows-profile");
      const shellHome = path.join(root, "git-bash-home");
      const launcherPath = path.join(userProfile, ".local", "bin", "openclaw.cmd");
      const legacy = `@echo off\r\nnode "${fixture.entryPath}" %*\r\n`;
      await fs.mkdir(path.dirname(launcherPath), { recursive: true });
      await fs.writeFile(launcherPath, legacy, "utf8");

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          env: { HOME: shellHome, USERPROFILE: userProfile },
          nodePath: fixture.nodePath,
          entryPath: fixture.entryPath,
        }),
      ).resolves.toEqual({ status: "updated", launcherPath });
      expect(decodeWindowsLauncherScript({ buffer: await fs.readFile(launcherPath) })).toContain(
        "rem OpenClaw Git launcher",
      );
      await expect(
        fs.stat(path.join(shellHome, ".local", "bin", "openclaw.cmd")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("leaves a legacy launcher unchanged when the selected runtime is unsupported", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      const legacy = `@echo off\r\nnode "${fixture.entryPath}" %*\r\n`;
      await fs.writeFile(fixture.launcherPath, legacy, "utf8");
      runRuntimeProbe.mockResolvedValue(runtimeProbeOutput({ nodeVersion: "24.14.0" }));

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "needs-reinstall", launcherPath: fixture.launcherPath });
      await expect(fs.readFile(fixture.launcherPath, "utf8")).resolves.toBe(legacy);
    });
  });

  it("creates a missing launcher only for the installer path", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "skipped", reason: "missing" });
      await expect(fs.stat(fixture.launcherPath)).rejects.toMatchObject({ code: "ENOENT" });

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          create: true,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "created", launcherPath: fixture.launcherPath });
    });
  });

  it("does not replace an unrelated custom launcher", async () => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(root);
      const custom = [
        "@echo off",
        "rem OpenClaw Git launcher",
        "echo custom launcher",
        `"${fixture.nodePath}" "${fixture.entryPath}" %*`,
        "",
      ].join("\r\n");
      await fs.writeFile(fixture.launcherPath, custom, "utf8");

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          create: true,
          platform: "win32",
          ...fixture,
        }),
      ).resolves.toEqual({ status: "skipped", reason: "foreign" });
      await expect(fs.readFile(fixture.launcherPath, "utf8")).resolves.toBe(custom);

      const doubledPercentEntryPath = path.join(root, "literal %% checkout", "dist", "entry.js");
      const malformedManagedLauncher = [
        "@echo off",
        "rem OpenClaw Git launcher",
        "setlocal DisableDelayedExpansion",
        `if exist "${fixture.nodePath}" goto openclaw_runtime_ready`,
        "echo [!] OpenClaw's validated Node.js runtime is missing. 1>&2",
        "echo [i] Re-run the OpenClaw installer to repair this Git installation. 1>&2",
        "exit /b 1",
        ":openclaw_runtime_ready",
        `"${fixture.nodePath}" "${doubledPercentEntryPath}" %*`,
        "",
      ].join("\r\n");
      await fs.writeFile(fixture.launcherPath, malformedManagedLauncher, "utf8");

      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          create: true,
          platform: "win32",
          ...fixture,
          entryPath: doubledPercentEntryPath,
        }),
      ).resolves.toEqual({ status: "skipped", reason: "foreign" });
      await expect(fs.readFile(fixture.launcherPath, "utf8")).resolves.toBe(
        malformedManagedLauncher,
      );
    });
  });

  it("does nothing outside Windows", async () => {
    await expect(
      reconcileWindowsGitLauncher({
        root: "/tmp/openclaw",
        repair: true,
        platform: "linux",
      }),
    ).resolves.toEqual({ status: "skipped", reason: "not-windows" });
  });
});

describe("Windows launcher runtime validation", () => {
  async function probeRuntime(overrides: Record<string, unknown> = {}) {
    runRuntimeProbe.mockResolvedValue(
      runtimeProbeOutput({
        sqliteProbe: {
          available: true,
          version: "3.51.3",
          text: true,
          blob: true,
          json: true,
          ...overrides,
        },
      }),
    );
    return resolveNodeRuntimeInfo("C:\\validated\\node.exe");
  }

  it("accepts a supported runtime with safe SQLite round trips", async () => {
    await expect(probeRuntime()).resolves.toMatchObject({ status: "supported" });
  });

  it.each([
    { available: false },
    { text: false },
    { blob: false },
    { json: false },
    { error: "SQLite round trip failed" },
    { text: "true" },
  ])("refuses unsafe SQLite capabilities despite a safe version: %j", async (capabilities) => {
    expect((await probeRuntime(capabilities)).status).not.toBe("supported");
  });

  it.each(["not-json", "null", '{"nodeVersion":"24.16.0","sqliteVersion":"3.51.3"}'])(
    "refuses incomplete runtime evidence: %s",
    async (stdout) => {
      runRuntimeProbe.mockResolvedValue({ stdout, stderr: "" });
      await expect(resolveNodeRuntimeInfo("C:\\validated\\node.exe")).resolves.toMatchObject({
        status: "probe-failed",
      });
    },
  );
});

it("probes the running Node executable with the canonical SQLite checks", async () => {
  useRealRuntimeProbe();
  const result = await resolveNodeRuntimeInfo(process.execPath);
  expect(result).toMatchObject({ version: process.versions.node, status: "supported" });
  if (result.status === "probe-failed") {
    throw result.error;
  }
  expect(result.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/);
});

it.runIf(process.platform === "win32").each(["cmd", "powershell"])(
  "keeps migrated update and Doctor launchers pinned through %s and fails closed",
  async (shell) => {
    await withTestDir({ prefix: "openclaw-windows-git-launcher-" }, async (root) => {
      const fixture = await createLauncherFixture(path.join(root, "paths ^ & (approved)! %USER%"));
      const launcherPath = path.join(root, "openclaw.cmd");
      await fs.copyFile(process.execPath, fixture.nodePath);
      await fs.writeFile(
        fixture.entryPath,
        "process.stdout.write(JSON.stringify({ execPath: process.execPath, args: process.argv.slice(2) }));",
      );
      await fs.writeFile(launcherPath, `@echo off\r\nnode "${fixture.entryPath}" %*\r\n`);
      const exec = promisify(execFile);
      useRealRuntimeProbe();
      await expect(
        reconcileWindowsGitLauncher({
          root,
          repair: true,
          ...fixture,
          launcherPath,
        }),
      ).resolves.toEqual({ status: "updated", launcherPath });
      const shadow = path.join(root, "shadow");
      const marker = path.join(root, "shadow-used.txt");
      await fs.mkdir(shadow);
      await fs.writeFile(
        path.join(shadow, "node.cmd"),
        `@echo off\r\necho shadow>"${marker}"\r\nexit /b 99\r\n`,
      );
      const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      const env = {
        ...process.env,
        PATH: shadow,
        OPENCLAW_TEST_LAUNCHER: launcherPath,
      };
      const invoke = (command: string) =>
        shell === "cmd"
          ? exec(
              path.join(system32, "cmd.exe"),
              ["/d", "/v:on", "/s", "/c", `""${launcherPath}" ${command}"`],
              { env, encoding: "utf8" },
            )
          : exec(
              path.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `& $env:OPENCLAW_TEST_LAUNCHER ${command}; exit $LASTEXITCODE`,
              ],
              { env, encoding: "utf8" },
            );
      for (const command of ["update", "doctor"]) {
        const { stdout } = await invoke(command);
        expect(JSON.parse(stdout)).toEqual({ execPath: fixture.nodePath, args: [command] });
      }
      await fs.unlink(fixture.nodePath);
      await expect(invoke("update")).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Re-run the OpenClaw installer"),
      });
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
