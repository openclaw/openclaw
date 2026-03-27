import { describe, expect, test } from "vitest";
import { resolveExecWrapperTrustPlan } from "./exec-wrapper-trust-plan.js";

describe("resolveExecWrapperTrustPlan", () => {
  test("unwraps dispatch wrappers and shell multiplexers into one trust plan", () => {
    if (process.platform === "win32") {
      return;
    }
    expect(
      resolveExecWrapperTrustPlan(["/usr/bin/time", "-p", "busybox", "sh", "-lc", "echo hi"]),
    ).toEqual({
      argv: ["sh", "-lc", "echo hi"],
      policyArgv: ["busybox", "sh", "-lc", "echo hi"],
      wrapperChain: ["time", "busybox"],
      policyBlocked: false,
      shellWrapperExecutable: true,
      shellInlineCommand: "echo hi",
    });
  });

  test("unwraps script wrappers before evaluating nested shell payloads", () => {
    if (process.platform === "win32") {
      return;
    }
    expect(
      resolveExecWrapperTrustPlan(["/usr/bin/script", "-q", "/dev/null", "sh", "-lc", "echo hi"]),
    ).toEqual({
      argv: ["sh", "-lc", "echo hi"],
      policyArgv: ["sh", "-lc", "echo hi"],
      wrapperChain: ["script"],
      policyBlocked: false,
      shellWrapperExecutable: true,
      shellInlineCommand: "echo hi",
    });
  });

  test("fails closed for unsupported shell multiplexer applets", () => {
    expect(resolveExecWrapperTrustPlan(["busybox", "sed", "-n", "1p"])).toEqual({
      argv: ["busybox", "sed", "-n", "1p"],
      policyArgv: ["busybox", "sed", "-n", "1p"],
      wrapperChain: [],
      policyBlocked: true,
      blockedWrapper: "busybox",
      shellWrapperExecutable: false,
      shellInlineCommand: null,
    });
  });

  test("fails closed when outer-wrapper depth overflows", () => {
    expect(
      resolveExecWrapperTrustPlan(["nohup", "timeout", "5s", "busybox", "sh", "-lc", "echo hi"], 2),
    ).toEqual({
      argv: ["busybox", "sh", "-lc", "echo hi"],
      policyArgv: ["busybox", "sh", "-lc", "echo hi"],
      wrapperChain: ["nohup", "timeout"],
      policyBlocked: true,
      blockedWrapper: "busybox",
      shellWrapperExecutable: false,
      shellInlineCommand: null,
    });
  });

  test("keeps the blocked dispatch argv as the policy target after transparent unwraps", () => {
    if (process.platform === "win32") {
      return;
    }
    expect(
      resolveExecWrapperTrustPlan([
        "/usr/bin/time",
        "-p",
        "/usr/bin/env",
        "FOO=bar",
        "sh",
        "-lc",
        "echo hi",
      ]),
    ).toEqual({
      argv: ["/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"],
      policyArgv: ["/usr/bin/env", "FOO=bar", "sh", "-lc", "echo hi"],
      wrapperChain: [],
      policyBlocked: true,
      blockedWrapper: "env",
      shellWrapperExecutable: false,
      shellInlineCommand: null,
    });
  });
});
