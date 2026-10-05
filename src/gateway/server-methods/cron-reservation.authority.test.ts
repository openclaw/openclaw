import { expect, it, vi } from "vitest";
import { observeCronJobWrites } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withForegroundPromotedCaller } from "../../agents/run-execution-policy.test-support.js";
import { CronService } from "../../cron/service.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import {
  finishCronRunReceiptAsync,
  prepareCronRunReceiptClaim,
  readCronRunReceiptCurrentJob,
} from "../../cron/store/run-receipt-store.js";
import { claimCronRunReceiptInDatabaseForTest } from "../../cron/store/run-receipt-store.test-support.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { resolveCronMutationCommitGuard } from "./cron-caller-scope.js";
import { cronHandlers } from "./cron.js";

it.each(["role", "session"] as const)(
  "denies cron enqueue under original %s policy after broader personal selection",
  async (restriction) => {
    await withOpenClawTestState({ label: "foreground-cron" }, async (fixture) => {
      const now = Date.now();
      const storePath = fixture.statePath("cron", "jobs.json");
      const target = createDueIsolatedJob({ id: "target", nowMs: now, nextRunAtMs: now });
      const runner = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronRegressionState({
        storePath,
        defaultAgentId: "main",
        isAgentAvailable: () => true,
        nowMs: () => now,
        runIsolatedAgentJob: runner,
      });
      await saveCronStore(storePath, { version: 1, jobs: [target] });
      const cron = new CronService(state.deps);
      const context = createDirectChatContext({
        cron,
        cronStorePath: storePath,
        getRuntimeConfig: () => ({}),
      });
      const before = await loadCronStore(storePath);
      const writes = vi.fn();
      const stopObserving = observeCronJobWrites(target.id, writes);
      try {
        await withForegroundPromotedCaller(restriction, async (profileId) => {
          const client = createSyntheticPluginRuntimeClient({
            operatorRoleActor: { kind: "operator", profileId },
            scopes: ["operator.admin"],
          });
          for (const [method, params] of [
            ["cron.run", { id: target.id, mode: "force", waitTimeoutMs: 1000 }],
            ["cron.update", { id: target.id, patch: { enabled: true } }],
            ["wake", { mode: "now", text: "continue" }],
          ] as const) {
            const respond = vi.fn();
            await cronHandlers[method]!({
              req: {} as never,
              params,
              respond,
              context,
              client,
              isWebchatConnect: () => false,
            });
            expect(respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({
                message: expect.stringContaining("cannot outlive this foreground request"),
              }),
            );
          }
        });
        expect(await loadCronStore(storePath)).toEqual(before);
        expect(writes).not.toHaveBeenCalled();
        expect(runner).not.toHaveBeenCalled();
      } finally {
        stopObserving();
        cron.stop();
      }
    });
  },
);

it("revalidates a scheduled Gateway caller while its child reservation holds the SQLite writer", async () => {
  await withOpenClawTestState({ label: "cron-reservation-caller-authority" }, async (fixture) => {
    const now = Date.now();
    const storePath = fixture.statePath("cron", "jobs.json");
    const parent = createDueIsolatedJob({ id: "caller", nowMs: now, nextRunAtMs: now });
    const target = createDueIsolatedJob({ id: "target", nowMs: now, nextRunAtMs: now });
    target.payload = { kind: "command", argv: ["echo", "synthetic"] };
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      storePath,
      defaultAgentId: "main",
      isAgentAvailable: () => true,
      nowMs: () => now,
      runIsolatedAgentJob: runner,
      runCommandJob: runner,
    });
    await saveCronStore(storePath, { version: 1, jobs: [parent, target] });
    const prepared = prepareCronRunReceiptClaim({
      storePath,
      job: parent,
      agentId: "main",
      startedAtMs: now,
      observed: undefined,
    });
    const receipt = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabaseForTest({
        database: db,
        prepared,
        resolveAgentId: () => "main",
      }),
    );
    const operationalRunInstance = createOperationalRunInstanceRef("scheduled-cron-caller");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance, () => {
      readCronRunReceiptCurrentJob({
        handle: receipt,
        resolveAgentId: () => "main",
        isAgentAvailable: state.deps.isAgentAvailable,
      });
    });
    const cron = new CronService(state.deps);
    const client = createSyntheticPluginRuntimeClient();
    client.internal = {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
        delegatedAuthority: { ...authority, kind: "local" },
      },
    };
    const context = createDirectChatContext({
      cron,
      cronStorePath: storePath,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    const commitGuard = resolveCronMutationCommitGuard(client, context);
    if (!commitGuard) {
      throw new Error("Scheduled Gateway caller did not retain its commit guard");
    }
    let checkedWhileWriting = false;
    const stopObserving = observeCronJobWrites(target.id, (written) => {
      if (written.queuedAtMs !== undefined) {
        commitGuard();
        checkedWhileWriting = true;
      }
    });
    try {
      await expect(cron.run(target.id, "force", { commitGuard })).resolves.toMatchObject({
        ok: true,
        ran: true,
      });
      expect(checkedWhileWriting).toBe(true);
      expect(runner).toHaveBeenCalledOnce();
      releaseAgentRunDelegatedAuthority(authority);
      expect(commitGuard).toThrow("agent runtime authority is no longer active");
    } finally {
      stopObserving();
      releaseAgentRunDelegatedAuthority(authority);
      cron.stop();
      await finishCronRunReceiptAsync({ handle: receipt, status: "ok", finishedAtMs: now + 1 });
    }
  });
});
