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
  it("strips scheduler-only state without mutating the stored job", () => {
    const job = makeCronJob({
      state: {
        nextRunAtMs: 2_000,
        queuedAtMs: 1_900,
        runningReceiptId: "pending-receipt",
        startupCatchupAtMs: 2_000,
        pacedNextRunAtMs: 2_000,
        forcePreservedNextRunAtMs: 2_000,
        runningScheduleChangeId: "pending-run-edit",
        failureAlertIncident: { signature: "internal-incident", scope: "run" },
        lastFailureNotificationId: "internal-notification",
      },
    });

    expect(publicJob(job).state).toStrictEqual({ nextRunAtMs: 2_000 });
  });

  it("projects script payload fields without exposing scheduler-only state", () => {
    const payload = {
      kind: "script",
      script: "return { notify: 'done' }",
      timeoutSeconds: 300,
      toolBudget: 50,
    } as const;
    const job = makeCronJob({
      payload,
      state: { triggerState: { revision: 1 }, pacedNextRunAtMs: 2_000 },
    });
    expect(publicJob(job)).toMatchObject({
      payload,
      state: { triggerState: { revision: 1 } },
    });
  });

  it.each(["final-executable-surface", "authenticated-requester", "runtime"] as const)(
    "strips private %s provenance without mutating the stored job",
    (source) => {
      const channelRequester = {
        version: 1 as const,
        channel: "discord",
        accountId: "work",
        senderId: "123456789012345678",
      };
      const target = { version: 1, host: "gateway", ask: "always" } as const;
      const fields: Partial<CronStoredJob> =
        source === "runtime"
          ? {
              runtimeAuthority: {
                version: 1,
                runtimeId: "codex",
                namespace: "codex.apps",
                payload: { apps: [{ id: "calendar" }] },
              },
              runtimeAuthorityRecoveryRequired: true,
            }
          : {
              toolsAllowProvenance:
                source === "final-executable-surface"
                  ? { version: 1, source, callerOrigin: { kind: "unknown" }, channelRequester }
                  : { version: 1, source, channelRequester },
              toolsAllowExecTarget: target,
              toolsAllowExecTargetRequirement: { version: 1, target, grantIndex: 0 },
            };
      publicJob({ ...makeCronJob({}), ...fields }, Object.keys(fields));
    },
  );

  it("strips private creator provenance and sandbox target without mutating the stored job", () => {
    const streamSandbox = makeCronStreamSandboxTarget();
    const job: CronStoredJob = {
      ...makeCronJob({ schedule: { kind: "stream", command: ["watch-source"] } }),
      createdActor: { type: "human", source: "profile", id: "profile-ada" },
      streamSandbox,
      sourceConversation: {
        sessionKey: "agent:main:conversation",
        sessionId: "creating-session",
        lifecycleRevision: "generation-1",
      },
    };

    expect(publicJob(job, ["createdActor", "sourceConversation", "streamSandbox"])).toMatchObject({
      schedule: { kind: "stream" },
      streamExecutionHost: "sandbox",
    });
    expect(toPublicCronJob({ ...job, streamSandbox: undefined }).streamExecutionHost).toBe(
      "gateway",
    );
    expect(toPublicCronJob(makeCronJob({}))).not.toHaveProperty("streamExecutionHost");
    for (const storedJob of [job, { ...job, streamSandbox: undefined }]) {
      const view = cronJobReadView(storedJob);
      const definition = cronJobDefinitionFromReadView(view);
      expect(definition).not.toHaveProperty("streamExecutionHost");
      expect(definition.schedule).toEqual(storedJob.schedule);
    }
  });
});
