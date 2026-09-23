// Test helper for running Commander commands with captured output.
import { Command } from "commander";
import type { MockFn } from "./vitest-mock-fn.js";

/** Runs a CLI registrar against Commander using user-style argv. */
export async function runRegisteredCli(params: {
  register: (program: Command) => void;
  argv: string[];
}): Promise<void> {
  const program = new Command();
  params.register(program);
  await program.parseAsync(params.argv, { from: "user" });
}

/** Model the outer exit boundary for parser fixtures with an explicitly mocked exit.
 * Resource finalization is exercised by the native CLI lifecycle suites.
 */
export async function runWithMockedCliExit(
  run: () => Promise<unknown>,
  exit: MockFn<(code: number) => void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const { ExitError } = await import("../runtime.js");
    if (!(error instanceof ExitError)) {
      throw error;
    }
    exit(error.code);
  }
}
