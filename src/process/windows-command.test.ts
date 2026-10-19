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

function resolveCommand(argv: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  return resolveSafeChildProcessInvocation({ argv, env, cwd });
}

async function writeArgvFixture(cwd: string, file: string, script: string) {
  await writeFile(path.join(cwd, "argv.cjs"), script);
  const command = path.join(cwd, file);
  await writeFile(command, `@"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
  return command;
}

describe("Windows command helpers", () => {
  it("leaves Linux commands unchanged", () => {
    expect(
      resolveWindowsCommandShim({
        command: "pnpm",
        platform: "linux",
        cmdCommands: ["corepack", "pnpm", "npm"],
      }),
    ).toBe("pnpm");
  });

  it("resolves relative executables against the child cwd", async () => {
    await withWindowsFiles(["bin/tool.exe"], (cwd) => {
      expect(resolveCommand(["./bin/tool"], { PATHEXT: ".EXE" }, cwd).command).toBe(
        path.join(cwd, "bin", "tool.exe"),
      );
    });
  });

  it("resolves bare executables from PATH without allowing child-cwd shadowing", async () => {
    await withWindowsFiles(["cwd/tool.exe", "bin/tool.exe"], (base) => {
      const binDir = path.join(base, "bin");
      expect(
        resolveCommand(["tool.exe"], { PATH: binDir, PATHEXT: ".EXE" }, path.join(base, "cwd"))
          .command,
      ).toBe(path.join(binDir, "tool.exe"));
    });
  });

  it("reports an unresolved command for a bare file with trailing-empty PATHEXT", async () => {
    await withWindowsFiles(["runner"], (binDir) => {
      expect(() => resolveCommand(["runner"], { PATH: binDir, PATHEXT: ".EXE;.CMD;" })).toThrow(
        /spawn runner ENOENT/,
      );
    });
  });

  it("requires an explicit relative path for executables in the child cwd", async () => {
    await withWindowsFiles(["tool.exe"], (cwd) => {
      expect(() => resolveCommand(["tool.exe"], { PATH: "", PATHEXT: ".EXE" }, cwd)).toThrow(
        /ENOENT/,
      );
    });
  });

  it("accepts explicit executable paths independently of PATHEXT", async () => {
    await withWindowsFiles(["tool.exe"], (cwd) => {
      const executable = path.join(cwd, "tool.exe");
      expect(resolveCommand([executable], { PATH: "", PATHEXT: ".CMD;.BAT" }, cwd).command).toBe(
        executable,
      );
    });
  });

  it("honors PATHEXT precedence before package-manager shim fallback", async () => {
    await withWindowsFiles(["pnpm.exe", "pnpm.cmd"], (binDir) => {
      expect(
        resolveCommand(["pnpm", "--version"], { PATH: binDir, PATHEXT: ".EXE;.CMD" }),
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
        const command = await writeArgvFixture(
          cwd,
          file,
          "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
        );
        const result = await runCommandWithTimeout([command, ...args], { cwd, timeoutMs: 5_000 });
        expect(result).toMatchObject({ code: 0, termination: "exit" });
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
        const source =
          'require("node:fs").writeFileSync(require("node:path").join(__dirname, "received.json"), JSON.stringify(process.argv.slice(2)))';
        let command = process.execPath;
        if (file === "node.exe") {
          await writeFile(script, source);
        } else {
          command = await writeArgvFixture(cwd, file, source);
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
