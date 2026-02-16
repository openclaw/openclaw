import fs from "node:fs/promises";
import type { RuntimeEnv } from "../runtime.js";

type RuntimeLike = Pick<RuntimeEnv, "log" | "error" | "exit">;

export type NonInteractiveRuntime = {
  log: RuntimeLike["log"];
  error: RuntimeLike["error"];
  exit: RuntimeLike["exit"];
};

const NON_INTERACTIVE_DEFAULT_OPTIONS = {
  nonInteractive: true,
  skipHealth: true,
  skipChannels: true,
  json: true,
} as const;

export function createThrowingRuntime(): NonInteractiveRuntime {
  return {
    log: () => {},
    error: (msg: string) => {
      throw new Error(msg);
    },
    exit: (code: number) => {
      throw new Error(`exit:${code}`);
    },
  };
}

export async function runNonInteractiveOnboarding(
  options: Record<string, unknown>,
  runtime: NonInteractiveRuntime,
): Promise<void> {
  const { runNonInteractiveOnboarding: run } = await import("./onboard-non-interactive.js");
  await run(options, runtime);
}

export async function runNonInteractiveOnboardingWithDefaults(
  runtime: NonInteractiveRuntime,
  options: Record<string, unknown>,
): Promise<void> {
  await runNonInteractiveOnboarding(
    {
      ...NON_INTERACTIVE_DEFAULT_OPTIONS,
      ...options,
    },
    runtime,
  );
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}
