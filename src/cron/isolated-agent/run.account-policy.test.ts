import { basename, dirname, join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import "../../agents/test-helpers/fast-coding-tools.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createScheduledGatewayRunner } from "../../gateway/scheduled-run-gateway-context.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  readCronRunHistoryPageForTests,
  readCronRunRecordsForTests,
} from "../run-history.test-support.js";
import { stop } from "../service/ops-lifecycle.js";
import { list } from "../service/ops-read.js";
import { enqueueRun } from "../service/ops-run.js";
import { onTimer } from "../service/timer.test-support.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronEvent, CronStoredJob } from "../types.js";
import {
  getChannelPluginMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-account-outcome-" });
const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

beforeEach(() => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  resetRunCronIsolatedAgentTurnHarness();
  mockRunCronFallbackPassthrough();
  getChannelPluginMock.mockReturnValue({
    config: {
      listAccountIds: (cfg: OpenClawConfig) => [
        "default",
        ...Object.keys(cfg.channels?.whatsapp?.accounts ?? {}),
      ],
    },
  });
});

afterEach(() => vi.unstubAllEnvs());

type AccountCase = [
  name: string,
  accountId: string | undefined,
  toolsAllow: string[] | undefined,
  fails: boolean,
  options?: { manual?: boolean; channel?: string },
];
it.each<AccountCase>([
  ["removed named account", "removed", ["read"], true],
  [
    "removed named account after manual invocation ends",
    "removed",
    ["read"],
    true,
    { manual: true },
  ],
  ["legacy accountless cap", undefined, ["read"], false],
  ["legacy capless job", undefined, undefined, false],
  ["intentional no-tool job", "work", [], false],
  ["configured DM account without delivery", "work", ["read"], false, { channel: "whatsapp" }],
  ["DM account with malformed creator origin", "work", ["read"], true, { channel: "" }],
])(
  "records %s through scheduler and history",
  async (name, accountId, toolsAllow, fails, options = {}) => {
    const ownerSessionKey = `agent:main:whatsapp:${options.channel !== undefined ? "direct:sender" : "group:team"}`;
    const { storePath } = fixtures.makeStorePath();
    const sessionRoot = join(dirname(storePath), basename(storePath, ".jobs.json"));
    const sessionStorePath = join(sessionRoot, "sessions.json");
    const cfg: OpenClawConfig = {
      session: { store: sessionStorePath },
      channels: { whatsapp: { accounts: { work: {} } } },
    };
    setRuntimeConfigSnapshot(cfg);
    resolveCronSessionMock.mockReturnValue(makeCronSession({ storePath: sessionStorePath }));
    const job: CronStoredJob = {
      ...createDueIsolatedJob({
        id: name.replaceAll(" ", "-"),
        nowMs: Date.now(),
        nextRunAtMs: Date.now(),
      }),
      agentId: "main",
      owner: {
        agentId: "main",
        sessionKey: ownerSessionKey,
        ...(accountId ? { accountId } : {}),
      },
      payload: { kind: "agentTurn", message: "Summarize the report", toolsAllow },
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey,
        ownerAccountId: accountId ?? "removed",
      },
      toolsAllowProvenance:
        options.channel === undefined
          ? undefined
          : {
              version: 1,
              source: "final-executable-surface",
              callerOrigin: { kind: "external", channel: options.channel },
            },
    };
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const events: CronEvent[] = [];
    const continuePayload = createDeferredCore();
    const state = createCronRegressionState({
      storePath,
      defaultAgentId: "main",
      onEvent: (event) => events.push(structuredClone(event)),
      runSchedulerOwned: createScheduledGatewayRunner(),
      runIsolatedAgentJob: async (params) => {
        await continuePayload.promise;
        return await runCronIsolatedAgentTurn({
          ...params,
          cfg,
          deps: {},
          sessionKey: `cron:${params.job.id}`,
        });
      },
    });
    try {
      await list(state);
      if (options.manual) {
        const ack = await withOperatorToolGatewayAuthority(
          { scopes: ["operator.admin"], operatorRoleActor: { kind: "system" } },
          () => enqueueRun(state, job.id, "force"),
        );
        expect(ack).toMatchObject({ ok: true, enqueued: true });
        assert("runId" in ack, "Expected an accepted manual run");
        const settled = expectDefined(state.queuedManualRuns.get(ack.runId), "queued run");
        // The initiating invocation has closed, but the stored account policy must still apply.
        continuePayload.resolve();
        await settled;
      } else {
        continuePayload.resolve();
        await onTimer(state);
      }
      const persisted = (await loadCronStore(storePath)).jobs[0];
      const history = readCronRunHistoryPageForTests({
        storeKey: cronStoreKey(storePath),
        jobId: job.id,
      });
      const tasks = readCronRunRecordsForTests(job.id);
      const expectedStatus = fails ? "error" : "ok";
      const completionStatus = fails ? "failed" : "succeeded";
      expect(persisted?.state.lastRunStatus).toBe(expectedStatus);
      expect(history.entries).toMatchObject([{ status: expectedStatus, completionStatus }]);
      expect(tasks).toMatchObject([{ status: completionStatus }]);
      expect(events.filter((event) => event.action === "finished")).toEqual([
        expect.objectContaining({ status: expectedStatus }),
      ]);
      if (fails) {
        const reason = persisted?.state.lastError;
        expect(reason).toContain(`Scheduled account "${accountId}" is unavailable`);
        expect(history.entries[0]?.error).toBe(reason);
        expect(history.entries[0]?.diagnostics?.summary).toContain(reason);
        expect(persisted?.state.lastDiagnosticSummary).toContain(reason);
        expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
      } else {
        expect(persisted?.state.lastError).toBeUndefined();
        expect(runEmbeddedAgentMock.mock.calls[0]?.[0].toolsAllow).toEqual(toolsAllow);
        if (!accountId) {
          expect(runEmbeddedAgentMock.mock.calls[0]?.[0].scheduledToolPolicy).toBeUndefined();
        }
      }
    } finally {
      continuePayload.resolve();
      stop(state);
      await state.schedulerDrain;
      await closeOpenClawAgentDatabasesAsync(sessionRoot);
    }
  },
);
