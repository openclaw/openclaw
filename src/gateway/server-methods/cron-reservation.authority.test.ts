import { expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { getAdmittedRunDelegatedAuthority } from "../../agents/admitted-run-context.js";
import { prepareCronRunAdmission } from "../../cron/run-admission.js";
import { CronService } from "../../cron/service.js";
import { saveCronStore } from "../../cron/store.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { resolveCronMutationCommitGuard } from "./cron-caller-scope.js";

it("revalidates a scheduled Gateway caller after its child reservation commits without main-thread SQL", async () => {
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
    const admission = prepareCronRunAdmission({
      cfg: {},
      runId: "scheduled-cron-caller",
      agentId: "main",
      sessionKey: "cron:caller",
      jobId: parent.id,
      deliveryAttemptFence: null,
    });
    const admitted = await admission.preparedRunAdmission.admit("gateway");
    const authority = getAdmittedRunDelegatedAuthority(admitted);
    if (!authority) {
      throw new Error("Scheduled caller was not admitted");
    }
    const cron = new CronService(state.deps);
    const client = createSyntheticPluginRuntimeClient();
    client.internal = {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance: admitted.operationalRunInstance,
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
    let checkedAfterCommit = false;
    const sql = observeMainThreadSql();
    sql.calibrate();
    const stopObserving = observeCronJobCommits(target.id, (committed) => {
      if (committed.queuedAtMs !== undefined) {
        sql.clear();
        commitGuard();
        sql.expectIdle();
        checkedAfterCommit = true;
      }
    });
    try {
      await expect(cron.run(target.id, "force", { commitGuard })).resolves.toMatchObject({
        ok: true,
        ran: true,
      });
      expect(checkedAfterCommit).toBe(true);
      expect(runner).toHaveBeenCalledOnce();
      admission.close();
      expect(commitGuard).toThrow("agent runtime authority is no longer active");
    } finally {
      sql.restore();
      stopObserving();
      admission.close();
      cron.stop();
    }
  });
});
