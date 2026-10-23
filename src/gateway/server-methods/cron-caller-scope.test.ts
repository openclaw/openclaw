import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { CronService } from "../../cron/service.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
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
import { createCronCallerClient, createCronJob } from "./cron.validation.test-support.js";

function readScope(overrides: Partial<AgentRuntimeIdentity>) {
  const client = createCronCallerClient("main", "work");
  Object.assign(client.internal!.agentRuntimeIdentity!, overrides);
  return readCronCallerScope(client);
}

it.each(["before dispatch", "after commit"] as const)(
  "handles creator revocation %s without misreporting the stored update",
  async (revocation) => {
    await withOpenClawTestState({ label: "cron-creator-commit-authority" }, async (fixture) => {
      const now = Date.now();
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createDueIsolatedJob({ id: "creator-owned", nowMs: now, nextRunAtMs: now });
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const cron = new CronService(
        createCronRegressionState({
          storePath,
          cronEnabled: false,
          defaultAgentId: "main",
          nowMs: () => now,
          runIsolatedAgentJob: async () => ({ status: "ok" }),
        }).deps,
      );
      let issuerCurrent = true;
      const name = "committed creator update";
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
      const capture = expectDefined(
        resolveCronCreatorAuthorityCapture({
          kind: "agentTool",
          agentId: "main",
          accountId: "default",
          cronCreatorAuthorityGrant: grant,
          toolsAllowProvenance: { version: 1, source: "final-executable-surface" },
        }),
        "creator runtime capture",
      );
      const captureRuntimeAuthority = vi.fn(() => {
        const captured = capture.captureRuntimeAuthority();
        issuerCurrent = revocation !== "before dispatch";
        return captured;
      });
      let observedCommit = false;
      const stopObserving = observeCronJobCommits(job.id, () => {
        observedCommit = true;
        issuerCurrent = revocation !== "after commit";
      });
      try {
        const options = { captureRuntimeAuthority, commitGuard: capture.assertCurrent };
        const update = cron.update(job.id, { name }, options);
        if (revocation === "before dispatch") {
          await expect(update).rejects.toThrow("no longer active");
        } else {
          await expect(update).resolves.toMatchObject({ name });
        }
        expect(observedCommit).toBe(revocation === "after commit");
        expect(captureRuntimeAuthority).toHaveBeenCalledOnce();
        expect(captureRuntimeAuthority.mock.results[0]?.value).toEqual(authority);
        expect(capture.assertCurrent).toThrow("no longer active");
        expect(() => consumeCronCreatorAuthorityGrant(grant)).toThrow("no longer active");
        const persisted = (await loadCronStore(storePath)).jobs.find((j) => j.id === job.id);
        expect(persisted?.name).toBe(revocation === "before dispatch" ? job.name : name);
      } finally {
        stopObserving();
        cron.stop();
        revokeCronCreatorAuthorityRunScope(scope);
      }
    });
  },
);

it.each([
  ["external", { turnSourceChannel: " Discord " }, { kind: "external", channel: "discord" }],
  ["explicit local", { turnSourceLocal: true }, { kind: "local" }],
  ["missing", {}, { kind: "unknown" }],
] as const)(
  "stamps %s creator origin without reading the routing key",
  (_label, source, origin) => {
    const scope = readScope({
      cronToolsAllowCapture: "final-executable-surface",
      cronExecToolTarget: { host: "gateway", ask: "always" },
      ...source,
    });

    expect(scope?.toolsAllowProvenance?.callerOrigin).toEqual(origin);
    expect(scope?.toolsAllowExecTarget).toEqual({ version: 1, host: "gateway", ask: "always" });
  },
);

it("uses an admitted local grant over its webchat transport label", () => {
  const runId = "local-webchat-run";
  const run = createCronCreatorAuthorityRunScope(runId, { kind: "local" });
  const grant = mintCronCreatorAuthorityGrant(run, undefined, undefined, undefined, "requester");
  const scope = readScope({
    sessionKey: "agent:main:control-ui",
    turnSourceChannel: "webchat",
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    cronCreatorAuthorityGrant: grant,
  });

  expect(scope?.toolsAllowProvenance).toEqual({
    version: 1,
    source: "authenticated-requester",
    callerOrigin: { kind: "local" },
  });
  revokeCronCreatorAuthorityRunScope(run);
});

it("uses a scoped session key before the configured default", () => {
  const job = createCronJob({
    sessionTarget: "main",
    sessionKey: "agent:ops:main",
    agentId: " ",
  });
  const matches = (agentId: string) =>
    cronJobMatchesCallerScope({
      job,
      callerScope: { kind: "agentTool", agentId, accountId: "default" },
      defaultAgentId: "main",
    });
  expect([matches("main"), matches("ops")]).toEqual([false, true]);

  expect(
    cronJobMatchesDeclarationScope({
      job,
      input: { ...job, id: undefined, state: undefined },
      callerScope: undefined,
      defaultAgentId: "main",
    }),
  ).toBe(true);
});
