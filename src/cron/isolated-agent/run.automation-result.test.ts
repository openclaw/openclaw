import { describe, expect, it } from "vitest";
import { createAutomationResultRecorder } from "../../infra/agent-run-registry.automation.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as h from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await h.loadRunCronIsolatedAgentTurn();

describe("isolated automation result settlement", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("refreshes scheduled skills without advancing conversation recency before inference", async () => {
    h.mockRunCronFallbackPassthrough();
    const previous = h.makeCronSessionEntry({
      updatedAt: 123,
      lifecycleRevision: "existing-revision",
    });
    const session = h.makeCronSession({
      sessionEntry: { ...previous },
      initialSessionEntry: previous,
      lifecycleRevision: "existing-revision",
      isNewSession: false,
    });
    h.resolveCronSessionMock.mockReturnValue(session);
    h.loadSessionEntryMock.mockImplementation(() => session.initialSessionEntry);
    let preparedUpdatedAt: number | undefined;
    h.runEmbeddedAgentMock.mockImplementationOnce(async ({ runId }) => {
      preparedUpdatedAt = session.sessionEntry.updatedAt;
      createAutomationResultRecorder(runId, "test-job")({ outcome: "no_change" });
      return { payloads: [], meta: { agentMeta: {} } };
    });
    const sessionKey = "agent:default:dashboard:scheduled-check";
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        sessionKey,
        job: makeIsolatedAgentJobFixture({ sessionTarget: `session:${sessionKey}` }),
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("ok");
    expect(h.buildWorkspaceSkillSnapshotMock).toHaveBeenCalled();
    expect(session.sessionEntry.skillsSnapshot).toBeDefined();
    expect(preparedUpdatedAt).toBe(previous.updatedAt);
    expect(h.runEmbeddedAgentMock).toHaveBeenCalledOnce();
    expect(session.sessionEntry.updatedAt).toBe(previous.updatedAt);
  });

  it.each([
    { outcome: "no_change", failed: false, quiet: true, status: "ok" },
    { outcome: "progress", failed: false, quiet: false, status: "ok" },
    { outcome: "no_change", failed: true, quiet: false, status: "error" },
    { outcome: "progress", failed: true, quiet: false, status: "error" },
  ] as const)(
    "settles $outcome without masking failure=$failed",
    async ({ outcome, failed, quiet, status }) => {
      h.mockRunCronFallbackPassthrough();
      h.resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, mode: "announce" });
      let record: ReturnType<typeof createAutomationResultRecorder> | undefined;
      h.runEmbeddedAgentMock.mockImplementationOnce(async ({ runId }) => {
        record = createAutomationResultRecorder(runId, "test-job");
        record(outcome === "no_change" ? { outcome } : { outcome, summary: "Checked the queue." });
        return {
          payloads: [{ text: "Checked the queue." }],
          meta: { agentMeta: {}, ...(failed ? { error: { message: "Execution failed." } } : {}) },
        };
      });
      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          job: makeIsolatedAgentJobFixture({ delivery: { mode: "announce" } }),
        }),
      );
      expect(result.status).toBe(status);
      expect(result.summary).toBe(
        failed
          ? "cron isolated run failed: Execution failed."
          : outcome === "no_change"
            ? undefined
            : "Checked the queue.",
      );
      expect(h.dispatchCronDeliveryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          skipDelivery: quiet ? "silent" : undefined,
        }),
      );
      expect(result.result).toEqual(
        outcome === "no_change" ? { outcome } : { outcome, summary: "Checked the queue." },
      );
      expect(() => record?.({ outcome: "done", summary: "Late result." })).toThrow(
        "Automation invocation is no longer active",
      );
    },
  );

  it.each([
    { yielded: true },
    { continuationPending: true },
    { pendingToolCalls: [{ id: "pending-check", name: "check", arguments: "{}" }] },
  ])("does not settle or silence an unfinished no_change turn: %j", async (pending) => {
    h.mockRunCronFallbackPassthrough();
    h.resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, mode: "announce" });
    h.runEmbeddedAgentMock.mockImplementationOnce(async ({ runId }) => {
      createAutomationResultRecorder(runId, "test-job")({ outcome: "no_change" });
      return { payloads: [{ text: "The check is still running." }], meta: { ...pending } };
    });
    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        job: makeIsolatedAgentJobFixture({ delivery: { mode: "announce" } }),
      }),
    );
    expect(result.result).toBeUndefined();
    expect(h.dispatchCronDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({ skipDelivery: undefined }),
    );
  });
});
