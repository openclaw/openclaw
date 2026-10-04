import { describe, expect, it } from "vitest";
import { observeCronJobWrites } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { CronService } from "../../cron/service.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import type { CronJob, CronJobCreate } from "../../cron/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  consumeCronCreatorAuthorityGrant,
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "../cron-creator-authority-grant.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import {
  cronJobMatchesCallerScope,
  cronJobMatchesDeclarationScope,
  readCronCallerScope,
  resolveCronMutationCommitGuard,
} from "./cron-caller-scope.js";

function createScopedJob(): CronJob {
  return {
    id: "ops-job",
    name: "Ops job",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    sessionKey: "agent:ops:main",
    agentId: " ",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "work" },
    state: {},
  };
}

describe("cron caller scope ownership", () => {
  it.each([false, true])(
    "rechecks consumed creator authority before a job update commits (revoked=%s)",
    async (revokeBeforeCommit) => {
      await withOpenClawTestState({ label: "cron-creator-commit-authority" }, async (fixture) => {
        const now = Date.now();
        const storePath = fixture.statePath("cron", "jobs.json");
        const job = createDueIsolatedJob({ id: "creator-owned", nowMs: now, nextRunAtMs: now });
        await saveCronStore(storePath, { version: 1, jobs: [job] });
        const state = createCronRegressionState({
          storePath,
          cronEnabled: false,
          defaultAgentId: "main",
          nowMs: () => now,
          runIsolatedAgentJob: async () => ({ status: "ok" }),
        });
        const cron = new CronService(state.deps);
        let issuerCurrent = true;
        const operationalRunInstance = createOperationalRunInstanceRef("creator-commit");
        const scope = createCronCreatorAuthorityRunScope(operationalRunInstance.runId, {
          kind: "local",
        });
        const grant = mintCronCreatorAuthorityGrant(
          scope,
          undefined,
          undefined,
          undefined,
          "requester",
          () => issuerCurrent,
        );
        const client = createSyntheticPluginRuntimeClient();
        client.internal = {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:main",
            operationalRunInstance,
            cronCreatorAuthorityGrant: grant,
          },
        };
        const context = createDirectChatContext({ cron, cronStorePath: storePath });
        const commitGuard = resolveCronMutationCommitGuard(client, context);
        if (!commitGuard) {
          throw new Error("Creator fixture did not retain its commit guard");
        }
        let observedWrite = false;
        const stopObserving = observeCronJobWrites(job.id, () => {
          observedWrite = true;
          if (revokeBeforeCommit) {
            issuerCurrent = false;
          }
        });
        try {
          const update = cron.update(job.id, { name: "committed creator update" }, { commitGuard });
          if (revokeBeforeCommit) {
            await expect(update).rejects.toThrow("no longer active");
          } else {
            await expect(update).resolves.toMatchObject({ name: "committed creator update" });
          }
          expect(observedWrite).toBe(true);
          expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow("no longer active");
          const persisted = (await loadCronStore(storePath)).jobs.find(
            (entry) => entry.id === job.id,
          );
          expect(persisted?.name).toBe(revokeBeforeCommit ? job.name : "committed creator update");
        } finally {
          stopObserving();
          cron.stop();
          revokeCronCreatorAuthorityRunScope(scope);
        }
      });
    },
  );

  it.each([
    [
      "external channel",
      { turnSourceChannel: " Discord " },
      { kind: "external", channel: "discord" },
    ],
    ["explicit local", { turnSourceLocal: true }, { kind: "local" }],
    ["missing", {}, { kind: "unknown" }],
  ] as const)(
    "stamps %s creator origin without reading the routing key",
    (_label, source, origin) => {
      const scope = readCronCallerScope({
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:main",
            turnSourceAccountId: "work",
            cronToolsAllowCapture: "final-executable-surface",
            ...source,
          },
        },
      } as never);

      expect(scope?.toolsAllowProvenance?.callerOrigin).toEqual(origin);
    },
  );

  it("uses an admitted local grant over its webchat transport label", () => {
    const runId = "local-webchat-run";
    const capability = createCronCreatorAuthorityRunScope(runId, { kind: "local" });
    const grant = mintCronCreatorAuthorityGrant(
      capability,
      undefined,
      undefined,
      undefined,
      "requester",
    );
    const scope = readCronCallerScope({
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey: "agent:main:control-ui",
          turnSourceAccountId: "work",
          turnSourceChannel: "webchat",
          operationalRunInstance: { runId },
          cronCreatorAuthorityGrant: grant,
        },
      },
    } as never);

    expect(scope?.toolsAllowProvenance).toEqual({
      version: 1,
      source: "authenticated-requester",
      callerOrigin: { kind: "local" },
    });
    revokeCronCreatorAuthorityRunScope(capability);
  });

  it("uses a scoped session key before the configured default", () => {
    const job = createScopedJob();

    expect(
      cronJobMatchesCallerScope({
        job,
        callerScope: { kind: "agentTool", agentId: "main", accountId: "default" },
        defaultAgentId: "main",
      }),
    ).toBe(false);
    expect(
      cronJobMatchesCallerScope({
        job,
        callerScope: { kind: "agentTool", agentId: "ops", accountId: "default" },
        defaultAgentId: "main",
      }),
    ).toBe(true);

    const input: CronJobCreate = {
      ...job,
      id: undefined,
      state: undefined,
    };
    expect(
      cronJobMatchesDeclarationScope({
        job,
        input,
        callerScope: undefined,
        defaultAgentId: "main",
      }),
    ).toBe(true);
  });
});
