import { describe, expect, it } from "vitest";
import {
  PRECHECK_NO_WORK_REASON,
  cronRunOutcomeFromPrecheck,
  interpretPrecheckOutput,
  normalizeCronJobPrecheck,
  runCronJobPrecheck,
} from "./job-precheck.js";

describe("interpretPrecheckOutput", () => {
  it("treats exit 0 as work and exit 2 as no-work by default", () => {
    expect(interpretPrecheckOutput({ exitCode: 0, stdout: "", stderr: "" }).decision).toBe("run");
    const skip = interpretPrecheckOutput({ exitCode: 2, stdout: "", stderr: "" });
    expect(skip.decision).toBe("skip");
    if (skip.decision === "skip") {
      expect(skip.reason).toBe(PRECHECK_NO_WORK_REASON);
    }
  });

  it("honors WORK_NEEDED / NO_WORK prefixes over exit code", () => {
    expect(
      interpretPrecheckOutput({
        exitCode: 2,
        stdout: "WORK_NEEDED: dirty prs\n",
        stderr: "",
      }).decision,
    ).toBe("run");
    expect(
      interpretPrecheckOutput({
        exitCode: 0,
        stdout: "NO_WORK\n",
        stderr: "",
      }).decision,
    ).toBe("skip");
  });

  it("maps unexpected exits to error (or skip when onError=skip)", () => {
    expect(
      interpretPrecheckOutput({ exitCode: 7, stdout: "", stderr: "boom" }).decision,
    ).toBe("error");
    expect(
      interpretPrecheckOutput({
        exitCode: 7,
        stdout: "",
        stderr: "boom",
        onError: "skip",
      }).decision,
    ).toBe("skip");
  });
});

describe("cronRunOutcomeFromPrecheck", () => {
  it("emits skipped outcome with stable reason for no-work", () => {
    const outcome = cronRunOutcomeFromPrecheck({
      decision: "skip",
      reason: PRECHECK_NO_WORK_REASON,
      exitCode: 2,
      stdout: "NO_WORK",
      stderr: "",
    });
    expect(outcome.status).toBe("skipped");
    expect(outcome.error).toBe(PRECHECK_NO_WORK_REASON);
    expect(outcome.diagnostics?.summary).toBe(PRECHECK_NO_WORK_REASON);
  });
});

describe("normalizeCronJobPrecheck", () => {
  it("requires a command and normalizes kinds", () => {
    expect(normalizeCronJobPrecheck(null)).toBeUndefined();
    expect(normalizeCronJobPrecheck({})).toBeUndefined();
    expect(normalizeCronJobPrecheck({ command: " exit 2 " })).toEqual({
      kind: "exec",
      command: "exit 2",
    });
  });
});

describe("runCronJobPrecheck", () => {
  it("runs a real shell check for exit 2 skip", async () => {
    const result = await runCronJobPrecheck({ command: "exit 2" });
    expect(result.decision).toBe("skip");
  });

  it("runs a real shell check for exit 0 work", async () => {
    const result = await runCronJobPrecheck({ command: "exit 0" });
    expect(result.decision).toBe("run");
  });
});
