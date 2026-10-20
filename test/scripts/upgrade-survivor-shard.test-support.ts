import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
export const readJsonLines = <T>(file: string): T[] =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
export const writeJson = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value));
export const writeExecutable = (file: string, source: string) =>
  writeFileSync(file, source, { mode: 0o755 });

export function runProcess(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeout?: number,
) {
  return spawnSync(command, args, { encoding: "utf8", env, timeout });
}

export function successSummary(
  baseline: string,
  candidate: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    status: "passed",
    baseline: { spec: `openclaw@${baseline}`, version: baseline },
    candidate: { kind: "tarball", version: candidate },
    scenario: "legacy-operator-state",
    installedVersion: candidate,
    candidateInstallMode: "updater",
    updateRestartMode: "manual",
    updateOutcome: "success",
    phases: [],
    ...overrides,
  };
}
