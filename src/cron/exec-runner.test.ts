import process from "node:process";
import { describe, expect, it } from "vitest";
import { runCronExec } from "./exec-runner.js";

function quoteArg(value: string) {
  return JSON.stringify(value);
}

function buildNodeCommand(source: string) {
  return `${quoteArg(process.execPath)} -e ${quoteArg(source)}`;
}

describe("runCronExec", () => {
  it("captures stdout and stderr for successful commands", async () => {
    const result = await runCronExec({
      payload: {
        kind: "exec",
        command: buildNodeCommand(
          "process.stdout.write('hello\\n'); process.stderr.write('warn\\n');",
        ),
      },
    });

    expect(result.status).toBe("ok");
    expect(result.error).toBeUndefined();
    expect(result.summary).toContain("Command exited with code 0.");
    expect(result.summary).toContain("stdout:\nhello");
    expect(result.summary).toContain("stderr:\nwarn");
  });

  it("reports non-zero exits as errors", async () => {
    const result = await runCronExec({
      payload: {
        kind: "exec",
        command: buildNodeCommand(
          "process.stdout.write('before-fail\\n'); process.stderr.write('boom\\n'); process.exit(7);",
        ),
      },
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron exec command exited with code 7");
    expect(result.summary).toContain("Command exited with code 7.");
    expect(result.summary).toContain("stdout:\nbefore-fail");
    expect(result.summary).toContain("stderr:\nboom");
  });

  it("kills commands that exceed the payload timeout", async () => {
    const result = await runCronExec({
      payload: {
        kind: "exec",
        command: buildNodeCommand("setTimeout(() => process.stdout.write('late'), 10_000);"),
        timeout: 50,
      },
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("cron exec command timed out after 50ms");
    expect(result.summary).toContain("Command timed out after 50ms.");
  });

  it("supports shell execution when requested", async () => {
    const result = await runCronExec({
      payload: {
        kind: "exec",
        shell: true,
        command: `${quoteArg(process.execPath)} -e ${quoteArg("process.stdout.write('shell-ok')")}`,
      },
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toContain("stdout:\nshell-ok");
  });
});
