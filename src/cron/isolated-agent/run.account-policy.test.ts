import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import "../../agents/test-helpers/fast-coding-tools.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listTaskRegistryRecordsByRuntimeSourceIdFromSqlite } from "../../tasks/task-registry.store.sqlite.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { stop } from "../service/ops-lifecycle.js";
import { list } from "../service/ops-read.js";
import type { CronEvent } from "../service/state.js";
import { onTimer } from "../service/timer-scheduler.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { readCronTaskRunHistoryPage } from "../task-run-history.js";
import type { CronJob } from "../types.js";
import {
  getChannelPluginMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
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

afterEach(() => {
  vi.unstubAllEnvs();
  resetTaskRegistryForTests({ persist: false });
});

describe("scheduled account policy outcomes", () => {
  it.each([
    { name: "removed named account", accountId: "removed", toolsAllow: ["read"], fails: true },
    { name: "configured named account", accountId: "work", toolsAllow: ["read"], fails: false },
    { name: "default account", accountId: "default", toolsAllow: ["read"], fails: false },
    { name: "legacy accountless cap", accountId: undefined, toolsAllow: ["read"], fails: false },
    { name: "legacy capless job", accountId: undefined, toolsAllow: undefined, fails: false },
    { name: "intentional no-tool job", accountId: "work", toolsAllow: [], fails: false },
  ])(
    "records $name through scheduler and history",
    async ({ name, accountId, toolsAllow, fails }) => {
      const { storePath } = fixtures.makeStorePath();
      const cfg: OpenClawConfig = { channels: { whatsapp: { accounts: { work: {} } } } };
      const ownerSessionKey = "agent:main:whatsapp:group:team";
      const job: CronJob = {
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
      };
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const events: CronEvent[] = [];
      const warn = vi.fn();
      const state = createCronRegressionState({
        storePath,
        defaultAgentId: "main",
        log: { ...noopLogger, warn },
        onEvent: (event) => events.push(structuredClone(event)),
        runIsolatedAgentJob: (params) =>
          runCronIsolatedAgentTurn({
            ...params,
            cfg,
            deps: {},
            sessionKey: `cron:${params.job.id}`,
          }),
      });
      try {
        await list(state);
        await onTimer(state);
        const persisted = (await loadCronStore(storePath)).jobs[0];
        const history = readCronTaskRunHistoryPage({
          storeKey: cronStoreKey(storePath),
          jobId: job.id,
        });
        const tasks = listTaskRegistryRecordsByRuntimeSourceIdFromSqlite({
          runtime: "cron",
          sourceId: job.id,
        });
        expect(history.entries).toHaveLength(1);
        expect(tasks).toHaveLength(1);
        const expectedStatus = fails ? "error" : "ok";
        expect(persisted?.state.lastRunStatus).toBe(expectedStatus);
        expect(history.entries[0]).toMatchObject({
          status: expectedStatus,
          completionStatus: fails ? "failed" : "succeeded",
        });
        expect(tasks[0]?.status).toBe(fails ? "failed" : "succeeded");
        expect(events.filter((event) => event.action === "finished")).toEqual([
          expect.objectContaining({ status: expectedStatus }),
        ]);
        if (fails) {
          const reason = persisted?.state.lastError;
          expect(reason).toContain('Scheduled account "removed" is unavailable');
          expect(reason).toContain("Re-add");
          expect(history.entries[0]?.error).toBe(reason);
          expect(history.entries[0]?.diagnostics?.summary).toContain(reason);
          expect(persisted?.state.lastDiagnosticSummary).toContain(reason);
          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ error: reason }),
            "cron: job run returned error status",
          );
          expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
        } else {
          expect(persisted?.state.lastError).toBeUndefined();
          expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
          expect(runEmbeddedAgentMock.mock.calls[0]?.[0].toolsAllow).toEqual(toolsAllow);
          if (!accountId) {
            expect(runEmbeddedAgentMock.mock.calls[0]?.[0].scheduledToolPolicy).toBeUndefined();
          }
        }
      } finally {
        stop(state);
      }
    },
  );
});
