import { expect } from "vitest";
import {
  markRequesterTurnYielded,
  registerSubagentRun,
  settleRequesterAfterSessionSpawns,
} from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";
import { createChatAbortContext } from "./chat.abort.test-helpers.js";
import { sessionAbortHandlers } from "./sessions-abort.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

export function revocableAuthority(message: string) {
  let current = true;
  const error = new Error(message);
  return {
    error,
    revoke: () => {
      current = false;
    },
    assertCurrent: () => {
      if (!current) {
        throw error;
      }
    },
  };
}

export function abortContext() {
  return createChatAbortContext({
    getRuntimeConfig,
    getSessionEventSubscriberConnIds: () => new Set(),
  });
}

export function stopSession(
  key: string,
  respond: RespondFn,
  context: ReturnType<typeof abortContext> | GatewayRequestContext = abortContext(),
  params: { runId?: string; clearQueued?: boolean } = {},
  client: { connId?: string; connect: { scopes: string[] } } | null = {
    connId: "operator",
    connect: { scopes: ["operator.read", "operator.write"] },
  },
) {
  return sessionAbortHandlers["sessions.abort"]!({
    req: { type: "req", id: "stop", method: "sessions.abort" },
    params: { key, ...params },
    respond,
    context: context as never,
    client: client as never,
    isWebchatConnect: () => false,
  });
}

export async function seedYieldedSession(
  stateDir: string,
  sessionKey: string,
  sessionId: string,
  runId: string,
  lifecycleRevision = "original-incarnation",
) {
  const target = { agentId: "main", sessionKey };
  await writeSubagentSessionEntry({
    stateDir,
    ...target,
    defaultSessionId: sessionId,
    lifecycleRevision,
  });
  const startedAt = Date.now() - 100;
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  for (const data of [
    { phase: "start", startedAt },
    {
      phase: "end",
      startedAt,
      endedAt: startedAt + 50,
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    },
  ]) {
    await persistGatewaySessionLifecycleEvent({
      ...target,
      event: { runId, sessionId, lifecycleGeneration, ts: Date.now(), data },
    });
  }
  return startedAt;
}

export function expectStopResult(respond: { mock: { calls: unknown[][] } }, status = "aborted") {
  expect(respond.mock.calls[0]?.slice(0, 2)).toEqual([
    true,
    { ok: true, abortedRunId: null, status },
  ]);
}

export function expectAbortFailure(
  respond: { mock: { calls: unknown[][] } },
  message: unknown,
  code = "UNAVAILABLE",
) {
  expect(respond.mock.calls[0]?.slice(0, 3)).toEqual([
    false,
    undefined,
    expect.objectContaining({ code, message }),
  ]);
}

export async function registerYieldedChild(params: {
  parentKey: string;
  parentRunId: string;
  childKey: string;
  childRunId: string;
  startedAt: number;
  sessionEntry: Parameters<typeof registerSubagentRun>[0]["sessionEntry"];
}) {
  const { parentKey, parentRunId, childKey, childRunId, startedAt, sessionEntry } = params;
  const requester = {
    requesterSessionKey: parentKey,
    requesterAgentId: "main",
    requesterTurnRunId: parentRunId,
  };
  await registerSubagentRun({
    runId: childRunId,
    childSessionKey: childKey,
    childAgentId: "main",
    sessionEntry,
    ...requester,
    requesterDisplayKey: parentKey,
    task: "Cancellation proof",
    cleanup: "keep",
    expectsCompletionMessage: true,
  });
  expect(await markRequesterTurnYielded(requester)).toBe(1);
  expect(
    await settleRequesterAfterSessionSpawns({
      ...requester,
      requesterYielded: true,
      acceptedSessionSpawns: [
        { runId: childRunId, childSessionKey: childKey, expectsCompletionMessage: true },
      ],
    }),
  ).toBe(true);
  const target = { agentId: "main", sessionKey: parentKey };
  expect(loadSessionEntry(target)).toMatchObject({
    lifecycleRunId: parentRunId,
    endedAt: startedAt + 50,
    abortedLastRun: false,
  });
  expect(loadSessionEntry(target)?.status).toBeUndefined();
  expect((await getSubagentRunByChildSessionKey(childKey))?.requesterSettleWake).toMatchObject({
    requesterYieldBatch: true,
  });
}
