import { expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { classifyPackageUpdatePermissionFailure } from "./package-update-manager-preflight.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";

const context = { env: { HOME: "/home/example" }, stateDir: "/npm-report-state" };
type FailureStep = Awaited<ReturnType<typeof runStep>>;
type FailureResult = Parameters<typeof prepareUpdateFailureReport>[0]["result"];
function failureReport(step: FailureStep, recorded: boolean, extra: Partial<FailureResult> = {}) {
  const attemptId = "npm-fixture";
  const result: FailureResult = {
    mode: "npm",
    status: "error",
    durationMs: 1,
    steps: recorded ? [] : [step],
    ...extra,
  };
  const recordedRun = recorded
    ? { runId: attemptId, steps: updateRunStepsFromResultStep(step) }
    : undefined;
  return prepareUpdateFailureReport({ attemptId, result, recordedRun }, context);
}
function failedOutput(text: string, stream: "stdout" | "stderr" = "stderr") {
  return { code: 1, stdout: "", stderr: "", [stream]: text };
}
function installStep(
  runCommand: Parameters<typeof runStep>[0]["runCommand"],
  overrides: Partial<Parameters<typeof runStep>[0]> = {},
) {
  return runStep({
    name: "package-install",
    argv: ["npm", "install", "-g", "openclaw"],
    cwd: process.cwd(),
    env: context.env,
    runCommand,
    stepIndex: 0,
    totalSteps: 1,
    ...overrides,
  });
}

it.each(["EACCES", undefined])("reports spawned npm diagnostics (%s)", async (code) => {
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
  const step = await installStep((_argv, options) =>
    runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        "process.stderr.write(process.argv[1]); process.exitCode = 1",
        stderr,
      ],
      options,
    ),
  );
  expect(step.exitCode).toBe(1);
  expect(step.failureFacts?.[0]).toMatchObject({ check: "npm", code: code ?? "unknown" });
  for (const recorded of [false, true]) {
    const report = await failureReport(step, recorded, { reason: "global-install-failed" });
    expect(report.body).toContain(`npm failure code: ${code ?? "unknown"}`);
    expect(report.body).toContain("npm ERR! install failed while preparing package");
    expect(report.body).toContain("[redacted-path]");
    expect([report.body, JSON.stringify(step.failureFacts)].join("\n")).not.toMatch(
      /npm_synthetic|\/home\/example|private directory|example-user|synthetic-password|unrelated warning/u,
    );
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
    const report = await failureReport(classified, false);
    expect(report.body).toContain("npm failure code: EACCES");
    expect(report.body).toContain("npm ERR! install failed while preparing package");
  }
});

it.each([
  ["ENOSPC", "Free disk space"],
  ["E404", "Run npm cache verify"],
  ["ETARGET", "Run npm cache verify"],
  ["ECONNRESET", "npm failure code: ECONNRESET"],
  ["PRIVATE_IDENTIFIER", "npm failure code: unknown"],
])("bounds the first five npm lines for %s", async (code, guidance) => {
  const cause = "npm error install failed while preparing package: ";
  const longCause = `${cause}${"🦞".repeat(200)}`;
  const exactLimit = `npm error ${"x".repeat(190)}`;
  const fifth = "npm error retained fifth diagnostic";
  // 50 ASCII bytes + 33 four-byte characters + the 15-byte marker fit in 200 bytes.
  const truncated = `${cause}${"🦞".repeat(33)} …[truncated]`;
  const diagnostics = [
    `npm error code ${code}`,
    longCause,
    exactLimit,
    `npm error token=${"fixture-only-secret".repeat(30)}`,
    fifth,
    "npm error sixth diagnostic",
  ].join("\n");
  const step = await installStep(async () => failedOutput(diagnostics, "stdout"), {
    name: "package-install-omit-optional",
  });
  const messages = step.failureFacts?.map((fact) => fact.message) ?? [];
  expect(messages).toEqual([
    `npm error code ${code === "PRIVATE_IDENTIFIER" ? "unknown" : code}`,
    truncated,
    exactLimit,
    expect.stringMatching(/^npm error token=/u),
    fifth,
  ]);
  for (const message of messages) {
    expect(Buffer.byteLength(message ?? "")).toBeLessThanOrEqual(200);
  }
  expect(messages.slice(2, 4).join("\n")).not.toContain(" …[truncated]");
  const excerpt = messages.join("\n");
  expect(excerpt).not.toMatch(/fixture-only-secret|omitted|sixth diagnostic/u);
  for (const recorded of [false, true]) {
    const report = await failureReport(step, recorded);
    expect(report.body).toContain(guidance);
    for (const line of [messages[0], truncated, exactLimit, fifth]) {
      expect(report.body).toContain(`- ${line}\n`);
    }
    expect(report.body).toMatch(/^- npm error token=[^\n]+$/mu);
    expect(report.body).not.toMatch(/fixture-only-secret|PRIVATE_IDENTIFIER|\ufffd/u);
  }
});

it.each([
  { name: "package-install", code: "ETARGET", spec: "file-type@22.1.1" },
  { name: "global update", code: "ETARGET", spec: "file-type@22.1.1" },
  { name: "package-install", code: "E404", spec: "@example/dependency@*" },
])("reports actionable $name $code facts for $spec", async ({ name, code, spec }) => {
  const step = await installStep(
    async () =>
      failedOutput(
        [
          `npm error code ${code}`,
          code === "ETARGET"
            ? `npm error notarget No matching version found for ${spec}.`
            : `npm error 404 '${spec}' is not in this registry.`,
          "trailing output\n".repeat(800),
        ].join("\n"),
      ),
    {
      argv: ["npm", "install", "-g", "openclaw@latest", "--registry=https://private.invalid"],
      cwd: "/private/install",
    },
  );
  expect(step.failureFacts?.[0]).toMatchObject({ npmErrorCode: code, packageSpec: spec });
  expect(step.stderrTail).not.toContain(code);
  const legacyReport = await failureReport(
    { ...step, name: "[redacted-command]", failureFacts: undefined, stderrTail: "" },
    false,
    { reason: "global-install-failed" },
  );
  expect(legacyReport.body).toContain("Failed phase [redacted-command]: exit 1");
  for (const recorded of [false, true]) {
    const report = await failureReport({ ...step, name }, recorded, {
      reason: "global-install-failed",
    });
    expect(report.body).toContain(`Failed phase package-install: exit 1 (${code} ${spec})`);
    expect(report.body).toContain("npm cache verify");
    expect(report.body).toContain("registry/mirror");
    expect(report.body).toContain(`npm view ${spec.includes("*") ? `'${spec}'` : spec} version`);
    expect(report.body).not.toMatch(/\[redacted-command\]|private\.invalid|\/private\/install/u);
  }
});
