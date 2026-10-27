import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { delimiter, join } from "node:path";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
let bin: string;
beforeAll(() => {
  bin = dirs.make("mobile-store-routing-");
  // The diagnostics wrapper spawns pnpm outside the workflow's Bash process.
  fs.writeFileSync(join(bin, "pnpm"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
});

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Scenario = {
  event?: string;
  schedule?: string;
  operation?: string;
  enabled?: string;
  destination?: "testflight" | "app-store" | "internal" | "play-store";
  qualify?: boolean;
  qualificationResult?: "success" | "failure" | "cancelled" | "skipped";
  cancelled?: boolean;
  screenshots?: boolean;
  ref?: string;
  repository?: string;
};
type Workflow = {
  "run-name": string;
  on: {
    schedule: Array<{ cron: string; timezone: string }>;
    workflow_dispatch: { inputs: { operation: { default: string; options: string[] } } };
  };
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: {
    qualify: { if: string };
    release: { if: string; needs: string; environment: string; steps: WorkflowStep[] };
    screenshots: { if: string };
  };
};

function scheduledScenarios(destination: "app-store" | "play-store"): Scenario[] {
  return [
    { destination: destination === "app-store" ? "testflight" : "internal" },
    { enabled: "" },
    { enabled: "false" },
    ...["true", "false", ""].map((enabled) => ({
      schedule: "0 11 * * 1",
      enabled,
      destination,
      qualify: true,
    })),
    ...(["failure", "cancelled", "skipped"] as const).map((qualificationResult) => ({
      schedule: "0 11 * * 1",
      qualify: true,
      qualificationResult,
    })),
    { schedule: "0 12 * * 1" },
    ...[{ ref: "refs/heads/candidate" }, { repository: "example/fork" }].map((change) => ({
      schedule: "0 11 * * 1",
      ref: change.ref,
      repository: change.repository,
    })),
  ];
}

function failedManualScenarios(schedule?: string): Scenario[] {
  return (["failure", "cancelled", "skipped"] as const).map((qualificationResult) => ({
    event: "workflow_dispatch",
    operation: "release",
    schedule,
    qualify: true,
    qualificationResult,
  }));
}

function manual(operation: string, fields: Scenario = {}): Scenario {
  return { event: "workflow_dispatch", operation, ...fields };
}

function loadWorkflow(platform: string) {
  const workflow = parse(
    fs.readFileSync(`.github/workflows/${platform}-store-release.yml`, "utf8"),
  ) as Workflow;
  expect(workflow.on.schedule).toEqual([
    { cron: "0 7 * * *", timezone: "America/Los_Angeles" },
    { cron: "0 11 * * 1", timezone: "America/Los_Angeles" },
  ]);
  expect(workflow.concurrency).toMatchObject({
    group: `${platform}-release`,
    "cancel-in-progress": false,
  });
  expect(workflow.jobs.release.needs).toBe("qualify");
  return workflow;
}

function scenarioEvaluator(scenario: Scenario, variables: Record<string, string>, ios = false) {
  const qualificationResult =
    scenario.qualificationResult ?? (scenario.qualify ? "success" : "skipped");
  const context = {
    github: {
      event_name: scenario.event ?? "schedule",
      event: { schedule: scenario.schedule ?? "0 7 * * *" },
      ref: scenario.ref ?? "refs/heads/main",
      repository: scenario.repository ?? "openclaw/openclaw",
    },
    inputs: { operation: scenario.operation ?? "" },
    vars: variables,
    needs: { qualify: { result: qualificationResult } },
    cancelled: () => scenario.cancelled ?? qualificationResult === "cancelled",
    success: () => qualificationResult === "success",
    always: () => true,
    ...(ios
      ? {
          failure: () => qualificationResult === "failure",
          format: (template: string, operation: string) => template.replace("{0}", operation),
        }
      : {}),
  };
  return (expression: string): unknown =>
    runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/gu, ""), context);
}

