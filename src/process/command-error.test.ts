import { expect, it } from "vitest";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { createCommandError, formatCommandOutput, formatCommandResult } from "./command-error.js";
import type { SpawnResult } from "./exec-result.js";

const failure: SpawnResult = createCommandResult({
  code: 124,
  killed: true,
  termination: "timeout",
});

function exited(overrides: Partial<SpawnResult>): SpawnResult {
  return { ...failure, code: 23, killed: false, termination: "exit", ...overrides };
}
const errorFor = (
  result: Parameters<typeof createCommandError>[1],
  command = "setup",
  timeoutMs = 3_000,
) => createCommandError(command, result, { timeoutMs });

it("bounds labels and diagnostic tails without splitting surrogate pairs", () => {
  const command = `\u001b[31m${"x".repeat(254)}\r\n🦞${"y".repeat(300)}\u001b[0m`;
  const stderr = `${"x".repeat(100)}🦞${"y".repeat(1999)}`;
  const error = errorFor({ ...failure, stderr }, command, 120_000);

  const [label, detail] = error.message.split(" failed (timed out after 120 seconds):\n");
  expect(label).toBe(`${"x".repeat(254)} `);
  expect(detail).toBe(`…\n${"y".repeat(1999)}`);
});

it("sanitizes terminal controls without flattening logical lines", () => {
  const error = errorFor(
    exited({
      stdout: "recovery",
      stderr: " \t\u001b[31mstale\r\tfinal\tfield\u0007\u007f\u0085\nnext\u001b[0m\t \n",
    }),
  );
  const detail = error.message.slice(error.message.indexOf(":\n") + 2);
  expect(detail).toBe("stderr: final\\tfield\nnext\nstdout: recovery");
});

it("keeps independent recent stream tails within the existing error budget", () => {
  const error = errorFor(
    exited({
      stdout: `${"old output\n".repeat(30)}${"x".repeat(3000)}\nstdout recovery 🦞`,
      stderr: `${"old warning\n".repeat(30)}${"y".repeat(3000)}\nwarning detail 🦞`,
    }),
    "worktree setup",
    120_000,
  );
  const detail = error.message.slice(error.message.indexOf(":\n") + 2);
  expect(detail).toMatch(/^stderr: …\ny+\nwarning detail 🦞\nstdout: …\nx+\nstdout recovery 🦞$/u);
  expect(detail.length).toBeLessThanOrEqual(2_000);
  expect(error.message.length).toBeLessThan(2300);
});

it("keeps buffered errors without exit metadata", () => {
  const error = errorFor({
    ...failure,
    code: null,
    killed: false,
    termination: "error",
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
  expect(error.message).toBe("setup failed");
});

it("keeps tiny output caps surrogate-safe", () => {
  expect(formatCommandOutput("🦞", 1)).toBe("…\n");
});

it("retains a short already-omitted tail alongside the other stream", () => {
  const error = errorFor(
    exited({
      stderr: Array.from({ length: 13 }, (_, index) => `note ${index}`).join("\n"),
      stdout: "recovery",
    }),
  );
  expect(error.message).toBe(
    `setup failed (exit code 23):\nstderr: …\n${Array.from({ length: 12 }, (_, i) => `note ${i + 1}`).join("\n")}\nstdout: recovery`,
  );
});

it("does not widen the result stdout cap for a single stream", () => {
  const result = formatCommandResult("command", exited({ stdout: "x".repeat(1_600) }));
  expect(result).toContain("stdout:");
  expect(result).not.toContain("x".repeat(801));
  expect(result).toContain("…");
});

it("keeps timeout ahead of an output-limit flag", () => {
  const error = errorFor({ ...failure, code: null, outputLimitExceeded: true });
  expect(error.message).toBe("setup failed (timed out after 3 seconds)");
});
