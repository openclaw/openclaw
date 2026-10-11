import { describe, expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
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
import {
  cronJobMatchesCallerScope,
  cronJobMatchesDeclarationScope,
  readCronCallerScope,
  resolveCronCreatorAuthorityCapture,
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
  it.each(["before dispatch", "after commit"] as const)(
    "handles creator revocation %s without misreporting the stored update",
    async (revocation) => {
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
        const scope = createCronCreatorAuthorityRunScope("creator-commit", { kind: "local" });
        const authority = {
          version: 1 as const,
          runtimeId: "codex",
          namespace: "codex.apps",
          payload: { apps: [{ id: "calendar" }] },
        };
        const grant = mintCronCreatorAuthorityGrant(
          scope,
          undefined,
          authority,
          undefined,
          "runtime",
          () => issuerCurrent,
        );
        const capture = resolveCronCreatorAuthorityCapture({
          kind: "agentTool",
          agentId: "main",
          accountId: "default",
          cronCreatorAuthorityGrant: grant,
          toolsAllowProvenance: { version: 1, source: "final-executable-surface" },
        });
        if (!capture) {
          throw new Error("Creator fixture did not retain its runtime capture");
        }
        const captureRuntimeAuthority = vi.fn(() => {
          const captured = capture.captureRuntimeAuthority();
          if (revocation === "before dispatch") {
            issuerCurrent = false;
          }
          return captured;
        });
        let observedCommit = false;
        const stopObserving = observeCronJobCommits(job.id, () => {
          observedCommit = true;
          if (revocation === "after commit") {
            issuerCurrent = false;
          }
        });
        try {
          const update = cron.update(
            job.id,
            { name: "committed creator update" },
            { captureRuntimeAuthority, commitGuard: capture.assertCurrent },
          );
          if (revocation === "before dispatch") {
            await expect(update).rejects.toThrow("no longer active");
          } else {
            await expect(update).resolves.toMatchObject({ name: "committed creator update" });
          }
          expect(observedCommit).toBe(revocation === "after commit");
          expect(captureRuntimeAuthority).toHaveBeenCalledOnce();
          expect(captureRuntimeAuthority.mock.results[0]?.value).toEqual(authority);
          expect(capture.assertCurrent).toThrow("no longer active");
          expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow("no longer active");
          const persisted = (await loadCronStore(storePath)).jobs.find(
            (entry) => entry.id === job.id,
          );
          expect(persisted?.name).toBe(
            revocation === "before dispatch" ? job.name : "committed creator update",
          );
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
            cronExecToolTarget: { host: "gateway", ask: "always" },
            ...source,
          },
        },
      } as never);

      expect(scope?.toolsAllowProvenance?.callerOrigin).toEqual(origin);
      expect(scope?.toolsAllowExecTarget).toEqual({
        version: 1,
        host: "gateway",
        ask: "always",
      });
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
