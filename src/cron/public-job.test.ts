import { describe, expect, it } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";
import { cronJobDefinitionFromReadView, cronJobReadView } from "./job-read-view.js";
import { toPublicCronJob } from "./public-job.js";
import { makeCronStreamSandboxTarget } from "./stream-sandbox.test-support.js";
import type { CronStoredJob } from "./types.js";

function publicJob(job: CronStoredJob, privateFields: string[] = []) {
  const before = structuredClone(job);
  const result = toPublicCronJob(job);
  for (const field of privateFields) {
    expect(result).not.toHaveProperty(field);
  }
  expect(job).toEqual(before);
  return result;
}

describe("toPublicCronJob", () => {
  it("preserves script fields and public state without mutating the stored job", () => {
    const state = {
      nextRunAtMs: 2_000,
      queuedAtMs: 1_900,
      runningReceiptId: "pending-receipt",
      startupCatchupAtMs: 2_000,
      pacedNextRunAtMs: 2_000,
      forcePreservedNextRunAtMs: 2_000,
      runningScheduleChangeId: "pending-run-edit",
      failureAlertIncident: { signature: "internal-incident", scope: "run" as const },
      lastFailureNotificationId: "internal-notification",
      triggerState: { revision: 1 },
    };
    const payload = {
      kind: "script",
      script: "return { notify: 'done' }",
      timeoutSeconds: 300,
      toolBudget: 50,
    } as const;
    const result = publicJob(makeCronJob({ payload, state }));
    expect(result).toMatchObject({ payload });
    expect(result.state).toStrictEqual({
      nextRunAtMs: 2_000,
      triggerState: { revision: 1 },
    });
  });

  it("strips private provenance and sandbox targets without mutating the stored job", () => {
    const target = { version: 1, host: "gateway", ask: "always" } as const;
    const fields: Partial<CronStoredJob> = {
      runtimeAuthority: { version: 1, runtimeId: "test", namespace: "test", payload: {} },
      runtimeAuthorityRecoveryRequired: true,
      ownerSessionId: "creating-session",
      payloadSourceConversation: {
        sessionKey: "agent:main:conversation",
        sessionId: "creating-session",
      },
      toolsAllowProvenance: { version: 1, source: "final-executable-surface" },
      toolsAllowExecTarget: target,
      toolsAllowExecTargetRequirement: { version: 1, target, grantIndex: 0 },
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
      streamSandbox: makeCronStreamSandboxTarget(),
      sourceConversation: {
        sessionKey: "agent:main:conversation",
        sessionId: "creating-session",
        lifecycleRevision: "generation-1",
      },
    };
    const job = {
      ...makeCronJob({ schedule: { kind: "stream", command: ["watch-source"] } }),
      ...fields,
    };
    expect(publicJob(job, Object.keys(fields))).toMatchObject({
      schedule: { kind: "stream" },
      streamExecutionHost: "sandbox",
    });
    expect(toPublicCronJob({ ...job, streamSandbox: undefined }).streamExecutionHost).toBe(
      "gateway",
    );
    expect(toPublicCronJob(makeCronJob({}))).not.toHaveProperty("streamExecutionHost");
    for (const storedJob of [job, { ...job, streamSandbox: undefined }]) {
      const definition = cronJobDefinitionFromReadView(cronJobReadView(storedJob));
      expect(definition).not.toHaveProperty("streamExecutionHost");
      expect(definition.schedule).toEqual(storedJob.schedule);
    }
  });
});
