import { expect } from "vitest";
import type { CommandOptions, SpawnResult } from "../process/exec.js";
import { npmCommandArgs } from "./npm-command.js";

function failure(label: string, overrides: Partial<SpawnResult>, expectedDetail: string) {
  return { label, npmResult: createCommandResult({ code: 1, ...overrides }), expectedDetail };
}

export const npmCommandFailureCases = [
  failure(
    "stderr before stdout",
    { stderr: " registry unavailable ", stdout: "ignored" },
    "registry unavailable",
  ),
  failure(
    "stdout when stderr is blank",
    { stderr: " ", stdout: " registry unavailable " },
    "registry unavailable",
  ),
  failure("exit code without output", {}, "exit code 1 (no output from npm)"),
  failure(
    "signal without output",
    { code: null, signal: "SIGKILL", killed: true, termination: "signal" },
    "signal SIGKILL (no output from npm)",
  ),
  failure(
    "abort before spawn",
    { code: null, termination: "signal" },
    "termination signal (no output from npm)",
  ),
  failure(
    "cancellation followed by a nonzero exit",
    { termination: "signal", killed: true },
    "termination signal (no output from npm)",
  ),
  ...(["timeout", "no-output-timeout"] as const).map((termination) =>
    failure(
      `${termination} with normalized exit code`,
      { code: 124, signal: "SIGTERM", killed: true, termination },
      `termination ${termination} (no output from npm)`,
    ),
  ),
];

type NpmViewMetadata = {
  name: string;
  version: string;
  integrity?: string;
  shasum?: string;
};
type CommandMock = {
  mockImplementation: (
    implementation: (
      argv: string[],
      optionsOrTimeout: number | CommandOptions,
    ) => Promise<SpawnResult>,
  ) => unknown;
};

// Keep command doubles shaped like the real process helper across install and update tests.
export function createCommandResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

export function mockNpmViewMetadataResult(run: CommandMock, metadata: NpmViewMetadata) {
  // Preserve the command callback's arity even though view does not inspect options.
  run.mockImplementation(async (argv, _options) => {
    if (npmCommandArgs(argv)?.[0] !== "view") {
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    }
    const { name, version, integrity, shasum } = metadata;
    return createCommandResult({
      stdout: JSON.stringify({ name, version, dist: { integrity, shasum } }),
    });
  });
}

export function expectIntegrityDriftRejected(params: {
  onIntegrityDrift: (...args: unknown[]) => unknown;
  result: { ok: boolean; error?: string };
  expectedIntegrity: string;
  actualIntegrity: string;
}) {
  expect(params.onIntegrityDrift).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedIntegrity: params.expectedIntegrity,
      actualIntegrity: params.actualIntegrity,
    }),
  );
  expect(params.result).toMatchObject({
    ok: false,
    error: expect.stringContaining("integrity drift"),
  });
}
