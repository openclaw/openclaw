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

export function withCliHome(run: (home: string) => Promise<void>) {
  return withTempHome(run, { prefix: "openclaw-json-contract-" });
}

export function isolatedEnv(home: string) {
  return {
    OPENCLAW_CONFIG_PATH: path.join(home, "missing-openclaw.json"),
    OPENCLAW_STATE_DIR: path.join(home, "isolated-state"),
  };
}

export function expectCleanOutput(stdout: string, stderr?: string) {
  expect(stdout, stderr).not.toContain("\u001B");
  expect(stdout, stderr).not.toContain("\u0007");
}

export function expectCliError(stdout: string, message: unknown) {
  expect(JSON.parse(stdout)).toEqual({ ok: false, error: { type: "cli_error", message } });
}

export async function expectMissing(...paths: string[]) {
  for (const file of paths) {
    await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

export function expectFailure(
  result: ReturnType<typeof runBuiltCli>,
  message: string,
  options: {
    human?: boolean;
    tty?: boolean;
    cleanHuman?: boolean;
    once?: boolean;
    network?: boolean;
  } = {},
) {
  expect(result.status, result.stderr).toBe(1);
  if (!options.human || options.cleanHuman) {
    expectCleanOutput(result.stdout, result.stderr);
  }
  if (options.human) {
    expect(result.stdout).toBe("");
  } else {
    expectCliError(result.stdout, message);
  }
  expect(result.stderr).toContain(message);
  if (options.once) {
    expect(result.stderr.split(message)).toHaveLength(2);
  }
  if (options.network) {
    expect(result.stderr).not.toContain("AUTOQA_NETWORK_FORBIDDEN");
  }
  if (options.tty) {
    expect(result.stderr).toContain("\u001B[?25h");
  }
}

export function writeJson(file: string, value: unknown, newline = false) {
  return fs.writeFile(file, JSON.stringify(value) + (newline ? "\n" : ""), "utf8");
}

export function preloadArgs(source: string[]) {
  return [
    `--import=data:text/javascript;base64,${Buffer.from(source.join("\n")).toString("base64")}`,
  ];
}

export function runIsolatedCli(
  home: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    source?: string[];
    tty?: boolean;
    commander?: boolean;
    inheritEnvironment?: boolean;
  } = {},
) {
  return runBuiltCli(
    home,
    args,
    {
      ...isolatedEnv(home),
      ...(options.commander ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
      ...(options.tty ? { FORCE_COLOR: "1" } : {}),
      ...options.env,
    },
    {
      inheritEnvironment: options.inheritEnvironment,
      execArgv:
        options.source || options.tty
          ? preloadArgs([...(options.source ?? []), ...(options.tty ? ttySource : [])])
          : [],
    },
  );
}
