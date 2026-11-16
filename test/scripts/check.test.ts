import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { main, PREFLIGHT_CHECKS, runCommand } from "../../scripts/check.mts";
import * as managed from "../../scripts/lib/managed-child-process.mts";

function runCheck(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/check.mts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

it("prints help without running check stages", () => {
  const result = runCheck("--help");

  expect(result).toMatchObject({ status: 0, stderr: "" });
  expect(result.stdout).toContain("Usage: node --import tsx scripts/check.mts");
  expect(result.stdout).not.toContain("[check]");
});

it("rejects unknown args before running check stages", () => {
  for (const args of [["--bogus"], ["bogus", "--help"]]) {
    const result = runCheck(...args);

    expect(result).toMatchObject({ status: 2, stdout: "" });
    expect(result.stderr).toContain(`unknown argument: ${args[0]}`);
    expect(result.stderr).toContain("Usage: node --import tsx scripts/check.mts");
    expect(result.stderr).not.toContain("[check]");
  }
});

it("runs pnpm commands through the managed child runner", async () => {
  const run = vi.fn<NonNullable<Parameters<typeof runCommand>[1]>>().mockResolvedValue(0);
  const result = await runCommand({ args: ["lint"], name: "lint" }, run);
  expect(run.mock.calls).toEqual([[{ args: ["lint"], bin: "pnpm" }]]);
  expect(result).toMatchObject({ name: "lint", status: 0 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
});

it("passes the selected comparison base through full lint", async () => {
  const run = vi.spyOn(managed, "runManagedCommand").mockResolvedValue(0);
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitCode = process.exitCode;
  try {
    await main(["--base", "fixture-base"]);
    expect(run).toHaveBeenCalledWith({ args: ["lint", "--base", "fixture-base"], bin: "pnpm" });
  } finally {
    run.mockRestore();
    stderr.mockRestore();
    process.exitCode = exitCode;
  }
});

it("keeps script policy guards in the aggregate preflight", () => {
  const exact = (name: string, command: string, usesBase?: true) => ({
    name,
    args: [command],
    ...(usesBase ? { usesBase } : {}),
  });
  expect(PREFLIGHT_CHECKS).not.toContainEqual(
    exact("environment variable count ratchet", "check:env-var-count"),
  );
  expect(PREFLIGHT_CHECKS).toEqual(
    expect.arrayContaining([
      expect.objectContaining(exact("max-lines suppression ratchet", "check:max-lines-ratchet")),
      expect.objectContaining(exact("assertion SAFETY comment ratchet", "check:assertion-safety")),
      exact("test timeout race ratchet", "check:test-timeout-race-ratchet", true),
      exact("first-party mock export ratchet", "check:test-mock-exports", true),
      exact("script TypeScript erasability", "check:script-erasability"),
    ]),
  );
});

it.each([{ flags: [] }, { flags: ["--include-test-types", "--include-architecture"] }])(
  "partitions the full check graph without changing flags or canonical order: $flags",
  async ({ flags }) => {
    const run = vi.spyOn(managed, "runManagedCommand").mockResolvedValue(0);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = process.exitCode;
    const trace = async (...stages: string[]) => {
      run.mockClear();
      await main([
        "--base",
        "fixture-base",
        ...flags,
        ...stages.flatMap((stage) => ["--stage", stage]),
      ]);
      expect(process.exitCode).toBe(0);
      return run.mock.calls.map(([command]) => {
        if (!command.args) {
          throw new Error("Check stages must pass command arguments to the managed runner.");
        }
        return command.args;
      });
    };
    try {
      const full = await trace();
      const nonlint = await trace("policy", "preflight", "typecheck", "preflight");
      const lint = await trace("lint");
      expect(lint).toEqual([["lint", "--base", "fixture-base"], ["format:check"]]);
      expect(nonlint).toEqual(
        full.filter(([command]) => command !== "lint" && command !== "format:check"),
      );
      expect([...nonlint, ...lint].map((args) => JSON.stringify(args)).toSorted()).toEqual(
        full.map((args) => JSON.stringify(args)).toSorted(),
      );
      expect(await trace("policy", "lint", "typecheck", "preflight")).toEqual(full);
      expect(nonlint).toContainEqual([flags.length ? "tsgo:all" : "tsgo:prod"]);
      expect(nonlint).toContainEqual([flags.length ? "check:architecture" : "check:import-cycles"]);
      for (const command of PREFLIGHT_CHECKS.filter((entry) => entry.usesBase)) {
        expect(nonlint).toContainEqual([...command.args, "--base", "fixture-base"]);
      }
    } finally {
      run.mockRestore();
      stderr.mockRestore();
      process.exitCode = exitCode;
    }
  },
);

it.each(
  [["--stage", "missing"], ["--stage", ""], ["--stage"], ["--stage="]].map((args) => ({ args })),
)("rejects invalid stage selection before admitting commands: $args", async ({ args }) => {
  const run = vi.spyOn(managed, "runManagedCommand").mockResolvedValue(0);
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitCode = process.exitCode;
  try {
    await main(args);
    expect(process.exitCode).toBe(2);
    expect(run).not.toHaveBeenCalled();
  } finally {
    run.mockRestore();
    stderr.mockRestore();
    process.exitCode = exitCode;
  }
});

it("stops the selected lane on failure and retains its exit status", async () => {
  const run = vi.spyOn(managed, "runManagedCommand").mockResolvedValue(7);
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const exitCode = process.exitCode;
  try {
    await main(["--stage", "lint", "--stage", "policy"]);
    expect(process.exitCode).toBe(7);
    expect(run.mock.calls).toEqual([[{ args: ["lint"], bin: "pnpm" }]]);
  } finally {
    run.mockRestore();
    stderr.mockRestore();
    process.exitCode = exitCode;
  }
});
