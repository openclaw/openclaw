import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import { resolveAdmittedRunActiveAssertion } from "../agents/admitted-run-context.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import {
  SESSION_ID,
  installRequesterCronAuthorityTestHooks,
} from "../gateway/server-methods/requester-cron-authority.test-support.js";
import {
  createPrAutomationFixture,
  readPrAutomationRecipeTarget,
} from "./service.pr-automation.test-support.js";
import { runCronSessionTurn } from "./session-run.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";

// mock-isolation: Keep ordinary reply admission real while replacing inference at its runtime entry.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
installRequesterCronAuthorityTestHooks();
beforeEach(() => {
  runEmbeddedAgentMock.mockReset();
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
});

it("transports autoFix for only the selected PR across session replacement and disables future effects", async () => {
  const fixture = await createPrAutomationFixture(
    "autoFix",
    (config) => ({
      runIsolatedAgentJob: vi.fn(async () => {
        throw new Error("Shared-session PR automation must use ordinary reply admission");
      }),
      runSessionEvent: (request) =>
        runCronSessionTurn({
          ...request,
          cfg: config,
          agentId: "main",
          sessionKey: expectDefined(
            resolveCronSessionTargetSessionKey(request.job.sessionTarget),
            "scheduled PR session target",
          ),
        }),
    }),
    {
      defaults: {
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
  );
  const finalEffect =
    vi.fn<(target: { owner: string; repo: string; number: number }, sessionId: string) => void>();
  runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
    const admitted = await expectDefined(params.preparedRunAdmission, "scheduled admission").admit(
      "gateway",
      params.runId,
    );
    expectDefined(resolveAdmittedRunActiveAssertion(admitted), "active admission assertion")();
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    params.onExecutionPhase?.({ phase: "model_call_started" });
    const target = readPrAutomationRecipeTarget(params.prompt);
    finalEffect(
      { owner: target.owner, repo: target.repo, number: target.number },
      params.sessionId,
    );
    return { payloads: [{ text: "Synthetic endpoint accepted" }], meta: { durationMs: 1 } };
  });
  try {
    await fixture.execution.update(fixture.selected.id, { enabled: true });
    const firstEvent = await fixture.tick();
    expect(firstEvent, firstEvent.error).toMatchObject({
      jobId: fixture.selected.id,
      status: "ok",
    });
    expect(finalEffect.mock.calls).toEqual([
      [{ owner: "fixture-org", repo: "fixture-repo", number: 41 }, SESSION_ID],
    ]);
    await fixture.seed("replacement-session");
    expect(await fixture.tick()).toMatchObject({ jobId: fixture.selected.id, status: "ok" });
    expect(finalEffect.mock.calls[1]).toEqual([
      { owner: "fixture-org", repo: "fixture-repo", number: 41 },
      "replacement-session",
    ]);
    await fixture.execution.update(fixture.selected.id, { enabled: false });
    await fixture.execution.update(fixture.other.id, { enabled: true });
    // The second job supplies a real completed scheduler turn, not a sleep used
    // to infer that the disabled job probably did not run.
    expect(await fixture.tick()).toMatchObject({ jobId: fixture.other.id, status: "ok" });
    expect(finalEffect.mock.calls).toEqual([
      [{ owner: "fixture-org", repo: "fixture-repo", number: 41 }, SESSION_ID],
      [{ owner: "fixture-org", repo: "fixture-repo", number: 41 }, "replacement-session"],
      [{ owner: "fixture-org", repo: "fixture-repo", number: 42 }, "replacement-session"],
    ]);
    expect(fixture.execution.getJob(fixture.selected.id)?.enabled).toBe(false);
    expect((await fixture.add({ ...fixture.target, sessionId: "replacement-session" })).id).toBe(
      fixture.selected.id,
    );
  } finally {
    await fixture.stop();
  }
});
