import { describe, expect, it } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronStoredJob } from "../types.js";
import {
  cronJobMessageActionAuthorityInputsEqual,
  reconcileScheduledJobOwnerPolicy,
  resolveCronJobMessageToolAuthorityInputs,
} from "./jobs-tool-policy.js";

const owner = { agentId: "main", sessionKey: "agent:main:chat:group:team", accountId: "work" };
const policy = {
  version: 1 as const,
  mode: "account" as const,
  ownerSessionKey: owner.sessionKey,
  ownerAccountId: owner.accountId,
};
const origin = { kind: "external" as const, channel: "chat" };
function toolJob(): CronStoredJob {
  return {
    ...makeCronJob({ payload: { kind: "agentTurn", message: "Read project notes" } }),
    owner,
  };
}

describe("scheduled job owner policy", () => {
  it("binds the authenticated account without a per-job cap", () => {
    const job = toolJob();
    reconcileScheduledJobOwnerPolicy({
      job,
      previouslyUsedToolRuntime: false,
      scheduledToolPolicy: policy,
    });
    expect(job.scheduledToolPolicy).toEqual(policy);
  });

  it("cannot stamp another account's policy onto a job", () => {
    const job = toolJob();
    expect(() =>
      reconcileScheduledJobOwnerPolicy({
        job,
        previouslyUsedToolRuntime: false,
        scheduledToolPolicy: { ...policy, ownerAccountId: "other" },
      }),
    ).toThrow("scheduled account policy must match the persisted job owner");
  });

  it("does not replace an existing owner with the operator editing the schedule", () => {
    const job: CronStoredJob = {
      ...toolJob(),
      scheduledToolPolicy: policy,
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: origin,
      },
    };
    reconcileScheduledJobOwnerPolicy({
      job,
      previouslyUsedToolRuntime: true,
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });
    expect(job.scheduledToolPolicy).toEqual(policy);
    expect(job.toolsAllowProvenance?.callerOrigin).toEqual(origin);
  });

  it("retains the authenticated owner when the payload becomes transport-only", () => {
    const job: CronStoredJob = {
      ...toolJob(),
      scheduledToolPolicy: policy,
      payload: { kind: "systemEvent", text: "wake" },
    };
    reconcileScheduledJobOwnerPolicy({ job, previouslyUsedToolRuntime: true });
    expect(job.scheduledToolPolicy).toEqual(policy);
  });
});

describe("account read authority inputs", () => {
  it("binds a recorded caller origin to executable inputs but not display metadata", () => {
    const job = {
      ...toolJob(),
      payload: { kind: "agentTurn" as const, message: "read" },
      owner: { sessionKey: "agent:main:local", accountId: "work" },
      scheduledToolPolicy: {
        version: 1 as const,
        mode: "account" as const,
        ownerSessionKey: "agent:main:local",
        ownerAccountId: "work",
      },
      toolsAllowProvenance: {
        version: 1 as const,
        source: "authenticated-requester" as const,
        callerOrigin: { kind: "local" as const },
      },
    } satisfies CronStoredJob;

    expect(
      cronJobMessageActionAuthorityInputsEqual(job, {
        ...job,
        description: "display only",
        displayName: "Readable name",
      }),
    ).toBe(true);
    expect(
      cronJobMessageActionAuthorityInputsEqual(job, {
        ...job,
        payload: { ...job.payload, message: "read something else" },
      }),
    ).toBe(false);
  });
});

describe("scheduled message authority", () => {
  it.each([undefined, true])(
    "admits message access despite a legacy snapshot (default marker: %s)",
    (toolsAllowIsDefault) => {
      const job = toolJob();
      job.payload = {
        kind: "agentTurn",
        message: "post",
        toolsAllow: ["read"],
        toolsAllowIsDefault,
      };
      job.scheduledToolPolicy = { version: 1, mode: "trusted" };

      expect(resolveCronJobMessageToolAuthorityInputs(job)).toEqual({
        policy: { version: 1, mode: "trusted" },
      });
    },
  );
});
