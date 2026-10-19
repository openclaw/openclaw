import { describe, expect, it } from "vitest";
import type { CronStoredJob, CronToolsAllowExecTarget } from "../types.js";
import {
  cronJobMessageActionAuthorityInputsEqual,
  reconcileToolsAllowAuthority,
  resolveCronJobMessageToolAuthorityInputs,
} from "./jobs-tool-policy.js";

function toolJob(toolsAllow: string[] | undefined): CronStoredJob {
  return {
    id: "job-1",
    name: "job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    payload: {
      kind: "script",
      script: "return {}",
      ...(toolsAllow ? { toolsAllow } : {}),
    },
    state: {},
  } as unknown as CronStoredJob;
}

describe("reconcileToolsAllowAuthority exec pin", () => {
  const gateway = { version: 1, host: "gateway" } satisfies CronToolsAllowExecTarget;
  const pinned = { ...gateway, ask: "always" } satisfies CronToolsAllowExecTarget;
  it.each<
    [
      name: string,
      cap: string[] | undefined,
      previous: CronToolsAllowExecTarget | undefined,
      explicit: boolean,
      captured: CronToolsAllowExecTarget | undefined,
      expected: CronToolsAllowExecTarget | undefined,
    ]
  >([
    ["stamps explicit exec", ["exec", "read"], undefined, true, pinned, pinned],
    ["pins wildcard exec", ["*"], undefined, true, pinned, pinned],
    ["excludes non-exec caps", ["read"], undefined, true, gateway, undefined],
    ["clears rewritten caps without capture", ["exec"], pinned, true, undefined, undefined],
    ["preserves untouched caps", ["exec"], pinned, false, undefined, pinned],
    ["drops removed caps", undefined, gateway, false, gateway, undefined],
  ])("%s", (_name, cap, previous, explicit, captured, expected) => {
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
    if (expected) {
      expect(job.toolsAllowExecTarget).toEqual(expected);
      expect(job.toolsAllowExecTargetRequirement).toEqual({
        version: 1,
        target: expected,
        grantIndex: 0,
      });
    } else {
      expect(job.toolsAllowExecTarget).toBeUndefined();
      expect(job.toolsAllowExecTargetRequirement).toBeUndefined();
    }
  });
});

describe("account read authority inputs", () => {
  it("binds a recorded caller origin to executable inputs but not display metadata", () => {
    const job = {
      ...toolJob(["message"]),
      payload: { kind: "agentTurn" as const, message: "read", toolsAllow: ["message"] },
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
});
