import { expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { classifyPackageUpdatePermissionFailure } from "./package-update-manager-preflight.js";
import { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
import { failedUpdateRun } from "./update-failure-report.test-support.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";

const context = { env: { HOME: "/home/example" }, stateDir: "/npm-report-state" };
type FailureStep = Awaited<ReturnType<typeof runStep>>;
function failureReport(step: FailureStep) {
  return prepareUpdateFailureReport(
    failedUpdateRun({
      runId: "npm-fixture",
      reason: "global-install-failed",
      target: { kind: "package", installationMethod: "npm-global" },
      steps: updateRunStepsFromResultStep(step),
    }),
    context,
  );
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
    // Assembled at runtime so secret scanners do not flag the synthetic credential URL.
    ["npm ERR! registry https://example-user", "synthetic-password@registry.example.test/pkg"].join(
      ":",
    ),
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
  const report = await failureReport(step);
  expect(report.body).toContain(`npm failure code: ${code ?? "unknown"}`);
  // npm's own lines stay in the local record; the public report has the code and remedy only.
  expect(report.body).not.toContain("npm ERR!");
  expect([report.body, JSON.stringify(step.failureFacts)].join("\n")).not.toMatch(
    /npm_synthetic|\/home\/example|private directory|example-user|synthetic-password|unrelated warning/u,
  );
  if (code) {
    expect(report.body).toContain("Next step: Check the npm global prefix");
  }
  if (code) {
    const classified = await classifyPackageUpdatePermissionFailure(
      step,
      { manager: "npm", command: "npm", globalRoot: process.cwd(), packageRoot: process.cwd() },
      context.env,
    );
    const classifiedReport = await failureReport(classified);
    expect(classifiedReport.body).toContain("npm failure code: EACCES");
    expect(classifiedReport.body).not.toContain("npm ERR!");
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
  const report = await failureReport(step);
  expect(report.body).toContain(guidance);
  expect(report.body).not.toMatch(/npm error |PRIVATE_IDENTIFIER|\ufffd/u);
});

it.each([
  {
    name: "package-install",
    code: "ETARGET",
    spec: "openclaw@2026.11.10",
    shown: "openclaw@2026.11.10",
  },
  { name: "global update", code: "ETARGET", spec: "file-type@22.1.1", shown: undefined },
  { name: "package-install", code: "E404", spec: "@example/dependency@*", shown: undefined },
  { name: "package-install", code: "E404", spec: "openclaw@acme-canary", shown: "openclaw" },
])("reports actionable $name $code facts for $spec", async ({ name, code, spec, shown }) => {
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
  const report = await failureReport({ ...step, name });
  expect(report.body).toContain("npm cache verify");
  expect(report.body).toContain("registry/mirror");
  // Only OpenClaw's own package, at a release version or channel, is known public.
  expect(report.body).toContain(
    `Failed phase package-install: exit 1 (${code}${shown ? ` ${shown}` : ""})`,
  );
  expect(report.body).toContain(`npm view ${shown ?? "<spec>"} version`);
  if (shown !== spec) {
    expect(report.body).not.toContain(spec);
  }
  expect(report.body).not.toMatch(/\[redacted-command\]|private\.invalid|\/private\/install/u);
});

it.each([
  {
    leak: "private registry URL with a token",
    secret: /npm_SyntheticToken|registry\.acme-internal|deploy:/u,
    lines: [
      "npm error code E401",
      [
        "npm error 401 Unauthorized - GET https://deploy",
        "npm_SyntheticToken123@registry.acme-internal.example/openclaw",
      ].join(":"),
    ],
  },
  {
    leak: "private scoped package",
    secret: /acme-internal|billing-sdk/u,
    lines: [
      "npm error code E404",
      "npm error 404 Not Found - GET https://registry.npmjs.org/@acme-internal%2fbilling-sdk - Not found",
      "npm error 404  '@acme-internal/billing-sdk@1.2.3' is not in this registry.",
    ],
  },
  {
    leak: "home path",
    secret: /jdoe|\.npm-global|\/Users\//u,
    lines: ["npm error code EACCES", "npm error path /Users/jdoe/.npm-global/lib/node_modules"],
  },
  {
    leak: "hostname",
    secret: /buildbox-acme/u,
    lines: [
      "npm error code EAI_AGAIN",
      "npm error request to http://buildbox-acme:4873/openclaw failed, reason: getaddrinfo EAI_AGAIN buildbox-acme",
    ],
  },
  {
    leak: "email",
    secret: /jdoe|acme\.example/u,
    lines: [
      "npm error code EEXIST",
      "npm error This command requires you to be logged in as jdoe at acme.example (jdoe@acme.example).",
    ],
  },
])("keeps npm output with a $leak out of the public report", async ({ secret, lines }) => {
  const step = await installStep(async () => failedOutput(lines.join("\n")));
  const report = await failureReport(step);
  const code = lines[0]?.split(" ").at(-1);
  expect(report.body).toContain(`npm failure code: ${code}`);
  expect(report.body).not.toMatch(secret);
});
