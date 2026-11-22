import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "../../agents/subagents/registry/subagent-registry-publication.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { resolveGatewayOperatorAccessAuthority } from "../operator-access-policy.js";
import { gatewayRequest } from "../request-frame.test-support.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import { performGatewaySessionReset } from "../session-reset-service.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { loadRealChatDispatch } from "./chat-send-authority.test-support.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

const runtime = vi.hoisted(() => ({ run: vi.fn<typeof runEmbeddedAgentEntry>() }));
// mock-isolation: Fix backend I/O while exercising real chat admission and native custody.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: runtime.run,
}));
// mock-isolation: Retained native task waits must never connect to a running Gateway.
vi.mock("../call.js", () => ({
  callGateway: vi.fn(async () => await new Promise<never>(() => {})),
}));

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();
afterEach(() => resetSubagentRegistryForTests({ persist: false }));

function holdExecution(signal: AbortSignal, text: string) {
  const entered = createDeferred();
  const release = createDeferred();
  runtime.run.mockImplementation(async (params) => {
    entered.resolve();
    await withinTest(release.promise, signal);
    return {
      outcome: "completed",
      result: { payloads: [{ text }], meta: { durationMs: 0 } },
      provider: params.selection.provider,
      model: params.selection.model,
      attempts: [],
      terminal: { outcome: { status: "ok", reason: "completed" }, metadata: {} },
      settleSessionOverride: async () => {},
    };
  });
  return { entered, release };
}

it.for([
  { method: "chat.send", reset: false },
  { method: "chat.send", reset: true },
  { method: "sessions.send", reset: true },
])(
  "retains native child custody for $method (reset: $reset)",
  async ({ method, reset }, { signal }) => {
    const caseId = `${method}-${reset ? "reset" : "retained"}`;
    const sessionKey = `agent:main:dashboard:retained-child-${caseId}`;
    await using fixture = await createFixture({ active: false, preserveContent: true, sessionKey });
    const runId = `human-child-continuation-${caseId}`;
    const task = "Verify the retained result.";
    const operator = createOperatorClient({
      profileName: `retained-child-followup-${caseId}`,
      scopes: fixture.client.connect.scopes ?? [],
    });
    fixture.context.resolveGatewayContext = () => fixture.context;
    fixture.client.authenticatedUserId = operator.authenticatedUserId;
    fixture.client.authenticatedUserProfile = operator.authenticatedUserProfile;
    fixture.client.internal = {
      authenticatedOperator: true,
      operatorAccessAuthority: resolveGatewayOperatorAccessAuthority(
        operator.authenticatedUserProfile!.profileId,
        fixture.context.getRuntimeConfig(),
      ),
    };
    fixture.client.authPolicy = captureGatewayAuthPolicy(fixture.context.getRuntimeConfig(), {
      role: "operator",
      authMethod: "token",
    });
    const entry = {
      sessionId: fixture.scope.sessionId,
      lifecycleRevision: "retained-child-revision",
      updatedAt: Date.now(),
      status: "done" as const,
      createdVia: "spawn" as const,
      spawnedBy: "agent:main:main",
      parentSessionKey: "agent:main:main",
      spawnDepth: 1,
      subagentRole: "leaf" as const,
    };
    Object.assign(fixture.params, { message: task, idempotencyKey: runId });
    await upsertSessionEntryCore(fixture.scope, entry);
    const completed = createSubagentRunRecord({
      runId: `completed-child-${caseId}`,
      childSessionKey: sessionKey,
      childAgentId: "main",
      childSessionIdentity: {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
      },
      requesterAgentId: "main",
      task: "Original completed task",
      expectsCompletionMessage: false,
      startedAt: 1,
      endedAt: 2,
      outcome: { status: "ok" },
    });
    await mutateSubagentRuns([completed.runId], () => ({
      value: undefined,
      postimages: new Map([[completed.runId, completed]]),
    }));
    if (reset) {
      const result = await performGatewaySessionReset({
        key: sessionKey,
        agentId: "main",
        reason: "reset",
        commandSource: "test",
        expectedSessionId: entry.sessionId,
      });
      expect(result.ok).toBe(true);
    }
    const resetEntry = loadSessionEntry(fixture.scope)!;
    expect(resetEntry.sessionId).toBe(entry.sessionId);
    if (reset) {
      expect(resetEntry.lifecycleRevision).not.toBe(entry.lifecycleRevision);
    }
    const { entered, release } = holdExecution(signal, "Retained result verified.");
    const dispatchEntered = createDeferred();
    const dispatchReleased = createDeferred();
    const dispatchFinished = createDeferred();
    const published = createDeferred();
    const unsubscribe = subscribeSubagentRunChanges("projection", () => {
      if (subagentRuns.has(runId)) {
        published.resolve();
      }
    });
    const dispatch = await loadRealChatDispatch();
    dispatchInboundMessageMock.mockImplementation(async (params) => {
      dispatchEntered.resolve();
      await withinTest(dispatchReleased.promise, signal);
      try {
        return await dispatch(params);
      } finally {
        dispatchFinished.resolve();
      }
    });
    try {
      const ack = vi.fn<Parameters<typeof handleGatewayRequest>[0]["respond"]>();
      if (method === "chat.send") {
        await fixture.send(ack, {
          expectedProfileId: operator.authenticatedUserProfile!.profileId,
        });
      } else {
        await handleGatewayRequest({
          req: {
            ...gatewayRequest(runId, method, {
              key: sessionKey,
              message: task,
              idempotencyKey: runId,
            }),
            expectedProfileId: operator.authenticatedUserProfile!.profileId,
          },
          client: fixture.client,
          context: fixture.context,
          isWebchatConnect: () => true,
          respond: ack,
        });
      }
      expect(ack).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId, status: "started" }),
        undefined,
        expect.anything(),
      );
      await withinTest(dispatchEntered.promise, signal);
      expect(subagentRuns.has(runId)).toBe(false);
      dispatchReleased.resolve();
      await withinTest(
        awaitGateBeforeSettlement(
          published.promise,
          dispatchFinished.promise,
          "Reply settled before acquiring child custody",
        ),
        signal,
      );
      const admittedEntry = loadSessionEntry({
        agentId: fixture.scope.agentId,
        sessionKey,
        storePath: fixture.scope.storePath,
      })!;
      expect([subagentRuns.get(runId), subagentRuns.get(completed.runId)]).toMatchObject([
        {
          runId,
          childSessionKey: sessionKey,
          childSessionIdentity: {
            sessionId: admittedEntry.sessionId,
            lifecycleRevision: admittedEntry.lifecycleRevision,
          },
          task,
          execution: { status: "running" },
        },
        {
          task: "Original completed task",
          childSessionIdentity: {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
          },
          execution: { status: "terminal", outcome: { status: "ok" } },
        },
      ]);
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          dispatchFinished.promise,
          "Reply settled before model execution",
        ),
        signal,
      );
    } finally {
      unsubscribe();
      dispatchReleased.resolve();
      release.resolve();
    }
  },
);
