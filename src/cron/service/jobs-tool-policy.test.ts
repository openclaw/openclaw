import { expect, it } from "vitest";
import { createDueIsolatedJob } from "../../../test/helpers/cron/service-regression-fixtures.js";
import type { CronStoredJob, CronToolsAllowExecTarget } from "../types.js";
import {
  cronJobMessageActionAuthorityInputsEqual,
  reconcileToolsAllowAuthority,
  resolveCronJobMessageToolAuthorityInputs,
} from "./jobs-tool-policy.js";

function toolJob(toolsAllow: readonly string[] | undefined): CronStoredJob {
  return {
    ...createDueIsolatedJob({ id: "job-1", nowMs: 1, nextRunAtMs: 1 }),
    payload: { kind: "script", script: "return {}", toolsAllow: toolsAllow?.slice() },
  };
}

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
it("admits message access for an automatic snapshot that runs with its owner's tools", () => {
  const job = toolJob(["read"]);
  job.payload = { kind: "agentTurn", message: "post", toolsAllow: ["read"] };
  job.scheduledToolPolicy = { version: 1, mode: "trusted" };
  expect(resolveCronJobMessageToolAuthorityInputs(job)).toBeUndefined();

  // Older builds saved this snapshot without `message`; the run gets `*`.
  Object.assign(job.payload, { toolsAllowIsDefault: true });
  expect(resolveCronJobMessageToolAuthorityInputs(job)).toEqual({
    policy: { version: 1, mode: "trusted" },
  });
});
