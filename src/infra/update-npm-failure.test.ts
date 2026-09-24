import { describe, expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { classifyPackageUpdatePermissionFailure } from "./package-update-manager-preflight.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";

const context = { env: { HOME: "/home/example" }, stateDir: "/npm-report-state" };

describe("npm install failure reports", () => {
  it.each(["EACCES", undefined])(
    "retains spawned npm diagnostics in direct and recorded reports (code=%s)",
    async (code) => {
      const token = `npm_${"synthetic".repeat(5)}`;
      const stderr = [
        "npm warn unrelated warning",
        ...(code ? [`npm ERR! code ${code}`] : []),
        "npm ERR! install failed while preparing package",
        "npm ERR! path /home/example/private directory/package",
        `npm ERR! token=${token}`,
        "npm ERR! registry https://example-user:synthetic-password@registry.example.test/pkg",
        "npm ERR! omitted line",
      ].join("\n");
      const step = await runStep({
        name: "package-install",
        argv: [
          process.execPath,
          "-e",
          "process.stderr.write(process.argv[1]); process.exitCode = 1",
          stderr,
        ],
        cwd: process.cwd(),
        env: context.env,
        runCommand: runCommandWithTimeout,
        stepIndex: 0,
        totalSteps: 1,
      });
      expect(step.exitCode).toBe(1);
      expect(step.failureFacts?.[0]).toMatchObject({ check: "npm", code: code ?? "unknown" });
      for (const recorded of [false, true]) {
        const report = await prepareUpdateFailureReport(
          {
            attemptId: "npm-fixture",
            result: {
              mode: "npm",
              status: "error",
              reason: "global-install-failed",
              durationMs: 1,
              steps: recorded ? [] : [step],
            },
            ...(recorded
              ? { recordedRun: { runId: "npm-fixture", steps: updateRunStepsFromResultStep(step) } }
              : {}),
          },
          context,
        );
        expect(report.body).toContain(`npm failure code: ${code ?? "unknown"}`);
        expect(report.body).toContain("npm ERR! install failed while preparing package");
        expect(report.body).toContain("[redacted-path]");
        for (const privateText of [
          token,
          "/home/example",
          "private directory",
          "example-user",
          "synthetic-password",
          "unrelated warning",
        ]) {
          expect(report.body).not.toContain(privateText);
          expect(JSON.stringify(step.failureFacts)).not.toContain(privateText);
        }
        if (code) {
          expect(report.body).toContain("Next step: Check the npm global prefix");
        }
      }
      if (code) {
        const classified = await classifyPackageUpdatePermissionFailure(
          step,
          { manager: "npm", command: "npm", globalRoot: process.cwd(), packageRoot: process.cwd() },
          context.env,
        );
        const report = await prepareUpdateFailureReport(
          {
            attemptId: "npm-permission",
            result: { mode: "npm", status: "error", durationMs: 1, steps: [classified] },
          },
          context,
        );
        expect(report.body).toContain("npm failure code: EACCES");
        expect(report.body).toContain("npm ERR! install failed while preparing package");
      }
    },
  );

  it.each([
    ["ENOSPC", "Free disk space"],
    ["E404", "Check the configured npm registry"],
    ["ETARGET", "Check the configured npm registry"],
    ["ECONNRESET", "npm failure code: ECONNRESET"],
    ["PRIVATE_IDENTIFIER", "npm failure code: unknown"],
  ])("bounds the first five npm lines for %s", async (code, guidance) => {
    const cause = "npm error install failed while preparing package: ";
    const longCause = `${cause}${"🦞".repeat(200)}`;
    const exactLimit = `npm error ${"x".repeat(190)}`;
    const secret = "fixture-only-secret".repeat(30);
    const fifth = "npm error retained fifth diagnostic";
    const marker = " …[truncated]";
    const step = await runStep({
      name: "package-install-omit-optional",
      argv: ["npm", "install", "-g", "openclaw"],
      cwd: process.cwd(),
      env: context.env,
      runCommand: async () => ({
        code: 1,
        stderr: "",
        stdout: [
          `npm error code ${code}`,
          longCause,
          exactLimit,
          `npm error token=${secret}`,
          fifth,
          "npm error sixth diagnostic",
        ].join("\n"),
      }),
      stepIndex: 0,
      totalSteps: 1,
    });
    const messages = step.failureFacts?.map((fact) => fact.message) ?? [];
    expect(messages).toEqual([
      `npm error code ${code === "PRIVATE_IDENTIFIER" ? "unknown" : code}`,
      expect.stringContaining(cause),
      exactLimit,
      expect.stringMatching(/^npm error token=/u),
      fifth,
    ]);
    const truncated = messages[1] ?? "";
    expect(truncated.endsWith(marker)).toBe(true);
    expect(longCause.startsWith(truncated.slice(0, -marker.length))).toBe(true);
    expect(Buffer.byteLength(truncated)).toBeGreaterThan(196);
    for (const message of messages) {
      expect(Buffer.byteLength(message ?? "")).toBeLessThanOrEqual(200);
    }
    expect(messages[2]).not.toContain(marker);
    expect(messages[3]).not.toContain(marker);
    const excerpt = messages.join("\n");
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(1024);
    expect(excerpt).not.toContain("fixture-only-secret");
    expect(excerpt).not.toContain("omitted");
    expect(excerpt).not.toContain("sixth diagnostic");
    for (const recorded of [false, true]) {
      const report = await prepareUpdateFailureReport(
        {
          attemptId: "npm-bound",
          result: { mode: "npm", status: "error", steps: recorded ? [] : [step], durationMs: 1 },
          ...(recorded
            ? { recordedRun: { runId: "npm-bound", steps: updateRunStepsFromResultStep(step) } }
            : {}),
        },
        context,
      );
      expect(report.body).toContain(guidance);
      for (const line of [messages[0], truncated, exactLimit, fifth]) {
        expect(report.body).toContain(`- ${line}\n`);
      }
      expect(report.body).toMatch(/^- npm error token=[^\n]+$/mu);
      expect(report.body).not.toContain("fixture-only-secret");
      expect(report.body).not.toContain("PRIVATE_IDENTIFIER");
      expect(report.body).not.toContain("\ufffd");
    }
  });
});
