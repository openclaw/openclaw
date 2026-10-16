import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

function evaluateWorkflowExpression(expression: string, context: Record<string, unknown>): unknown {
  return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/gu, ""), context);
}

function releaseUploadArguments(upload: WorkflowStep, env: NodeJS.ProcessEnv): string[] {
  return execFileSync(
    "bash",
    [
      "-c",
      [
        "gh() { :; }",
        "pnpm() { printf '%s\\n' \"$@\"; }",
        expectDefined(upload.run, "release upload command"),
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env, ...env, RUNNER_TEMP: "/synthetic-runner-temp" } },
  )
    .trim()
    .split("\n");
}

describe("mobile store release routing", () => {
  it("routes daily TestFlight and qualified weekly/manual App Store releases", () => {
    const workflow = parse(fs.readFileSync(".github/workflows/ios-store-release.yml", "utf8")) as {
      "run-name": string;
      on: { schedule: Array<{ cron: string; timezone: string }> };
      concurrency: { group: string; "cancel-in-progress": boolean };
      jobs: {
        qualify: { if: string };
        release: { if: string; needs: string; environment: string; steps: WorkflowStep[] };
        screenshots: { if: string };
      };
    };
    expect(workflow.on.schedule).toEqual([
      { cron: "0 7 * * *", timezone: "America/Los_Angeles" },
      { cron: "0 11 * * 1", timezone: "America/Los_Angeles" },
    ]);
    expect(workflow.concurrency).toMatchObject({
      group: "ios-release",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs.release.needs).toBe("qualify");
    const upload = expectDefined(
      workflow.jobs.release.steps.find((step) => step.name === "Prepare and upload iOS release"),
      "iOS upload step",
    );
    const uploadEnvironment = expectDefined(upload.env, "iOS upload environment");

    const scenarios: Array<{
      event: string;
      schedule?: string;
      operation: string;
      enabled: string;
      admitted: boolean;
      destination?: "testflight" | "app-store";
      qualify?: boolean;
      qualificationResult?: "success" | "failure" | "cancelled" | "skipped";
      cancelled?: boolean;
      screenshots?: boolean;
      ref?: string;
      repository?: string;
    }> = [
      {
        event: "schedule",
        operation: "",
        enabled: "true",
        admitted: true,
        destination: "testflight",
      },
      { event: "schedule", operation: "", enabled: "", admitted: false },
      { event: "schedule", operation: "", enabled: "false", admitted: false },
      ...["true", "false", ""].map((enabled) => ({
        event: "schedule",
        schedule: "0 11 * * 1",
        operation: "",
        enabled,
        admitted: true,
        destination: "app-store" as const,
        qualify: true,
      })),
      ...(["failure", "cancelled", "skipped"] as const).map((qualificationResult) => ({
        event: "schedule",
        schedule: "0 11 * * 1",
        operation: "",
        enabled: "true",
        qualify: true,
        qualificationResult,
        admitted: false,
      })),
      {
        event: "schedule",
        schedule: "0 12 * * 1",
        operation: "",
        enabled: "true",
        admitted: false,
      },
      ...[{ ref: "refs/heads/candidate" }, { repository: "example/fork" }].map((change) => ({
        event: "schedule",
        schedule: "0 11 * * 1",
        operation: "",
        enabled: "true",
        admitted: false,
        ref: change.ref,
        repository: change.repository,
      })),
      {
        event: "workflow_dispatch",
        operation: "testflight",
        enabled: "false",
        admitted: true,
        destination: "testflight",
      },
      {
        event: "workflow_dispatch",
        operation: "release",
        enabled: "false",
        admitted: true,
        destination: "app-store",
        qualify: true,
      },
      ...(["failure", "cancelled", "skipped"] as const).map((qualificationResult) => ({
        event: "workflow_dispatch",
        operation: "release",
        enabled: "true",
        qualify: true,
        qualificationResult,
        admitted: false,
      })),
      ...["schedule", "workflow_dispatch"].map((event) => ({
        event,
        operation: event === "schedule" ? "" : "testflight",
        enabled: "true",
        cancelled: true,
        admitted: false,
      })),
      {
        event: "workflow_dispatch",
        operation: "screenshots",
        enabled: "true",
        admitted: false,
        screenshots: true,
        ref: "refs/heads/candidate",
      },
      {
        event: "workflow_dispatch",
        operation: "testflight",
        enabled: "true",
        admitted: false,
        ref: "refs/heads/candidate",
      },
      {
        event: "schedule",
        operation: "",
        enabled: "true",
        admitted: false,
        repository: "example/fork",
      },
      { event: "push", operation: "release", enabled: "true", admitted: false },
    ];
    for (const scenario of scenarios) {
      const qualificationResult =
        scenario.qualificationResult ?? (scenario.qualify ? "success" : "skipped");
      const context = {
        github: {
          event_name: scenario.event,
          event: { schedule: scenario.schedule ?? "0 7 * * *" },
          ref: scenario.ref ?? "refs/heads/main",
          repository: scenario.repository ?? "openclaw/openclaw",
        },
        inputs: { operation: scenario.operation },
        vars: {
          IOS_TESTFLIGHT_ENABLED: scenario.enabled,
          OPENCLAW_TESTFLIGHT_GROUP_ID: "external-group-id",
        },
        needs: { qualify: { result: qualificationResult } },
        cancelled: () => scenario.cancelled ?? qualificationResult === "cancelled",
        success: () => qualificationResult === "success",
        failure: () => qualificationResult === "failure",
        always: () => true,
        format: (template: string, operation: string) => template.replace("{0}", operation),
      };
      const evaluate = (expression: string) => evaluateWorkflowExpression(expression, context);
      expect(Boolean(evaluate(workflow.jobs.qualify.if)), JSON.stringify(scenario)).toBe(
        scenario.qualify ?? false,
      );
      // GitHub adds success() unless the job condition includes a status function.
      // A skipped qualification must not silently skip TestFlight's upload job.
      const releaseCondition = /\b(always|cancelled|failure|success)\s*\(/u.test(
        workflow.jobs.release.if,
      )
        ? workflow.jobs.release.if
        : `success() && (${workflow.jobs.release.if})`;
      expect(Boolean(evaluate(releaseCondition)), JSON.stringify(scenario)).toBe(scenario.admitted);
      expect(Boolean(evaluate(workflow.jobs.screenshots.if))).toBe(scenario.screenshots ?? false);
      if (!scenario.admitted) {
        continue;
      }
      expect(evaluate(workflow["run-name"].slice("iOS ".length))).toBe(
        scenario.destination === "testflight"
          ? "TestFlight distribution"
          : scenario.event === "schedule"
            ? "Store release (weekly)"
            : "Store release",
      );
      expect(evaluate(workflow.jobs.release.environment)).toBe(
        scenario.destination === "testflight" ? "ios-testflight" : "ios-store-release",
      );
      expect(
        evaluate(
          expectDefined(
            uploadEnvironment.OPENCLAW_TESTFLIGHT_GROUP_ID,
            "TestFlight group expression",
          ),
        ),
      ).toBe("external-group-id");
      expect(
        releaseUploadArguments(upload, {
          IOS_RELEASE_DESTINATION: String(
            evaluate(
              expectDefined(
                uploadEnvironment.IOS_RELEASE_DESTINATION,
                "iOS release destination expression",
              ),
            ),
          ),
        }),
      ).toEqual([
        "ios:release:upload",
        "--",
        "--destination",
        scenario.destination,
        "--recovery-dir",
        "/synthetic-runner-temp/ios-release-recovery",
      ]);
    }
  });

  it("routes Android weekly/manual store releases through qualification and screenshot tooling", () => {
    const workflow = parse(
      fs.readFileSync(".github/workflows/android-store-release.yml", "utf8"),
    ) as {
      "run-name": string;
      on: {
        schedule: Array<{ cron: string; timezone: string }>;
        workflow_dispatch: { inputs: { operation: { default: string; options: string[] } } };
      };
      concurrency: { group: string; "cancel-in-progress": boolean };
      jobs: {
        qualify: { if: string };
        release: { if: string; needs: string; environment: string; steps: WorkflowStep[] };
      };
    };
    expect(workflow.on.schedule).toEqual([
      { cron: "0 7 * * *", timezone: "America/Los_Angeles" },
      { cron: "0 11 * * 1", timezone: "America/Los_Angeles" },
    ]);
    expect(workflow.on.workflow_dispatch.inputs.operation).toMatchObject({
      default: "release",
      options: ["release", "internal"],
    });
    expect(workflow.concurrency).toMatchObject({
      group: "android-release",
      "cancel-in-progress": false,
    });
    const release = workflow.jobs.release;
    expect(release.needs).toBe("qualify");
    const findStep = (name: string) =>
      expectDefined(
        release.steps.find((step) => step.name === name),
        name,
      );
    const upload = findStep("Prepare and upload Android release");
    const uploadEnvironment = expectDefined(upload.env, "Android upload environment");
    const tooling = findStep("Prepare trusted Linux Android tooling");
    const diagnostics = findStep("Retain screenshot diagnostics");
    const emulators = expectDefined(
      findStep("Setup Android toolchain").with?.["install-screenshot-emulators"],
      "screenshot emulator selection",
    );
    const scenarios: Array<{
      event: string;
      schedule?: string;
      operation: string;
      enabled: string;
      destination?: "internal" | "play-store";
      qualify?: boolean;
      qualificationResult?: "success" | "failure" | "cancelled" | "skipped";
      cancelled?: boolean;
      ref?: string;
      repository?: string;
    }> = [
      { event: "schedule", operation: "", enabled: "true", destination: "internal" },
      { event: "schedule", operation: "", enabled: "" },
      { event: "schedule", operation: "", enabled: "false" },
      ...["true", "false", ""].map((enabled) => ({
        event: "schedule",
        schedule: "0 11 * * 1",
        operation: "",
        enabled,
        destination: "play-store" as const,
        qualify: true,
      })),
      ...["schedule", "workflow_dispatch"].flatMap((event) =>
        (["failure", "cancelled", "skipped"] as const).map((qualificationResult) => ({
          event,
          schedule: "0 11 * * 1",
          operation: event === "schedule" ? "" : "release",
          enabled: "true",
          qualify: true,
          qualificationResult,
        })),
      ),
      {
        event: "schedule",
        schedule: "0 12 * * 1",
        operation: "",
        enabled: "true",
      },
      ...[{ ref: "refs/heads/candidate" }, { repository: "example/fork" }].map((change) => ({
        event: "schedule",
        schedule: "0 11 * * 1",
        operation: "",
        enabled: "true",
        ref: change.ref,
        repository: change.repository,
      })),
      {
        event: "schedule",
        schedule: "0 11 * * 1",
        operation: "",
        enabled: "true",
        qualify: true,
        cancelled: true,
      },
      {
        event: "workflow_dispatch",
        operation: "internal",
        enabled: "false",
        destination: "internal",
      },
      {
        event: "workflow_dispatch",
        operation: workflow.on.workflow_dispatch.inputs.operation.default,
        enabled: "false",
        destination: "play-store",
        qualify: true,
      },
      { event: "workflow_dispatch", operation: "unknown", enabled: "true" },
      { event: "push", operation: "internal", enabled: "true" },
      ...["schedule", "workflow_dispatch"].flatMap((event) => [
        { event, operation: "internal", enabled: "true", ref: "refs/heads/candidate" },
        { event, operation: "internal", enabled: "true", repository: "example/fork" },
      ]),
    ];
    for (const scenario of scenarios) {
      const qualificationResult =
        scenario.qualificationResult ?? (scenario.qualify ? "success" : "skipped");
      const context = {
        github: {
          event_name: scenario.event,
          event: { schedule: scenario.schedule ?? "0 7 * * *" },
          ref: scenario.ref ?? "refs/heads/main",
          repository: scenario.repository ?? "openclaw/openclaw",
        },
        inputs: { operation: scenario.operation },
        vars: { ANDROID_INTERNAL_ENABLED: scenario.enabled },
        needs: { qualify: { result: qualificationResult } },
        always: () => true,
        cancelled: () => scenario.cancelled ?? qualificationResult === "cancelled",
        success: () => qualificationResult === "success",
      };
      const evaluate = (expression: string) => evaluateWorkflowExpression(expression, context);
      expect(Boolean(evaluate(workflow.jobs.qualify.if)), JSON.stringify(scenario)).toBe(
        scenario.qualify ?? false,
      );
      const releaseCondition = /\b(always|cancelled|failure|success)\s*\(/u.test(release.if)
        ? release.if
        : `success() && (${release.if})`;
      expect(Boolean(evaluate(releaseCondition)), JSON.stringify(scenario)).toBe(
        Boolean(scenario.destination),
      );
      if (!scenario.destination) {
        continue;
      }
      const storeRelease = scenario.destination === "play-store";
      expect(evaluate(workflow["run-name"].slice("Android ".length))).toBe(
        !storeRelease
          ? "Internal testing distribution"
          : scenario.event === "schedule"
            ? "Store release (weekly)"
            : "Store release",
      );
      expect(evaluate(release.environment)).toBe(
        storeRelease ? "android-store-release" : "android-internal",
      );
      expect(Boolean(evaluate(tooling.if ?? "true"))).toBe(storeRelease);
      expect(Boolean(evaluate(diagnostics.if ?? "true"))).toBe(storeRelease);
      expect(evaluate(String(emulators))).toBe(String(storeRelease));
      expect(
        releaseUploadArguments(upload, {
          ANDROID_RELEASE_DESTINATION: String(
            evaluate(
              expectDefined(uploadEnvironment.ANDROID_RELEASE_DESTINATION, "Android destination"),
            ),
          ),
        }),
      ).toEqual([
        "android:release:upload",
        "--",
        "--destination",
        scenario.destination,
        "--recovery-dir",
        "/synthetic-runner-temp/android-release-recovery",
      ]);
    }
  });
});
