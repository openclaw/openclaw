// Regression test for #92103: registerLazyCommand preserves Commander exit codes
// when lazy reparse throws a usage error (e.g., unknown option).
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerLazyCommand } from "./register-lazy-command.js";

describe("registerLazyCommand exit code preservation", () => {
  let originalExitCode: number | undefined;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("preserves Commander non-zero exit code when reparse fails with unknown option (#92103)", async () => {
    expect.assertions(3);

    const program = new Command();
    // Mirror the exitOverride pattern from build-program.ts
    program.exitOverride((err) => {
      process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
      throw err;
    });

    registerLazyCommand({
      program,
      name: "test-cmd",
      description: "Test lazy command",
      options: [{ flags: "--known", description: "Known option" }],
      register: async () => {
        program
          .command("test-cmd")
          .description("Real test command")
          .option("--verbose", "Verbose output")
          .action(() => {});
      },
    });

    // Invoke with an unknown option — Commander exitOverride sets exitCode=1 and throws.
    // Without the fix, the lazy wrapper's re-throw would lose the exitCode.
    const parsePromise = program.parseAsync(
      ["node", "openclaw", "test-cmd", "--unknown-flag"],
      { from: "user" },
    );

    await expect(parsePromise).rejects.toMatchObject({
      code: expect.stringMatching(/^commander\./) as unknown,
    });

    // The fix ensures process.exitCode survives the lazy reparse catch/rethrow.
    expect(process.exitCode).toBe(1);
    expect(typeof process.exitCode).toBe("number");
  });

  it("preserves exitCode for lazy command with different unknown option pattern", async () => {
    expect.assertions(3);

    const program = new Command();
    program.exitOverride((err) => {
      process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
      throw err;
    });

    // Simulate a plugin CLI pattern: placeholder with allowUnknownOption,
    // real command rejects the unknown flag on reparse.
    registerLazyCommand({
      program,
      name: "plugin-cmd",
      description: "Plugin lazy command",
      options: [{ flags: "--name <string>", description: "Plugin name" }],
      register: async () => {
        program
          .command("plugin-cmd")
          .description("Real plugin command")
          .option("--verbose", "Verbose output")
          .action(() => {});
      },
    });

    const parsePromise = program.parseAsync(
      ["node", "openclaw", "plugin-cmd", "--bogus-flag"],
      { from: "user" },
    );

    await expect(parsePromise).rejects.toMatchObject({
      code: expect.stringMatching(/^commander\./) as unknown,
    });

    expect(process.exitCode).toBe(1);
    expect(typeof process.exitCode).toBe("number");
  });
});
