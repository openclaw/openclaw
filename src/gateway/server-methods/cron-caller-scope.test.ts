import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { observeCronJobCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { cronTestInput } from "../../cron/service.fixture-builders.test-support.js";
import { CronService } from "../../cron/service.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import {
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "../cron-creator-authority-grant.js";
import {
  applyCronCreateCallerScopeDefault,
  bindCronCreateExecutionAgent,
  cronJobMatchesCallerScope,
  readCronCallerScope,
  resolveCronCreatorAuthorityCapture,
  type CronCallerScope,
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
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createCronJob({ payload: { kind: "agentTurn", message: "creator" } });
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const cron = new CronService(
        createCronRegressionState({
          storePath,
          cronEnabled: false,
          defaultAgentId: "main",
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
        payload: {},
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
      const captureRuntimeAuthority = () => {
        const captured = capture.captureRuntimeAuthority();
        expect(captured).toEqual(authority);
        issuerCurrent = revocation !== "before dispatch";
        return captured;
      };
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
        expect(capture.assertCurrent).toThrow("no longer active");
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
});

describe("create-time execution agent", () => {
  const workerSessionJob = (overrides: Partial<Parameters<typeof cronTestInput>[0]> = {}) =>
    cronTestInput({
      name: "probe",
      sessionTarget: "session:agent:worker:dashboard:2b6f1c9a",
      payload: { kind: "agentTurn", message: "ping" },
      ...overrides,
    });
  const mainCaller: CronCallerScope = {
    kind: "agentTool",
    agentId: "main",
    accountId: "default",
  };

  it("names the agent that owns the session the due run opens", () => {
    expect(bindCronCreateExecutionAgent(workerSessionJob()).agentId).toBe("worker");
    expect(
      bindCronCreateExecutionAgent(
        workerSessionJob({ sessionTarget: "isolated", sessionKey: "agent:ops:main" }),
      ).agentId,
    ).toBe("ops");
  });

  it("keeps an explicit agent and names no owner for a detached or malformed target", () => {
    expect(bindCronCreateExecutionAgent(workerSessionJob({ agentId: "ops" })).agentId).toBe("ops");
    for (const sessionTarget of [
      "isolated",
      "current",
      "main",
      "session:",
      "session:\u0000",
    ] as const) {
      expect(bindCronCreateExecutionAgent(workerSessionJob({ sessionTarget })).agentId).toBe(
        undefined,
      );
    }
  });

  it("keeps the creating caller as the recorded owner while execution follows the session", () => {
    // Both caller-scope outcomes are asserted through the real admission boundary in
    // cron.gateway-policy.integration.test.ts ("still refuses an agent caller a job that another
    // agent would execute"); this pins only the attribution contract that nothing else covers.
    const bound = applyCronCreateCallerScopeDefault(
      bindCronCreateExecutionAgent(workerSessionJob()),
      mainCaller,
    );
    expect(bound).toMatchObject({
      agentId: "worker",
      owner: { agentId: "main", accountId: "default" },
    });
  });
});
