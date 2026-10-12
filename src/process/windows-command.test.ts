// Windows command tests cover command quoting and shell resolution on Windows.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { runCommandWithTimeout } from "./exec.js";
import { spawnTerminalPty } from "./terminal-pty.js";
import { resolveSafeChildProcessInvocation, resolveWindowsCommandShim } from "./windows-command.js";

async function withWindowsFiles(files: string[], run: (directory: string) => void) {
  await withTempDir("openclaw-windows-command-", async (directory) => {
    for (const file of files) {
      const filename = path.join(directory, file);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, "");
    }
    withMockedWindowsPlatform(() => run(directory));
  });
}

describe("Windows command helpers", () => {
  it.each([
    { command: "pnpm", platform: "linux", expected: "pnpm" },
    { command: "corepack", platform: "win32", expected: "corepack.cmd" },
    { command: "npm.cmd", platform: "win32", expected: "npm.cmd" },
  ] as const)("resolves $command on $platform to $expected", ({ command, platform, expected }) => {
    expect(
      resolveWindowsCommandShim({ command, platform, cmdCommands: ["corepack", "pnpm", "npm"] }),
    ).toBe(expected);
  });

  it("resolves relative executables against the child cwd", async () => {
    await withWindowsFiles(["bin/tool.exe"], (cwd) => {
      expect(
        resolveSafeChildProcessInvocation({ argv: ["./bin/tool"], cwd, env: { PATHEXT: ".EXE" } })
          .command,
      ).toBe(path.join(cwd, "bin", "tool.exe"));
    });
  });

  it("resolves bare executables from PATH without allowing child-cwd shadowing", async () => {
    await withWindowsFiles(["cwd/tool.exe", "bin/tool.exe"], (base) => {
      const binDir = path.join(base, "bin");
      expect(
        resolveSafeChildProcessInvocation({
          argv: ["tool.exe"],
          cwd: path.join(base, "cwd"),
          env: { PATH: binDir, PATHEXT: ".EXE" },
        }).command,
      ).toBe(path.join(binDir, "tool.exe"));
    });
  });

  it.each([".EXE;.CMD;", ";;"])(
    "reports an unresolved command for a bare file with PATHEXT %j",
    async (pathext) => {
      await withWindowsFiles(["runner"], (binDir) => {
        expect(() =>
          resolveSafeChildProcessInvocation({
            argv: ["runner"],
            env: { PATH: binDir, PATHEXT: pathext },
          }),
        ).toThrow(/spawn runner ENOENT/);
      });
    },
  );

  it("requires an explicit relative path for executables in the child cwd", async () => {
    await withWindowsFiles(["tool.exe"], (cwd) => {
      expect(() =>
        resolveSafeChildProcessInvocation({
          argv: ["tool.exe"],
          cwd,
          env: { PATH: "", PATHEXT: ".EXE" },
        }),
      ).toThrow(/ENOENT/);
    });
  });

  it("accepts explicit executable paths independently of PATHEXT", async () => {
    await withWindowsFiles(["tool.exe"], (cwd) => {
      const executable = path.join(cwd, "tool.exe");
      expect(
        resolveSafeChildProcessInvocation({
          argv: [executable],
          cwd,
          env: { PATH: "", PATHEXT: ".CMD;.BAT" },
        }).command,
      ).toBe(executable);
    });
  });

  it("resolves PATH and PATHEXT keys case-insensitively", async () => {
    await withWindowsFiles(["tool.exe"], (binDir) => {
      expect(
        resolveSafeChildProcessInvocation({
          argv: ["tool"],
          env: { path: binDir, pathext: ".EXE" },
        }).command,
      ).toBe(path.join(binDir, "tool.exe"));
    });
  });

  it("accepts PATH executables with explicit extensions independently of PATHEXT", async () => {
    await withWindowsFiles(["tool.exe"], (binDir) => {
      expect(
        resolveSafeChildProcessInvocation({
          argv: ["tool.exe"],
          env: { PATH: binDir, PATHEXT: ".CMD;.BAT" },
        }).command,
      ).toBe(path.join(binDir, "tool.exe"));
    });
  });

  it("honors PATHEXT precedence before package-manager shim fallback", async () => {
    await withWindowsFiles(["pnpm.exe", "pnpm.cmd"], (binDir) => {
      expect(
        resolveSafeChildProcessInvocation({
          argv: ["pnpm", "--version"],
          env: { PATH: binDir, PATHEXT: ".EXE;.CMD" },
        }),
      ).toMatchObject({
        args: ["--version"],
        command: path.join(binDir, "pnpm.exe"),
        usesWindowsExitCodeShim: false,
      });
    });
  });
});

