import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect } from "vitest";
import { listDirectoryTreeStrict } from "../src/infra/directory-walk.js";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

// Literal commands have no shell quoting; retain argv arrays for empty or spaced values.
export function cliCase<T extends object>(command: string | string[], details: T) {
  const args = typeof command === "string" ? command.split(" ") : command;
  return { name: args.join(" "), args, ...details };
}

export const ttySource = [
  'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });',
  'Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
];

export const withCliHome = (run: (home: string) => Promise<void>) =>
  withTempHome(run, { prefix: "openclaw-json-contract-" });

export function isolatedEnv(home: string) {
  return {
    OPENCLAW_CONFIG_PATH: path.join(home, "missing-openclaw.json"),
    OPENCLAW_STATE_DIR: path.join(home, "isolated-state"),
  };
}

export function expectCleanOutput(stdout: string, stderr?: string) {
  expect(stdout.includes("\u001B") || stdout.includes("\u0007"), stderr).toBe(false);
}

export const expectCliError = (stdout: string, message: unknown) =>
  expect(JSON.parse(stdout)).toEqual({ ok: false, error: { type: "cli_error", message } });

export async function expectMissing(...paths: string[]) {
  for (const file of paths) {
    await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

export async function expectOnlyLoggingState(stateDir: string) {
  const root = await fs.lstat(stateDir).catch((error: unknown) => {
    expect(error).toMatchObject({ code: "ENOENT" });
  });
  if (!root) {
    return;
  }
  expect(root.isDirectory(), stateDir).toBe(true);

  // Validation errors may log, but must not bootstrap config or operational state.
  const uid = process.getuid?.();
  const fallback = path.join("tmp", `openclaw${uid === undefined ? "" : `-${uid}`}`);
  const logRoots = new Set(["logs", fallback]);
  const directories = new Set(["tmp", ...logRoots]);
  for (const { relativePath: relative, dirent } of await listDirectoryTreeStrict(stateDir)) {
    if (dirent.isDirectory()) {
      expect(directories.has(relative), relative).toBe(true);
    } else {
      expect(dirent.isFile(), relative).toBe(true);
      expect(logRoots.has(path.dirname(relative)), relative).toBe(true);
      expect(path.basename(relative)).toMatch(
        /^openclaw(?:-[a-z0-9-]+)?-\d{4}-\d{2}-\d{2}(?:\.[1-5])?\.log$/u,
      );
    }
  }
}

export function expectFailure(
  result: ReturnType<typeof runBuiltCli>,
  message: string,
  options: Partial<Record<"human" | "tty" | "cleanHuman" | "once" | "network", boolean>> = {},
) {
  expect(result.status, result.stderr).toBe(1);
  const { stdout, stderr } = result;
  if (!options.human || options.cleanHuman) {
    expectCleanOutput(stdout, stderr);
  }
  if (options.human) {
    expect(stdout).toBe("");
  } else {
    expectCliError(stdout, message);
  }
  expect(stderr).toContain(message);
  if (options.once) {
    expect(stderr.split(message)).toHaveLength(2);
  }
  if (options.network) {
    expect(stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
  }
  if (options.tty) {
    expect(stderr).toContain("\u001B[?25h");
  }
}

export const writeJson = (file: string, value: unknown, newline = false) =>
  fs.writeFile(file, JSON.stringify(value) + (newline ? "\n" : ""), "utf8");

export const preloadArgs = (source: string[]) => [
  `--import=data:text/javascript;base64,${Buffer.from(source.join("\n")).toString("base64")}`,
];

export function runIsolatedCli(
  home: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    source?: string[];
  } & Partial<Record<"tty" | "commander" | "inheritEnvironment", boolean>> = {},
) {
  const { env, source = [], tty, commander, inheritEnvironment } = options;
  const preload = [...source, ...(tty ? ttySource : [])];
  const execArgv = options.source || tty ? preloadArgs(preload) : [];
  const environment = {
    ...isolatedEnv(home),
    ...(commander ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
    ...(tty ? { FORCE_COLOR: "1" } : {}),
    ...env,
  };
  return runBuiltCli(home, args, environment, { inheritEnvironment, execArgv });
}
