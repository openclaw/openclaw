import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Tests that command-exec skill dispatch passes user args safely as
 * positional parameters ($1) rather than interpolating them into
 * the shell command string.  This prevents shell injection from
 * user-supplied skill arguments.
 */
describe("command-exec arg safety", () => {
  // Mirror the exact spawn pattern used in get-reply-inline-actions.ts:
  //   spawnSync("sh", ["-c", commandExec, "--", rawArgs], ...)
  function execCommand(commandExec: string, rawArgs?: string) {
    const spawnArgs = ["-c", commandExec, "--"];
    if (rawArgs) {
      spawnArgs.push(rawArgs);
    }
    return spawnSync("sh", spawnArgs, {
      encoding: "utf-8",
      timeout: 5_000,
      env: { ...process.env },
    });
  }

  it("passes clean args as $1", () => {
    const result = execCommand('echo "got: $1"', "hello world");
    expect(result.stdout.trim()).toBe("got: hello world");
  });

  it("semicolon injection is treated as literal $1", () => {
    const result = execCommand('echo "got: $1"', "; echo INJECTED");
    expect(result.stdout.trim()).toBe("got: ; echo INJECTED");
    // If injection worked, stdout would have two lines. Verify single line.
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("$(...) subshell injection is treated as literal $1", () => {
    const result = execCommand('echo "got: $1"', "$(echo INJECTED)");
    expect(result.stdout.trim()).toBe("got: $(echo INJECTED)");
  });

  it("pipe injection is treated as literal $1", () => {
    const result = execCommand('echo "got: $1"', "| echo INJECTED");
    expect(result.stdout.trim()).toBe("got: | echo INJECTED");
  });

  it("backtick injection is treated as literal $1", () => {
    const result = execCommand('echo "got: $1"', "`echo INJECTED`");
    expect(result.stdout.trim()).toBe("got: `echo INJECTED`");
  });

  it("runs without args when none provided", () => {
    const result = execCommand('echo "no args"');
    expect(result.stdout.trim()).toBe("no args");
  });
});