describe.runIf(process.platform === "win32")("Windows batch argv preservation", () => {
  const cases = [
    { name: "ordinary arguments", args: ["alpha", "omega"] },
    { name: "spaces", args: ["two words", "omega"] },
    { name: "a leading empty argument", args: ["", "omega"] },
    { name: "a middle empty argument", args: ["alpha", "", "omega"] },
    { name: "a trailing empty argument", args: ["alpha", ""] },
    { name: "an embedded tab", args: ["two\twords", "omega"] },
    { name: "a tab-only argument", args: ["\t", "omega"] },
    { name: "double quotes", args: ['say "hello"', "omega"] },
    { name: "a caret", args: ["left^right", "omega"] },
    { name: "a quoted trailing backslash", args: ["C:\\two words\\", "omega"] },
    { name: "a caret beside a quote", args: ['left^"right', "omega"] },
    { name: "a backslash before a quote", args: ['left\\"right', "omega"] },
    { name: "two backslashes before a quote", args: ['left\\\\"right', "omega"] },
    {
      name: "permitted cmd punctuation",
      args: ["(round)", "[square]", "{curly}", "semi;colon", "eq=sign", "comma,value", "bang!"],
    },
  ];

  it.each([
    ...cases.map((testCase) => ({ ...testCase, file: "argv with ^caret.cmd" })),
    ...["argv.cmd", "argv with spaces.cmd"].map((file) => ({
      name: "ordinary arguments",
      args: ["alpha", "omega"],
      file,
    })),
  ])(
    "preserves $name through $file",
    async ({ args, file }) => {
      await withTempDir("openclaw-batch-argv-", async (cwd) => {
        const command = path.join(cwd, file);
        await writeFile(
          path.join(cwd, "argv.cjs"),
          "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
        );
        await writeFile(command, `@"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
        const result = await runCommandWithTimeout([command, ...args], { cwd, timeoutMs: 5_000 });
        expect(result.code).toBe(0);
        expect(result.termination).toBe("exit");
        expect(JSON.parse(result.stdout)).toEqual(args);
      });
    },
    15_000,
  );

  it.each(["argv.cmd", "argv with spaces.cmd", "argv^caret.cmd", "node.exe"])(
    "preserves literal arguments through a real PTY running %s",
    async (file) => {
      await withTempDir("openclaw-batch-argv-pty-", async (cwd) => {
        const args =
          file === "node.exe"
            ? ["alpha", "", "two words", "two\twords", "A&B", "100%", "left|right", "<in", ">out"]
            : cases.flatMap((testCase) => testCase.args);
        const script = path.join(cwd, "argv.cjs");
        const output = path.join(cwd, "received.json");
        await writeFile(
          script,
          'require("node:fs").writeFileSync(require("node:path").join(__dirname, "received.json"), JSON.stringify(process.argv.slice(2)))',
        );
        const command = file === "node.exe" ? process.execPath : path.join(cwd, file);
        if (file !== "node.exe") {
          await writeFile(command, `@"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
        }
        const pty = await spawnTerminalPty({
          file: command,
          args: file === "node.exe" ? [script, ...args] : args,
          cwd,
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
          cols: 120,
          rows: 24,
        });
        let exitCode: number | undefined;
        pty.onExit((event) => {
          exitCode = event.exitCode;
        });
        try {
          await vi.waitFor(() => expect(exitCode).toBe(0), { timeout: 5_000 });
          expect(JSON.parse(await readFile(output, "utf8"))).toEqual(args);
        } finally {
          if (exitCode === undefined) {
            pty.kill();
          }
        }
      });
    },
    15_000,
  );

  it.each(["&", "|", "<", ">", "%", "\r", "\n"])(
    "continues to reject unsafe batch argument character %j before launch",
    async (character) => {
      await withTempDir("openclaw-batch-argv-reject-", async (cwd) => {
        const command = path.join(cwd, "argv.cmd");
        await writeFile(command, "@exit /b 99\r\n");
        await expect(
          runCommandWithTimeout([command, `left${character}right`], { cwd, timeoutMs: 5_000 }),
        ).rejects.toThrow("Unsafe Windows cmd.exe argument detected");
      });
    },
  );
});
