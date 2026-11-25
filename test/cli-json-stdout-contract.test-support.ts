import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect } from "vitest";
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
