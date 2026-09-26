import { describe, expect, it, vi } from "vitest";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createNoopLogger } from "../service.test-harness.js";
import type { CronStoredJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { executeJobCore } from "./timer-execution.js";

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
      const evaluateCronTrigger = vi.fn(async () => ({ kind: "evaluated" as const, fire: true }));
      const runScriptJob = vi.fn(async () => ({ status: "ok" as const }));
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        storePath: `/tmp/cron-exec-target-recovery-${kind}.json`,
        cronEnabled: true,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        evaluateCronTrigger,
        runScriptJob,
        runIsolatedAgentJob,
      });

      const result = await executeJobCore(state, damagedPinnedJob(kind));

      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining("captured exec restriction is missing or invalid"),
      });
      expect(evaluateCronTrigger).not.toHaveBeenCalled();
      expect(runScriptJob).not.toHaveBeenCalled();
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    },
  );

  it("keeps legacy unmarked exec grants on baseline policy", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronServiceState({
      storePath: "/tmp/cron-exec-target-legacy.json",
      cronEnabled: true,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob,
    });
    const job = makeCronJob({
      payload: { kind: "agentTurn", message: "run", toolsAllow: ["exec"] },
    });

    await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });
    expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
  });
});

describe("scheduled agent admission", () => {
  it.each<{
    name: string;
    overrides: Partial<CronStoredJob>;
    admissionSource: "operator-schedule" | "requester-schedule";
  }>([
    { name: "operator", overrides: {}, admissionSource: "operator-schedule" },
    {
      name: "account requester",
      overrides: {
        owner: { agentId: "main", accountId: "work" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:work",
          ownerAccountId: "work",
        },
      },
      admissionSource: "requester-schedule",
    },
    {
      name: "channel requester",
      overrides: {
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
      admissionSource: "requester-schedule",
    },
    {
      name: "external content",
      overrides: {
        payload: { kind: "agentTurn", message: "run", externalContentSource: "webhook" },
      },
      admissionSource: "requester-schedule",
    },
  ])(
    "records $name admission without an audit identity",
    async ({ overrides, admissionSource }) => {
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronServiceState({
        storePath: "/tmp/cron-admission-source.json",
        cronEnabled: true,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob,
      });
      const job: CronStoredJob = { ...makeCronJob({}), ...overrides };

      await expect(executeJobCore(state, job)).resolves.toMatchObject({ status: "ok" });

      expect(runIsolatedAgentJob).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ job, admissionSource, executionIdentity: undefined }),
      );
    },
  );
});
