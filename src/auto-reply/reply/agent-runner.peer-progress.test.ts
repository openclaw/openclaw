import assert from "node:assert/strict";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { SessionFollowupCompletion } from "../../agents/subagents/completion/session-followup-completion.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import {
  runEmbeddedAgentMock,
  setupAgentRunnerTestHooks,
} from "./agent-runner.misc.runreplyagent.test-support.js";
import { createBaseRun } from "./agent-runner.runreplyagent.test-support.js";

// Install the shared runner mocks before loading its cyclic dependencies.
await vi.hoisted(async () => {
  await import("./agent-runner.misc.runreplyagent.test-support.js");
});

setupAgentRunnerTestHooks();

describe("runReplyAgent peer progress", () => {
  it.each([false, true])(
    "automatically offers a peer progress card with a model acknowledgment (%s)",
    async (acknowledgment) => {
      let owner: SessionFollowupCompletion | undefined;
      onTestFinished(() => owner?.close());
      runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentInternalParams) => {
          assert(params.preparedRunAdmission && params.sessionKey && params.agentId);
          await params.preparedRunAdmission.admit("embedded");
          owner = SessionFollowupCompletion.bind({
            runId: "peer-progress-test",
            requesterTurnRunId: params.runId,
            visibleReply: true,
            requesterAgentId: params.agentId,
            requesterSessionKey: params.sessionKey,
            requesterSessionId: params.sessionId,
            targetAgentId: "peer",
            targetSessionKey: "agent:peer:main",
            custody: {
              signal: new AbortController().signal,
              assertCurrent: () => {},
              run: (work) => work(),
              release: () => {},
            },
          });
          owner.markAccepted("peer-progress-test");
          return {
            payloads: acknowledgment ? [{ text: "The project agent is checking." }] : [],
            meta: { durationMs: 0 },
          };
        },
      );
      const result = await createBaseRun({
        run: {
          agentId: "main",
          sessionKey: "agent:main:main",
          terminalReplyExpectation: "required",
        },
        reply: { sessionKey: "agent:main:main" },
      }).run();
      assert(result && !Array.isArray(result));
      expect(result.text).toBe(
        acknowledgment
          ? "The project agent is checking."
          : "I’m continuing this work and will send the result when it is ready.",
      );
      const capability = getReplyPayloadMetadata(result)?.progressContinuation;
      expect(capability?.preserveReply).toBe(acknowledgment ? true : undefined);
      const draft = { push: vi.fn(), retire: vi.fn() };
      expect(capability?.adopt(draft)).toBe(true);
      expect(draft.push).toHaveBeenCalledWith(expect.objectContaining({ title: "Delegated work" }));
      owner?.close();
      expect(draft.retire).toHaveBeenCalledOnce();
    },
  );
});
