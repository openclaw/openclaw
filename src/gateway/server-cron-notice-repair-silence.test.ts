import "../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { completionConfig } from "../agents/bash-tools.lifecycle.test-support.js";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { buildSystemPromptReport } from "../agents/system-prompt-report.js";
import * as sessionEventHandoff from "../auto-reply/reply/session-event-handoff.js";
import { startEmbeddedTurn } from "../auto-reply/reply/session-event.test-support.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { readVisibleSessionTranscriptMessageEntries } from "../plugin-sdk/session-transcript-runtime.js";
import { captureSessionGeneration } from "../sessions/session-notice.js";
import { projectChatDisplayMessages } from "./chat-display-projection.core.js";
import { createGatewayCronTargetResolver } from "./server-cron-targets.js";
import {
  createCronFixture,
  installRequesterCronAuthorityTestHooks,
  SESSION,
  SESSION_ID,
  stateDir,
} from "./server-methods/requester-cron-authority.test-support.js";

// mock-isolation: Run real admission/reply/CLI settlement; replace runner selection and CLI I/O.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);
installRequesterCronAuthorityTestHooks();

const NOTICE = '⚠️ Automation "Health check" was auto-disabled: proof notice.';

it("lets the agent stay silent after a posted automation notice", async () => {
  const config = completionConfig(stateDir);
  setRuntimeConfigSnapshot(config);
  const { context } = createCronFixture(undefined, config);
  const job = await context.cron.add({
    name: "Health check",
    enabled: true,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Check the dashboard." },
    delivery: { mode: "none" },
    owner: { agentId: "main", sessionKey: SESSION },
  });
  const { runPreparedCliAgent } = await import("../agents/cli-runner.js");
  const execution = await import("../agents/cli-runner/execute.runtime.js");
  // The agent has nothing to add: the user already has the notice.
  using output = vi
    .spyOn(execution, "executePreparedCliRun")
    .mockResolvedValue({ text: "NO_REPLY", rawText: "NO_REPLY" });
  runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
    await startEmbeddedTurn(params, "notice repair turn");
    const run = buildPreparedCliRunContext({
      workspaceDir: stateDir,
      sessionKey: params.sessionKey,
      runId: params.runId,
      backend: { sessionMode: "none" },
    });
    run.params = {
      ...run.params,
      inputProvenance: params.inputProvenance,
      terminalReplyExpectation: params.terminalReplyExpectation,
    };
    run.systemPromptReport = buildSystemPromptReport({
      source: "run",
      generatedAt: Date.now(),
      systemPrompt: run.systemPrompt,
      workspaceDir: stateDir,
      bootstrapMaxChars: 20_000,
      injectedWorkspaceFiles: [],
      skillsPrompt: "",
      tools: [],
    });
    return runPreparedCliAgent(run);
  });
  const handoff = vi.spyOn(sessionEventHandoff, "enqueueSessionEventForHost");
  try {
    await createGatewayCronTargetResolver(
      process.env,
      { warn: vi.fn() },
      () => context,
    ).enqueueSessionEvent(NOTICE, { agentId: "main", sessionKey: SESSION, jobId: job.id });
    const receipt = expectDefined(handoff.mock.results[0]?.value, "notice receipt");
    const settled = await receipt.settled;
    expect(settled.error).toBeUndefined();
    expect(settled.status).toBe("completed");
    // One model call: silence is accepted, not retried into a filler reply.
    expect(output).toHaveBeenCalledTimes(1);
  } finally {
    handoff.mockRestore();
  }
  const generation = await captureSessionGeneration({
    config: getRuntimeConfigSnapshot()!,
    agentId: "main",
    sessionKey: SESSION,
  });
  const entries = await readVisibleSessionTranscriptMessageEntries({
    agentId: "main",
    sessionKey: SESSION,
    sessionId: generation?.sessionId ?? SESSION_ID,
    ...(generation ? { storePath: generation.storePath } : {}),
  });
  // Chat shows the posted notice and nothing else.
  const shown = projectChatDisplayMessages(entries.map((entry) => entry.message));
  expect(
    shown.map((message) => [
      message.role,
      JSON.stringify(message).includes("was auto-disabled: proof notice."),
    ]),
  ).toEqual([["assistant", true]]);
});
