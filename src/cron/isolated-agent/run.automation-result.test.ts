import { expect, it } from "vitest";
import { createAutomationResultRecorder } from "../../infra/agent-run-registry.automation.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as h from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await h.loadRunCronIsolatedAgentTurn();

setupRunCronIsolatedAgentTurnSuite();

it("refreshes scheduled skills without advancing conversation recency before inference", async () => {
  h.mockRunCronFallbackPassthrough();
  const previous = h.makeCronSessionEntry({ updatedAt: 123, lifecycleRevision: "v1" });
  const session = h.makeCronSession({
    sessionEntry: { ...previous },
    initialSessionEntry: previous,
    lifecycleRevision: "v1",
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
      job: { sessionTarget: `session:${sessionKey}` },
    }),
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe("ok");
  expect(session.sessionEntry.skillsSnapshot).toBeDefined();
  expect(preparedUpdatedAt).toBe(previous.updatedAt);
  expect(session.sessionEntry.updatedAt).toBe(previous.updatedAt);
});

const pendingToolCalls = [{ id: "pending-check", name: "check", arguments: "{}" }];
it.each([
  ["no_change", {}, true, true],
  ["progress", {}, true, false],
  ["no_change", { error: { message: "Execution failed." } }, true, false],
  ["progress", { error: { message: "Execution failed." } }, true, false],
  ["no_change", { yielded: true }, false, false],
  ["no_change", { continuationPending: true }, false, false],
  ["no_change", { pendingToolCalls }, false, false],
] as const)("settles %s only when finished: %j", async (outcome, meta, settled, quiet) => {
  h.mockRunCronFallbackPassthrough();
  h.resolveCronDeliveryPlanMock.mockReturnValue({ requested: true, mode: "announce" });
  let record: ReturnType<typeof createAutomationResultRecorder> | undefined;
  h.runEmbeddedAgentMock.mockImplementationOnce(async ({ runId }) => {
    record = createAutomationResultRecorder(runId, "test-job");
    record(outcome === "no_change" ? { outcome } : { outcome, summary: "Checked the queue." });
    return {
      payloads: [{ text: "Checked the queue." }],
      meta: { agentMeta: {}, ...meta },
    };
  });
  const params = makeIsolatedAgentParamsFixture({ job: { delivery: { mode: "announce" } } });
  const result = await runCronIsolatedAgentTurn(params);
  const failed = "error" in meta;
  if (settled) {
    expect(result.status).toBe(failed ? "error" : "ok");
    expect(result.summary).toBe(
      failed
        ? "cron isolated run failed: Execution failed."
        : outcome === "no_change"
          ? undefined
          : "Checked the queue.",
    );
    expect(result.result).toEqual(
      outcome === "no_change" ? { outcome } : { outcome, summary: "Checked the queue." },
    );
    expect(() => record?.({ outcome: "done", summary: "Late result." })).toThrow(
      "Automation invocation is no longer active",
    );
  } else {
    expect(result.result).toBeUndefined();
  }
  expect(h.dispatchCronDeliveryMock).toHaveBeenCalledWith(
    expect.objectContaining({ skipDelivery: quiet ? "silent" : undefined }),
  );
});
