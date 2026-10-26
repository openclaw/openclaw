import { describe, expect, it, vi } from "vitest";
import { createDueIsolatedJob } from "../../test/helpers/cron/service-regression-fixtures.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../gateway/agent-runtime-approval-authority.js";
import { readJob, withCronGatewayState } from "./service/ops.gateway.test-support.js";
import { saveCronStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

const { claimAgentRunContext, releaseAgentRunContext } =
  await import("../infra/agent-run-registry.js");
const { resolveAdmittedRunActiveAssertion } = await import("../agents/admitted-run-context.js");
const { createAdmittedGatewayToolCallerIdentity, withGatewayToolCallerIdentity } =
  await import("../agents/tools/gateway-caller-context.js");
const { resolveGatewayScopedTools } = await import("../gateway/tool-resolution.js");
const { admitScheduledOccurrence } = await import("./execution-context-admission.js");
const { prepareCronRunAdmission } = await import("./run-admission.js");

type Outcome = { ok: true; details: unknown } | { ok: false; error: string };

/**
 * Forces one run of a stored operator job on a real CronService, Gateway cron
 * handlers and store. The run's CLI loopback automations tool removes the run's
 * own job. With `settleDuringRemove`, the service's `remove` is held before it
 * reaches persistence; the run settles (invocation closed, run context
 * released, admission closed) and then the real removal proceeds.
 */
async function removeOwnJobFromCliRun(settleDuringRemove: boolean) {
  let outcome: Outcome | undefined;
  let stored: unknown;
  await withCronGatewayState(async (fixture) => {
    const now = Date.now();
    const job = {
      ...createDueIsolatedJob({ id: "self-job", nowMs: now, nextRunAtMs: now + 3_600_000 }),
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    } as CronStoredJob;
    const sibling = createDueIsolatedJob({
      id: "sibling-job",
      nowMs: now,
      nextRunAtMs: now + 3_600_000,
    });
    await saveCronStore(fixture.storePath, { version: 1, jobs: [job, sibling] });
    Object.assign(fixture.context, {
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    const runKey = `agent:main:cron:${job.id}:run:s1`;
    replaceSessionEntrySync({ sessionKey: runKey }, { sessionId: "run-session", updatedAt: now });

    // Holds the service's removal before persistence until the run has settled.
    let resume = () => {};
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered = () => {};
    const removeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const remove = fixture.cron.remove.bind(fixture.cron);
    vi.spyOn(fixture.cron, "remove").mockImplementation(async (...args) => {
      entered();
      if (settleDuringRemove) {
        await held;
      }
      return await remove(...args);
    });

    vi.mocked(fixture.runIsolatedAgentJob).mockImplementation(async ({ executionIdentity }) => {
      const occurrence = await admitScheduledOccurrence({
        cfg: fixture.cfg,
        job,
        agentId: "main",
        trigger: "cron",
      });
      const admission = prepareCronRunAdmission({
        cfg: fixture.cfg,
        agentId: "main",
        runId: "run-1",
        sessionKey: runKey,
        jobId: job.id,
        deliveryAttemptFence: null,
        resolveGatewayContext: () => fixture.context,
        scheduledExecution: occurrence.mint({
          cfg: fixture.cfg,
          agentId: "main",
          runId: "run-1",
          runSessionKey: runKey,
          toolsAllow: ["*"],
        }),
      });
      const invocation: { nextCheckEnabled: boolean; assertCurrent: () => void; closed?: boolean } =
        { nextCheckEnabled: false, assertCurrent: () => {} };
      let claim: string | undefined;
      // Settles the run the way src/cron/isolated-agent/run.ts does.
      const settle = () => {
        if (!invocation.closed) {
          invocation.closed = true;
          releaseAgentRunContext("run-1", claim);
          admission.close();
        }
      };
      try {
        const admitted = await admission.preparedRunAdmission.admit("embedded");
        await executionIdentity?.onPostAdmission?.(admitted);
        invocation.assertCurrent = resolveAdmittedRunActiveAssertion(admitted) ?? (() => {});
        claim = claimAgentRunContext(
          "run-1",
          { sessionKey: runKey, cronRunsByJobId: new Map([[job.id, invocation]]) },
          { trackOwner: true, ownsContext: true },
        );
        const tools = (
          await resolveGatewayScopedTools({
            cfg: fixture.cfg,
            sessionKey: runKey,
            sessionId: "run-session",
            runId: "run-1",
            senderIsOwner: false,
            surface: "loopback",
            admittedRunContext: admitted,
            toolsAllow: ["*"],
          })
        ).tools;
        const automations = tools.find((tool) => tool.name === "automations");
        if (!automations) {
          throw new Error("the CLI run was not offered automations");
        }
        const caller = createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey: runKey,
        });
        const call = withGatewayToolCallerIdentity(caller, () =>
          automations.execute("remove", { action: "remove", jobId: job.id }),
        ).then(
          (result): Outcome => ({ ok: true, details: result.details }),
          (error: unknown): Outcome => ({ ok: false, error: String(error) }),
        );
        if (settleDuringRemove) {
          await removeEntered;
          settle();
          resume();
        }
        outcome = await call;
        return { status: "ok" as const };
      } finally {
        settle();
        occurrence.release();
      }
    });
    await fixture.cron.run(job.id, "force");
    await vi.waitFor(() => expect(outcome).toBeDefined());
    await fixture.settle();
    stored = {
      self: await readJob(fixture, job.id),
      sibling: await readJob(fixture, sibling.id),
    };
  });
  return { outcome: outcome!, stored: stored as { self?: CronStoredJob; sibling?: CronStoredJob } };
}

describe("CLI self-removal through the real cron service", () => {
  it("removes the run's own job from the store while the run is current", async () => {
    const { outcome, stored } = await removeOwnJobFromCliRun(false);
    expect(outcome).toEqual({ ok: true, details: expect.objectContaining({ removed: true }) });
    expect(stored.self).toBeUndefined();
    expect(stored.sibling).toMatchObject({ id: "sibling-job" });
  });

  it("refuses the removal and keeps the stored job when the run settles before persistence", async () => {
    const { outcome, stored } = await removeOwnJobFromCliRun(true);
    expect(outcome).toEqual({
      ok: false,
      error: expect.stringMatching(/no longer active|exact live run/),
    });
    expect(stored.self).toMatchObject({ id: "self-job", enabled: true });
    expect(stored.sibling).toMatchObject({ id: "sibling-job" });
  });
});
