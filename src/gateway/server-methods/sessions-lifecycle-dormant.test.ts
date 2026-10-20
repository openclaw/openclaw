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

async function seedPausedChild() {
  await captureRuntimeConfigAsyncReader()();
  // Only requester delivery is unavailable; lifecycle, registry, and storage stay real.
  fixture.wake.mockResolvedValue(false);
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: parentKey,
    defaultSessionId: "paused-child-requester-session",
  });
  const startedAt = await seedYieldedSession(fixture.stateDir, childKey, childId, childRunId);
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
  expect(
    await registry.claimSubagentYield({
      runId: childRunId,
      sessionKey: childKey,
      agentId: "main",
      waitForMessage: true,
      hasPendingWork: () => false,
    }),
  ).toEqual({ messageWaitRegistered: true });
  emitAgentEvent({
    runId: childRunId,
    sessionKey: childKey,
    sessionId: childId,
    stream: "lifecycle",
    data: { phase: "end", startedAt, endedAt: Date.now(), yielded: true },
  });
  await fixture.settle();
  expect(subagentRuns.get(childRunId)).toMatchObject({
    pauseReason: "sessions_yield",
    requesterSettleWake: { pauseNotice: { acknowledgment: "Paused awaiting continuation." } },
  });
}

function deleteChild() {
  return deleteGatewaySession({
    params: { key: childKey, agentId: "main" },
    client: null,
    context: createDirectChatContext({ getRuntimeConfig }),
  });
}

it("deletes a paused child only after retiring its pending pause notice", async () => {
  await seedPausedChild();
  const parent = loadSessionEntry({ agentId: "main", sessionKey: parentKey });
  expect(await deleteChild()).toMatchObject({ ok: true, result: { deleted: true } });
  expect(loadSessionEntry(target)).toBeUndefined();
  expect(subagentRuns.get(childRunId)?.pauseReason).toBeUndefined();
  expect(subagentRuns.get(childRunId)?.requesterSettleWake?.pauseNotice).toBeUndefined();
  expect(loadSessionEntry({ agentId: "main", sessionKey: parentKey })).toEqual(parent);
});

it("preserves the child's session when dormant obligation retirement fails", async () => {
  await seedPausedChild();
  const failure = "controlled dormant obligation retirement failure";
  const retire = vi
    .spyOn(registry, "retireSubagentObligations")
    .mockRejectedValueOnce(new Error(failure));
  try {
    expect(await deleteChild()).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: expect.stringContaining(failure) },
    });
    expect(loadSessionEntry(target)).toMatchObject({ sessionId: childId });
  } finally {
    retire.mockRestore();
  }
});