function assertAdmission(
  workflow: Workflow,
  scenario: Scenario,
  evaluate: (expression: string) => unknown,
) {
  expect(Boolean(evaluate(workflow.jobs.qualify.if)), JSON.stringify(scenario)).toBe(
    scenario.qualify ?? false,
  );
  // GitHub adds success() unless the condition includes a status function.
  const condition = workflow.jobs.release.if;
  const releaseCondition = /\b(always|cancelled|failure|success)\s*\(/u.test(condition)
    ? condition
    : `success() && (${condition})`;
  expect(Boolean(evaluate(releaseCondition)), JSON.stringify(scenario)).toBe(
    Boolean(scenario.destination),
  );
}

function assertUpload(
  upload: WorkflowStep,
  platform: string,
  destination: string,
  evaluate: (expression: string) => unknown,
) {
  const expression = expectDefined(
    upload.env?.[`${platform.toUpperCase()}_RELEASE_DESTINATION`],
    "release destination",
  );
  const output = execFileSync(
    "bash",
    ["-c", ["gh() { :; }", expectDefined(upload.run, "release upload command")].join("\n")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
        [`${platform.toUpperCase()}_RELEASE_DESTINATION`]: String(evaluate(expression)),
        RUNNER_TEMP: "/synthetic-runner-temp",
      },
    },
  );
  expect(output.trim().split("\n")).toEqual([
    `${platform}:release:upload`,
    "--",
    "--destination",
    destination,
    "--recovery-dir",
    `/synthetic-runner-temp/${platform}-release-recovery`,
  ]);
}

it.each(["ios", "android"])("routes %s daily and qualified weekly/manual releases", (platform) => {
  const ios = platform === "ios";
  const daily = ios ? "testflight" : "internal";
  const store = ios ? "app-store" : "play-store";
  const workflow = loadWorkflow(platform);
  const release = workflow.jobs.release;
  const findStep = (name: string) =>
    expectDefined(
      release.steps.find((step) => step.name === name),
      name,
    );
  const upload = findStep(`Prepare and upload ${ios ? "iOS" : "Android"} release`);
  if (!ios) {
    expect(upload.env?.ANDROID_SCREENSHOT_DIAGNOSTICS).toBe("1");
    expect(workflow.on.workflow_dispatch.inputs.operation).toMatchObject({
      default: "release",
      options: ["release", "internal"],
    });
  }
  const scenarios: Scenario[] = [
    ...scheduledScenarios(store),
    manual(daily, { enabled: "false", destination: daily }),
    manual(ios ? "release" : workflow.on.workflow_dispatch.inputs.operation.default, {
      enabled: "false",
      destination: store,
      qualify: true,
    }),
    ...failedManualScenarios(ios ? undefined : "0 11 * * 1"),
    ...(ios
      ? [
          ...["schedule", "workflow_dispatch"].map((event) => ({
            event,
            operation: event === "schedule" ? "" : daily,
            cancelled: true,
          })),
          manual("screenshots", { screenshots: true, ref: "refs/heads/candidate" }),
          manual(daily, { ref: "refs/heads/candidate" }),
          { repository: "example/fork" },
        ]
      : [
          { schedule: "0 11 * * 1", qualify: true, cancelled: true },
          manual("unknown"),
          ...["schedule", "workflow_dispatch"].flatMap((event) => [
            { event, operation: daily, ref: "refs/heads/candidate" },
            { event, operation: daily, repository: "example/fork" },
          ]),
        ]),
    { event: "push", operation: ios ? "release" : daily },
  ];
  for (const scenario of scenarios) {
    const evaluate = scenarioEvaluator(
      scenario,
      {
        [ios ? "IOS_TESTFLIGHT_ENABLED" : "ANDROID_INTERNAL_ENABLED"]: scenario.enabled ?? "true",
        OPENCLAW_TESTFLIGHT_GROUP_ID: "external-group-id",
      },
      ios,
    );
    assertAdmission(workflow, scenario, evaluate);
    if (ios) {
      expect(Boolean(evaluate(workflow.jobs.screenshots.if))).toBe(scenario.screenshots ?? false);
    }
    if (!scenario.destination) {
      continue;
    }
    const storeRelease = scenario.destination === store;
    expect(evaluate(workflow["run-name"].slice(ios ? 4 : 8))).toBe(
      !storeRelease
        ? ios
          ? "TestFlight distribution"
          : "Internal testing distribution"
        : (scenario.event ?? "schedule") === "schedule"
          ? "Store release (weekly)"
          : "Store release",
    );
    expect(evaluate(release.environment)).toBe(
      storeRelease ? `${platform}-store-release` : `${platform}-${daily}`,
    );
    if (ios) {
      const group = expectDefined(
        upload.env?.OPENCLAW_TESTFLIGHT_GROUP_ID,
        "TestFlight group expression",
      );
      expect(evaluate(group)).toBe("external-group-id");
    } else {
      for (const name of [
        "Prepare trusted Linux Android tooling",
        "Retain screenshot diagnostics",
      ]) {
        expect(Boolean(evaluate(findStep(name).if ?? "true"))).toBe(storeRelease);
      }
      const emulators = expectDefined(
        findStep("Setup Android toolchain").with?.["install-screenshot-emulators"],
        "screenshot emulator selection",
      );
      expect(evaluate(String(emulators))).toBe(String(storeRelease));
    }
    assertUpload(upload, platform, scenario.destination, evaluate);
  }
});
