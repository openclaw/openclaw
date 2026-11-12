// Preserve the real registry fixture's module setup before importing handlers.
// oxfmt-ignore
import { useSubagentControlFixture } from "../../agents/subagents/registry/subagent-control.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import * as registry from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { deleteGatewaySession } from "./sessions-delete.js";
import { seedYieldedSession } from "./sessions.abort-lifecycle.test-support.js";

const fixture = useSubagentControlFixture();
const parentKey = "agent:main:paused-child-requester";
const childKey = "agent:main:subagent:paused-lifecycle-child";
const childId = "paused-lifecycle-child-session";
const childRunId = "paused-lifecycle-child-run";
const target = { agentId: "main", sessionKey: childKey };
const parentTarget = { agentId: "main", sessionKey: parentKey };
const runTarget = { runId: childRunId, sessionKey: childKey, sessionId: childId };

it.each([false, true])(
  "deleting a paused child preserves storage iff retirement fails (%s)",
  async (fails) => {
    await captureRuntimeConfigAsyncReader()();
    // Only requester delivery is unavailable; lifecycle, registry, and storage stay real.
    fixture.wake.mockResolvedValue(false);
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      ...parentTarget,
      defaultSessionId: "paused-child-requester-session",
    });
    await seedYieldedSession(fixture.stateDir, childKey, childId, childRunId);
    await registry.registerSubagentRun({
      runId: childRunId,
      childSessionKey: childKey,
      childAgentId: "main",
      sessionEntry: expectDefined(loadSessionEntry(target), "paused child session"),
      requesterSessionKey: parentKey,
      requesterAgentId: "main",
      requesterDisplayKey: parentKey,
      task: "Await an incoming continuation",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    const claimed = await registry.claimSubagentYield({
      ...target,
      runId: childRunId,
      waitForMessage: true,
      hasPendingWork: () => false,
    });
    expect(claimed).toEqual({ messageWaitRegistered: true });
    const startedAt = expectDefined(
      subagentRuns.get(childRunId)?.execution.startedAt,
      "registered child attempt",
    );
    emitAgentEvent({
      ...runTarget,
      stream: "lifecycle",
      data: { phase: "end", startedAt, endedAt: Date.now(), yielded: true },
    });
    await fixture.settle();
    expect(subagentRuns.get(childRunId)).toMatchObject({
      pauseReason: "sessions_yield",
      requesterSettleWake: { pauseNotice: { acknowledgment: "Paused awaiting continuation." } },
    });
    const parent = loadSessionEntry(parentTarget);
    const failure = "controlled dormant obligation retirement failure";
    if (fails) {
      vi.spyOn(registry, "retireSubagentObligations").mockRejectedValueOnce(new Error(failure));
    }
    const result = await deleteGatewaySession({
      params: { key: childKey, agentId: "main" },
      client: null,
      context: createDirectChatContext({ getRuntimeConfig }),
    });
    if (fails) {
      expect(result).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: expect.stringContaining(failure) },
      });
      expect(loadSessionEntry(target)).toMatchObject({ sessionId: childId });
      return;
    }
    expect(result).toMatchObject({ ok: true, result: { deleted: true } });
    expect(loadSessionEntry(target)).toBeUndefined();
    const run = subagentRuns.get(childRunId);
    expect(run?.pauseReason).toBeUndefined();
    expect(run?.requesterSettleWake?.pauseNotice).toBeUndefined();
    expect(loadSessionEntry(parentTarget)).toEqual(parent);
  },
);
