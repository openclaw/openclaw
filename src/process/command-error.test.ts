import { describe, expect, it } from "vitest";
import { createCommandError, formatCommandOutput, formatCommandResult } from "./command-error.js";
import type { SpawnResult } from "./exec-result.js";

const failure: SpawnResult = {
  stdout: "",
  stderr: "",
  code: 124,
  signal: null,
  killed: true,
  termination: "timeout",
};

describe("createCommandError", () => {
  it("bounds labels and diagnostic tails without splitting surrogate pairs", () => {
    const command = `\u001b[31m${"x".repeat(254)}\r\n🦞${"y".repeat(300)}\u001b[0m`;
    const stderr = `${"x".repeat(100)}🦞${"y".repeat(1999)}`;
    const error = createCommandError(command, { ...failure, stderr }, { timeoutMs: 120_000 });

    const [label, detail] = error.message.split(" failed (timed out after 120 seconds):\n");
    expect(label).toBe(`${"x".repeat(254)} `);
    expect(detail).toBe(`…\n${"y".repeat(1999)}`);
  });
});

it("sanitizes terminal controls without flattening logical lines", () => {
  const error = createCommandError(
    "worktree setup",
    {
      ...failure,
      code: 23,
      killed: false,
      termination: "exit",
      stdout: "recovery",
      stderr: " \t\u001b[31mstale\r\tfinal\tfield\u0007\u007f\u0085\nnext\u001b[0m\t \n",
    },
    { timeoutMs: 120_000 },
  );
  const detail = error.message.slice(error.message.indexOf(":\n") + 2);
  expect(detail).toBe("stderr: final\\tfield\nnext\nstdout: recovery");
});

it("keeps independent recent stream tails within the existing error budget", () => {
  const error = createCommandError(
    "worktree setup",
    {
      ...failure,
      code: 23,
      killed: false,
      termination: "exit",
      stdout: `${"old output\n".repeat(30)}${"x".repeat(3000)}\nstdout recovery 🦞`,
      stderr: `${"old warning\n".repeat(30)}${"y".repeat(3000)}\nwarning detail 🦞`,
    },
    { timeoutMs: 120_000 },
  );
  expect(error.message).toContain("stdout recovery 🦞");
  expect(error.message).toContain("warning detail 🦞");
  expect(error.message).not.toContain("old output");
  expect(error.message).not.toContain("old warning");
  expect(error.message).toContain(":\n");
  const detail = error.message.slice(error.message.indexOf(":\n") + 2);
  expect(detail).toMatch(/^stderr: …\n/u);
  expect(detail).toContain("\nstdout: …\n");
  expect(detail.length).toBeLessThanOrEqual(2_000);
  expect(detail).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  expect(detail).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  expect(error.message.length).toBeLessThan(2300);
});

// Buffered capture/launch failures carry an error termination, sometimes with an exit code.
it("keeps buffered errors without exit metadata", () => {
  const error = createCommandError(
    "setup",
    {
      ...failure,
      code: null,
      killed: false,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      termination: "error",
    },
    { timeoutMs: 3_000 },
  );
  expect(error.message).toBe("setup failed");
});

it("keeps tiny output caps surrogate-safe", () => {
  expect(formatCommandOutput("🦞", 1)).toBe("…\n");
});

it("retains a short already-omitted tail alongside the other stream", () => {
  const error = createCommandError(
    "setup",
    {
      ...failure,
      code: 23,
      killed: false,
      termination: "exit",
      stderr: Array.from({ length: 13 }, (_, index) => `note ${index}`).join("\n"),
      stdout: "recovery",
    },
    { timeoutMs: 3_000 },
  );
  expect(error.message).toContain("stderr: …\nnote 1\n");
  expect(error.message).not.toContain("note 0\n");
  expect(error.message).toContain("note 12\nstdout: recovery");
  expect(error.message.match(/…/g)).toHaveLength(1);
});

it("does not widen the result stdout cap for a single stream", () => {
  const result = formatCommandResult("command", {
    ...failure,
    code: 23,
    killed: false,
    termination: "exit",
    stdout: "x".repeat(1_600),
    stderr: "",
  });
  expect(result).toContain("stdout:");
  expect(result).not.toContain("x".repeat(801));
  expect(result).toContain("…");
});

it("keeps timeout ahead of an output-limit flag", () => {
  const error = createCommandError(
    "setup",
    {
      ...failure,
      code: null,
      termination: "timeout",
      outputLimitExceeded: true,
    },
    { timeoutMs: 3_000 },
  );
  expect(error.message).toBe("setup failed (timed out after 3 seconds)");
});
