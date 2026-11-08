import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
import { testRunnerFixtureEnv } from "./prepared-script-wrapper.test-support.js";

export const repoRoot = path.resolve(import.meta.dirname, "../..");

export function scriptFiles(root: string) {
  const resolve = (...parts: string[]) => path.join(root, ...parts);
  const read = (file: string) => fs.readFileSync(resolve(file), "utf8");
  return {
    path: resolve,
    read,
    json: (file: string) => JSON.parse(read(file)),
    jsonLines: (file: string) =>
      read(file)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    write: (file: string, source: string) => fs.writeFileSync(resolve(file), source),
    linkModules: () =>
      fs.symlinkSync(path.join(repoRoot, "node_modules"), resolve("node_modules"), "junction"),
  };
}

export function cleanRunnerEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = testRunnerFixtureEnv();
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST") || key.startsWith("OPENCLAW_")) {
      delete env[key];
    }
  }
  return { ...env, ...overrides };
}

export function captureOutput(...streams: Readable[]) {
  let text = "";
  for (const stream of streams) {
    stream.on("data", (chunk: string | Buffer) => {
      text += String(chunk);
    });
  }
  return {
    get text() {
      return text;
    },
  };
}

export function childTermination(child: ChildProcess, event: "exit" | "close" = "close") {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once(event, (code: number | null, signal: NodeJS.Signals | null) =>
      resolve({ code, signal }),
    );
    child.once("error", reject);
  });
}

export function captureWatchdog<T>(start: () => T) {
  // Only the watchdog retains this clock; native I/O and process joins use real timers.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { clock } = setTimeout as typeof setTimeout & { clock: { tick(ms: number): void } };
  try {
    return { handle: start(), clock };
  } finally {
    vi.useRealTimers();
  }
}

export function waitAtGate<T>(
  gate: PromiseLike<T>,
  completion: PromiseLike<unknown>,
  signal: AbortSignal,
  message: string,
) {
  return withinTest(awaitGateBeforeSettlement(gate, completion, message), signal);
}
