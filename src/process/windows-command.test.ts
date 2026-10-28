import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import { runCommandWithTimeout } from "./exec.js";
import { spawnTerminalPty } from "./terminal-pty.js";
import { resolveSafeChildProcessInvocation, resolveWindowsCommandShim } from "./windows-command.js";

const windowsIt = it.extend<{ cwd: string }>({
  cwd: async ({ task: _task }, use) =>
    withTempDir("openclaw-windows-command-", async (cwd) => {
      const files = ["bin/tool.exe", "cwd/tool.exe", "tool.exe", "runner", "pnpm.exe", "pnpm.cmd"];
      await Promise.all(["bin", "cwd"].map((dir) => mkdir(path.join(cwd, dir))));
      await Promise.all(files.map((file) => writeFile(path.join(cwd, file), "")));
      await withMockedWindowsPlatform(() => use(cwd));
    }),
});

function resolveCommand(argv: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  return resolveSafeChildProcessInvocation({ argv, env, cwd });
}

const stdoutScript = "process.stdout.write(JSON.stringify(process.argv.slice(2)))";
async function writeArgvFixture(cwd: string, file: string, script = stdoutScript) {
  await writeFile(path.join(cwd, "argv.cjs"), script);
  const command = path.join(cwd, file);
  if (file !== "node.exe") {
    await writeFile(command, `@"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
  }
  return file === "node.exe" ? process.execPath : command;
}

it("leaves Linux commands unchanged", () => {
  using platform = vi.spyOn(process, "platform", "get");
  platform.mockReturnValue("linux");
  expect(resolveWindowsCommandShim({ command: "pnpm", cmdCommands: ["pnpm"] })).toBe("pnpm");
});

type Dir = string | undefined;
type Resolution = [string, string, string, Dir, Dir, string | RegExp];
const resolutions: Resolution[] = [
  ["relative suffix probing", "./bin/tool", ".EXE", undefined, ".", "bin/tool.exe"],
  ["PATH beats child cwd", "tool.exe", ".EXE", "bin", "cwd", "bin/tool.exe"],
  ["extensionless PATH file", "runner", ".EXE;.CMD;", ".", undefined, /spawn runner ENOENT/],
  ["no implicit cwd search", "tool.exe", ".EXE", "", ".", /ENOENT/],
];
for (const [name, command, PATHEXT, searchDir, childDir, expected] of resolutions) {
  windowsIt(name, ({ cwd }) => {
    const env: NodeJS.ProcessEnv = { PATHEXT };
    if (searchDir !== undefined) {
      env.PATH = searchDir ? path.join(cwd, searchDir) : "";
    }
    const childCwd = childDir === undefined ? undefined : path.join(cwd, childDir);
    const run = () => resolveCommand([command], env, childCwd);
    if (expected instanceof RegExp) {
      expect(run).toThrow(expected);
    } else {
      expect(run().command).toBe(path.join(cwd, expected));
    }
  });
}

windowsIt("explicit paths ignore PATHEXT", ({ cwd }) => {
  const exe = path.join(cwd, "tool.exe");
  expect(resolveCommand([exe], { PATH: "", PATHEXT: ".CMD;.BAT" }, cwd).command).toBe(exe);
});

windowsIt("honors PATHEXT precedence before package-manager shim fallback", ({ cwd }) => {
  expect(resolveCommand(["pnpm", "--version"], { PATH: cwd, PATHEXT: ".EXE;.CMD" })).toMatchObject({
    args: ["--version"],
    command: path.join(cwd, "pnpm.exe"),
    usesWindowsExitCodeShim: false,
  });
});

windowsIt("preserves trailing cwd whitespace for relative PATH", async ({ cwd }) => {
  const childCwd = path.join(cwd, "cwd ");
  await mkdir(childCwd, { recursive: true });
  await writeFile(path.join(childCwd, "tool.exe"), "");
  expect(resolveCommand(["tool.exe"], { PATH: ".", PATHEXT: ".EXE" }, childCwd).command).toBe(
    path.join(childCwd, "tool.exe"),
  );
});

windowsIt("uses process cwd for blank cwd and relative PATH", ({ cwd }) => {
  using cwdSpy = vi.spyOn(process, "cwd");
  cwdSpy.mockReturnValue(cwd);
  expect(resolveCommand(["tool.exe"], { PATH: "bin", PATHEXT: ".EXE" }, "   ").command).toBe(
    path.join(cwd, "bin", "tool.exe"),
  );
});

describe.runIf(process.platform === "win32")("Windows batch argv preservation", () => {
  const args = [
    ["", "alpha", "", "two words", "two\twords", "\t", 'say "hello"'],
    ["left^right", "C:\\two words\\", 'left^"right', 'left\\"right', 'left\\\\"right'],
    [
      "(round)",
      "[square]",
      "{curly}",
      "semi;colon",
      "eq=sign",
      "comma,value",
      "bang!",
      "omega",
      "",
    ],
  ].flat();
  it.each(["argv.cmd", "argv with spaces.cmd", "argv with ^caret.cmd"])(
    "preserves literal, empty and quoted argv through %s",
    (file) =>
      withTempDir("openclaw-batch-argv-", async (cwd) => {
        const command = await writeArgvFixture(cwd, file);
        const result = await runCommandWithTimeout([command, ...args], { cwd, timeoutMs: 5_000 });
        expect(result).toMatchObject({ code: 0, termination: "exit" });
        expect(JSON.parse(result.stdout)).toEqual(args);
      }),
    15_000,
  );

  it.each(["argv.cmd", "argv with spaces.cmd", "argv^caret.cmd", "node.exe"])(
    "preserves literal arguments through a real PTY running %s",
    (file) =>
      withTempDir("openclaw-batch-argv-pty-", async (cwd) => {
        const ptyArgs =
          file === "node.exe"
            ? ["alpha", "", "two words", "two\twords", "A&B", "100%", "left|right", "<in", ">out"]
            : args;
        const script = path.join(cwd, "argv.cjs");
        const output = path.join(cwd, "received.json");
        const source =
          'require("node:fs").writeFileSync(require("node:path").join(__dirname, "received.json"), JSON.stringify(process.argv.slice(2)))';
        const command = await writeArgvFixture(cwd, file, source);
        const entries = Object.entries(process.env).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        );
        const pty = await spawnTerminalPty({
          file: command,
          args: file === "node.exe" ? [script, ...ptyArgs] : ptyArgs,
          cwd,
          env: Object.fromEntries(entries),
          cols: 120,
          rows: 24,
        });
        let exitCode: number | undefined;
        pty.onExit((event) => {
          exitCode = event.exitCode;
        });
        try {
          await vi.waitFor(() => expect(exitCode).toBe(0), { timeout: 5_000 });
          expect(JSON.parse(await readFile(output, "utf8"))).toEqual(ptyArgs);
        } finally {
          if (exitCode === undefined) {
            pty.kill();
          }
        }
      }),
    15_000,
  );

  it.each(["&", "|", "<", ">", "%", "\r", "\n"])(
    "continues to reject unsafe batch argument character %j before launch",
    (character) =>
      withTempDir("openclaw-batch-argv-reject-", async (cwd) => {
        const command = path.join(cwd, "argv.cmd");
        await writeFile(command, "@exit /b 99\r\n");
        await expect(
          runCommandWithTimeout([command, `left${character}right`], { cwd, timeoutMs: 5_000 }),
        ).rejects.toThrow("Unsafe Windows cmd.exe argument detected");
      }),
  );
});
