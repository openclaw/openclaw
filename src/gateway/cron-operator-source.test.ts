import { describe, expect, it, vi } from "vitest";
import { createParticipationTestAuthority } from "../agents/participation-ceiling.test-support.js";
import { createTestCronOperatorSource } from "../cron/execution-context.test-support.js";
import { CronOperatorSourceError } from "../cron/operator-source-error.js";
import type { CronStoredJob } from "../cron/types.js";
import { retainCronControlSource, restoreCronOperatorSource } from "./cron-operator-source.js";
import { normalizeGatewayOperatorRecoverySnapshot } from "./operator-run-recovery-source.codec.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createHistoryJob, createReadService } from "./server-methods/cron-read.test-support.js";

function restore(signal?: AbortSignal) {
  return restoreCronOperatorSource({
    job: {
      id: "continuation",
      operatorSource: { source: { invalid: true }, executionRevision: "rev" },
    } as unknown as CronStoredJob,
    target: { agentId: "main", sessionKey: "agent:main:dashboard:continuation" },
    signal,
    deliveryAttemptFence: null,
  });
}

describe("restoreCronOperatorSource", () => {
  it("classifies an unusable stored source as an operator source failure", async () => {
    await expect(restore()).rejects.toBeInstanceOf(CronOperatorSourceError);
  });

  it("keeps an aborted attempt retryable instead of retiring the source", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await restore(controller.signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CronOperatorSourceError);
  });
});

it.each([false, true])(
  "retains participant limits through control-only edits (parentBound=%s)",
  (parentBound) => {
    const key = "agent:main:invited";
    const base = createTestCronOperatorSource(key).source;
    const ceiling = createParticipationTestAuthority({
      kind: "send",
      profileId: base.snapshot.profileId,
      sessionKey: key,
      tools: ["read"],
      permission: "read-only",
    }).participationCeiling!;
    const snapshot = normalizeGatewayOperatorRecoverySnapshot({
      ...base.snapshot,
      version: 2,
      participationCeiling: ceiling,
    })!;
    const source = parentBound
      ? { ...base, snapshot }
      : {
          version: 1 as const,
          kind: "gateway" as const,
          agentId: "main",
          sourceRunId: "run",
          snapshot,
        };
    const job: CronStoredJob = {
      ...createHistoryJob("main", key),
      id: "participant-control",
      createdAtMs: 1,
      updatedAtMs: 1,
      state: {},
      operatorSource: { source, executionRevision: "original" },
    };
    const context = createDirectChatContext({
      cron: createReadService({
        storePath: "/synthetic/participant-control",
        cronEnabled: false,
        enqueueSystemEvent() {},
        runIsolatedAgentJob: vi.fn(),
      }),
    });
    const read = vi.spyOn(context.cron, "getJob").mockReturnValue(job);
    try {
      for (const fresh of [
        undefined,
        base.snapshot,
        normalizeGatewayOperatorRecoverySnapshot({
          ...snapshot,
          participationCeiling: { ...ceiling, tools: ["*"], permission: "workspace" },
        })!,
      ]) {
        const control = retainCronControlSource({
          job,
          patch: { enabled: true },
          context,
          capture: { operatorSource: fresh ? { ...source, snapshot: fresh } : undefined },
        });
        expect.soft(control.operatorSource?.snapshot.participationCeiling).toEqual(ceiling);
      }
    } finally {
      read.mockRestore();
    }
  },
);
