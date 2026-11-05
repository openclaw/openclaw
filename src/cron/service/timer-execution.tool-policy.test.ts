import { describe, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronStoredJob } from "../types.js";
import type { CronServiceDeps } from "./state.js";
import { executeJobCore } from "./timer-execution.js";

function makeState(overrides: Partial<CronServiceDeps> = {}) {
  return createCronRegressionState({
    storePath: "/tmp/cron-tool-policy.json",
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  });
}

function damagedPinnedJob(kind: "trigger" | "script" | "agentTurn"): CronStoredJob {
  const payload: CronStoredJob["payload"] =
    kind === "script"
      ? { kind: "script", script: "return {}", toolsAllow: ["exec"] }
      : { kind: "agentTurn", message: "run", toolsAllow: ["exec"] };
  return {
    ...makeCronJob({
      payload,
      ...(kind === "trigger" ? { trigger: { script: "return { fire: true }" } } : {}),
    }),
    toolsAllowExecTargetRequirement: {
      version: 1,
      target: { version: 1, host: "gateway", ask: "always" },
      grantIndex: 0,
    },
  };
}

describe("scheduled exec target recovery", () => {
  it.each(["trigger", "script", "agentTurn"] as const)(
    "stops a damaged pinned %s job before executable work",
    async (kind) => {
      const state = makeState({
        evaluateCronTrigger: vi.fn(async () => ({ kind: "evaluated" as const, fire: true })),
        runScriptJob: vi.fn(async () => ({ status: "ok" as const })),
      });

      const result = await executeJobCore(state, damagedPinnedJob(kind));

      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("captured exec restriction is missing or invalid"),
      });
      expect(state.deps.evaluateCronTrigger).not.toHaveBeenCalled();
      expect(state.deps.runScriptJob).not.toHaveBeenCalled();
      expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
    },
  );

  it("keeps legacy unmarked exec grants on baseline policy", async () => {
    const state = makeState();
    const job = makeCronJob({
      payload: { kind: "agentTurn", message: "run", toolsAllow: ["exec"] },
    });

    await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });
    expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledOnce();
  });
});

describe("scheduled agent admission", () => {
  it.each<[string, Partial<CronStoredJob>]>([
    ["operator", {}],
    [
      "account requester",
      {
        owner: { agentId: "main", accountId: "work" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:work",
          ownerAccountId: "work",
        },
      },
    ],
    [
      "channel requester",
      {
        toolsAllowProvenance: {
          version: 1,
          source: "authenticated-requester",
          channelRequester: {
            version: 1,
            channel: "discord",
            accountId: "work",
            senderId: "requester",
          },
        },
      },
    ],
    [
      "external content",
      {
        payload: { kind: "agentTurn", message: "run", externalContentSource: "webhook" },
      },
    ],
  ])("records %s admission without an audit identity", async (name, overrides) => {
    const state = makeState();
    const job: CronStoredJob = { ...makeCronJob({}), ...overrides };

    await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });

    expect(state.deps.runIsolatedAgentJob).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        job,
        admissionSource: name === "operator" ? "operator-schedule" : "requester-schedule",
        executionIdentity: undefined,
      }),
    );
  });
});
