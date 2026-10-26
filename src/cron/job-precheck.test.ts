import { describe, expect, it } from "vitest";
import { assertNoCronShellExecution } from "../agents/tools/cron-tool-write.js";
import { assertCronModelJobAllowed } from "../gateway/server-methods/cron-caller-scope.js";
import type { GatewayClient } from "../gateway/server-methods/types.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { parseCronJobPrecheck } from "./job-precheck.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "./normalize.js";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";
import { applyJobPatch, createJob } from "./service/jobs.js";
import type { CronJobCreate } from "./types.js";

const agentClient = {
  internal: { agentRuntimeIdentity: { agentId: "main" } },
} as GatewayClient;

function persisted(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "agentTurn", message: "hi" },
    sessionTarget: "isolated",
    precheck: { command: "inbox-has-mail" },
    ...overrides,
  };
}

function createInput(overrides: Record<string, unknown> = {}): CronJobCreate {
  return {
    name: "Inbox poll",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Process new mail" },
    ...overrides,
  } as CronJobCreate;
}

describe("cron precheck contract", () => {
  it("fills default timeout and exit codes", () => {
    expect(parseCronJobPrecheck({ command: "inbox-has-mail" })).toEqual({
      ok: true,
      value: {
        command: "inbox-has-mail",
        timeoutSeconds: 30,
        workExitCodes: [0],
        noWorkExitCodes: [2],
      },
    });
  });

  it("rejects overlapping exit codes, including a custom work code against the default no-work code", () => {
    expect(parseCronJobPrecheck({ command: "probe", workExitCodes: [2] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("exit code 2"),
    });
    expect(
      parseCronJobPrecheck({
        command: "probe",
        workExitCodes: [0],
        noWorkExitCodes: [0],
      }),
    ).toMatchObject({ ok: false });
  });

  it("keeps an invalid precheck on normalize instead of dropping it", () => {
    const created = normalizeCronJobCreate(
      createInput({ precheck: { command: "probe", workExitCodes: [2] } }),
    );
    expect(created?.precheck).toEqual({ command: "probe", workExitCodes: [2] });

    const patched = normalizeCronJobPatch({ precheck: { command: "" } });
    expect(patched?.precheck).toEqual({ command: "" });
  });

  it("stores the canonical precheck and clears it with null", () => {
    const now = Date.parse("2026-07-30T00:00:00.000Z");
    const job = createJob(
      { deps: { nowMs: () => now } },
      createInput({ precheck: { command: "inbox-has-mail" } }),
    );
    expect(job.precheck).toEqual({
      command: "inbox-has-mail",
      timeoutSeconds: 30,
      workExitCodes: [0],
      noWorkExitCodes: [2],
    });

    applyJobPatch(job, { precheck: null });
    expect(job.precheck).toBeUndefined();
  });

  it("rejects a precheck on a stream schedule and when triggers are disabled", () => {
    const now = Date.parse("2026-07-30T00:00:00.000Z");
    expect(() =>
      createJob(
        { deps: { nowMs: () => now } },
        createInput({
          schedule: { kind: "stream", command: ["inbox-has-mail"], mode: "line" },
          precheck: { command: "inbox-has-mail" },
        }),
      ),
    ).toThrow("cron precheck requires an at, every, or cron schedule");

    expect(() =>
      createJob(
        {
          deps: {
            nowMs: () => now,
            cronConfig: { triggers: { enabled: false } },
          },
        },
        createInput({ precheck: { command: "inbox-has-mail" } }),
      ),
    ).toThrow("cron.triggers.enabled: false");
  });

  it("quarantines a persisted precheck that is empty, overlapping, or on a stream", () => {
    expect(getInvalidPersistedCronJobReason(persisted())).toBeNull();
    expect(getInvalidPersistedCronJobReason(persisted({ precheck: { command: "" } }))).toBe(
      "invalid-precheck",
    );
    expect(
      getInvalidPersistedCronJobReason(
        persisted({ precheck: { command: "probe", workExitCodes: [2] } }),
      ),
    ).toBe("invalid-precheck");
    expect(
      getInvalidPersistedCronJobReason(
        persisted({
          schedule: { kind: "stream", command: ["inbox-has-mail"], mode: "line" },
        }),
      ),
    ).toBe("invalid-precheck");
  });
});

describe("cron precheck agent authoring", () => {
  it("rejects an agent create or patch that sets a precheck and allows clearing it", () => {
    expect(() => assertNoCronShellExecution({ precheck: { command: "inbox-has-mail" } })).toThrow(
      "use the CLI or Gateway API",
    );
    expect(() => assertNoCronShellExecution({ precheck: null })).not.toThrow();

    const job = createInput({ precheck: { command: "inbox-has-mail" } });
    expect(() =>
      assertCronModelJobAllowed(agentClient, {}, job, undefined, { create: true }),
    ).toThrow("use the CLI or Gateway API");
    expect(() =>
      assertCronModelJobAllowed(agentClient, {}, makeCronJob({}), {
        precheck: { command: "inbox-has-mail" },
      }),
    ).toThrow("use the CLI or Gateway API");
    expect(() =>
      assertCronModelJobAllowed(agentClient, {}, makeCronJob({ precheck: job.precheck }), {
        precheck: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertCronModelJobAllowed(agentClient, {}, makeCronJob({ precheck: job.precheck })),
    ).not.toThrow();
    expect(() =>
      assertCronModelJobAllowed(null, {}, job, undefined, { create: true }),
    ).not.toThrow();
  });
});
