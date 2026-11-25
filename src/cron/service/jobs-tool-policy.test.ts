import { expect, it } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createParticipationTestAuthority } from "../../agents/participation-ceiling.test-support.js";
import { createTestCronOperatorSource } from "../execution-context.test-support.js";
import { resolveCronRunAdmissionSource } from "../run-authority.js";
import { resolveCronRunToolsAllow } from "../tools-allow.js";
import type { CronStoredJob, CronToolsAllowExecTarget } from "../types.js";
import {
  cronJobMessageActionAuthorityInputsEqual,
  reconcileCronChannelRequesterAuthority,
  reconcileCronOperatorSource,
  reconcileToolsAllowAuthority,
} from "./jobs-tool-policy.js";

function toolJob(toolsAllow: readonly string[] | undefined): CronStoredJob {
  return {
    ...createDueIsolatedJob({ id: "job-1", nowMs: 1, nextRunAtMs: 1 }),
    payload: { kind: "script", script: "return {}", toolsAllow: toolsAllow?.slice() },
  };
}

it.each(["operator", "owned", "external-content", "unknown", "external"])(
  "preserves only existing operator admission during reconciliation: %s",
  (scenario) => {
    const previous: CronStoredJob = {
      ...toolJob(["read"]),
      payload: { kind: "agentTurn", message: "work", toolsAllow: ["read"] },
      scheduledToolPolicy: { version: 1, mode: "trusted" },
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        callerOrigin:
          scenario === "unknown"
            ? { kind: "unknown" }
            : scenario === "external"
              ? { kind: "external", channel: "discord" }
              : { kind: "local" },
      },
    };
    const job = structuredClone(previous);
    job.displayName = "Renamed";
    if (scenario === "owned") {
      job.owner = { sessionKey: "agent:main:owner", accountId: "work" };
    }
    if (job.payload.kind === "agentTurn") {
      job.payload.model = "provider/model-b";
      if (scenario === "external-content") {
        job.payload.externalContentSource = "gmail";
      }
    }
    reconcileCronChannelRequesterAuthority({ job, previousJob: previous });
    expect(resolveCronRunAdmissionSource(job)).toBe(
      scenario === "operator" ? "operator-schedule" : "requester-schedule",
    );
    expect(job.toolsAllowProvenance?.channelRequester).toBeUndefined();
    if (scenario === "operator") {
      expect(job.toolsAllowProvenance?.callerOrigin).toEqual({ kind: "local" });
    }
  },
);

const gateway = { version: 1, host: "gateway" } satisfies CronToolsAllowExecTarget;
const pinned = { ...gateway, ask: "always" } satisfies CronToolsAllowExecTarget;
it.each([
  ["stamps explicit exec", ["exec", "read"], undefined, true, pinned, pinned],
  ["pins wildcard exec", ["*"], undefined, true, pinned, pinned],
  ["excludes non-exec caps", ["read"], undefined, true, gateway, undefined],
  ["clears rewritten caps without capture", ["exec"], pinned, true, undefined, undefined],
  ["preserves untouched caps", ["exec"], pinned, false, undefined, pinned],
  ["drops removed caps", undefined, gateway, false, gateway, undefined],
] as const)("exec pin: %s", (_name, cap, previous, explicit, captured, expected) => {
  const job = toolJob(cap);
  if (previous) {
    job.toolsAllowExecTarget = structuredClone(previous);
    job.toolsAllowExecTargetRequirement = {
      version: 1,
      target: structuredClone(previous),
      grantIndex: 0,
    };
  }
  reconcileToolsAllowAuthority({
    job,
    previouslyUsedToolRuntime: true,
    explicitlyMutatesToolsAllow: explicit,
    toolsAllowExecTarget: captured ? structuredClone(captured) : undefined,
  });
  expect([job.toolsAllowExecTarget, job.toolsAllowExecTargetRequirement]).toEqual([
    expected,
    expected ? { version: 1, target: expected, grantIndex: 0 } : undefined,
  ]);
});

it("binds a recorded caller origin to executable inputs but not display metadata", () => {
  const job = {
    ...toolJob(["message"]),
    payload: { kind: "agentTurn", message: "read", toolsAllow: ["message"] },
    owner: { sessionKey: "agent:main:local", accountId: "work" },
    scheduledToolPolicy: {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:local",
      ownerAccountId: "work",
    },
    toolsAllowProvenance: {
      version: 1,
      source: "authenticated-requester",
      callerOrigin: { kind: "local" },
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
it("uses its owner's tools instead of a stale automatic tool snapshot", () => {
  const job = toolJob(["read"]);
  job.payload = { kind: "agentTurn", message: "post", toolsAllow: ["read"] };
  job.scheduledToolPolicy = { version: 1, mode: "trusted" };
  expect(resolveCronRunToolsAllow(job)).toEqual(["read"]);

  // Older builds saved this snapshot without `message`; the run gets `*`.
  Object.assign(job.payload, { toolsAllowIsDefault: true });
  expect(resolveCronRunToolsAllow(job)).toEqual(["*"]);
});

it.each([false, true])(
  "does not drop a mandatory source on an incompatible edit (participant=%s)",
  (participant) => {
    const key = "agent:main:invited";
    const source = createTestCronOperatorSource(key);
    if (participant) {
      source.source.snapshot = createParticipationTestAuthority({
        kind: "send",
        profileId: "profile-1",
        sessionKey: key,
      }).recoverySnapshot!;
    }
    const previousJob = { ...toolJob(["read"]), operatorSource: source };
    const job: CronStoredJob = {
      ...previousJob,
      payload: { kind: "systemEvent", text: "changed execution" },
    };
    const reconcile = () =>
      reconcileCronOperatorSource({ job, previousJob, defaultAgentId: "main" });
    if (participant) {
      expect(reconcile).toThrow(/participant/i);
    } else {
      reconcile();
      expect(job.operatorSource).toBeUndefined();
    }
  },
);
