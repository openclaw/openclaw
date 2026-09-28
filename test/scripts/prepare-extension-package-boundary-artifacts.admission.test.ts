import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { runSemanticCheck } from "../../scripts/lib/semantic-check-admission.mts";
import {
  createPrefixedOutputWriter,
  runNodeStep,
  runNodeStepsInParallel,
} from "../../scripts/prepare-extension-package-boundary-artifacts.mts";
import { createDeferred } from "../helpers/promise.js";

vi.mock("../../scripts/lib/semantic-check-admission.mts", () => ({
  runSemanticCheck: vi.fn(),
}));
beforeEach(() => vi.mocked(runSemanticCheck).mockReset().mockResolvedValue(0));
afterEach(() => vi.restoreAllMocks());

const steps = ["first", "second"].map((label) => ({
  label,
  args: [label],
  timeoutMs: 5_000,
  semantic: true,
}));

it("joins one admitted compiler before starting its sibling even through the parallel API", async () => {
  const entered = createDeferred();
  const release = createDeferred<number>();
  vi.mocked(runSemanticCheck).mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const running = runNodeStepsInParallel(steps);
  try {
    await entered.promise;
    expect(runSemanticCheck).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(0);
    await running;
  }
  expect(vi.mocked(runSemanticCheck).mock.calls.map(([command]) => command.args)).toEqual([
    ["first"],
    ["second"],
  ]);
});

it("stops a declaration batch on its first compiler failure", async () => {
  vi.mocked(runSemanticCheck).mockResolvedValueOnce(137);
  await expect(runNodeStepsInParallel(steps)).rejects.toThrow("first failed with exit code 137");
  expect(runSemanticCheck).toHaveBeenCalledTimes(1);
});

it.each(["", "\n"])(
  "rejects oversized output without flushing it after failure (suffix=%j)",
  (suffix) => {
    const write = vi.fn();
    const writer = createPrefixedOutputWriter("boundary", { write });
    expect(() => writer.write("x".repeat(64 * 1024 + 1) + suffix)).toThrow("output line exceeded");
    writer.flush();
    expect(write).not.toHaveBeenCalled();
  },
);

it("retains an unjoined compiler error when stdout flush fails and still drains stderr", async () => {
  const unjoined = Object.assign(new Error("compiler cleanup unverified"), {
    processTreeState: "indeterminate",
  });
  vi.mocked(runSemanticCheck).mockImplementationOnce(async (options) => {
    const child = new ChildProcess();
    Object.defineProperties(child, {
      stdout: { value: new PassThrough() },
      stderr: { value: new PassThrough() },
    });
    options.onReady?.(child);
    child.stdout!.emit("data", "unfinished stdout");
    child.stderr!.emit("data", "unfinished stderr");
    throw unjoined;
  });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => {
    throw new Error("output sink failed");
  });
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const error = await runNodeStep("compiler", [], 5_000, { semantic: true }).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect(hasUnjoinedWork(error)).toBe(true);
    expect(stderr).toHaveBeenCalledWith("[compiler] unfinished stderr");
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});
