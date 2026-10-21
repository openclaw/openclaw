import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createQueueTestRun } from "../../auto-reply/reply/queue.test-helpers.js";
import { enqueueFollowupRun } from "../../auto-reply/reply/queue/enqueue.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { registerAgentRunCapacityWait } from "../../infra/agent-run-capacity-wait.js";
import {
  clearAgentRunContext,
  getAgentRunLifecycleGeneration,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  bindSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareAgentRequestPreflight } from "../agent-turn/agent-request-preflight.js";
import { registerAgentTurnSourceAdmission } from "../agent-turn/agent-turn-source-admission.js";
import { registerChatAbortController } from "../chat-abort.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { captureRpcTargetForTest } from "./rpc-source-fixtures.test-support.js";
import { sessionReader } from "./sessions-keyed-read.test-support.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
  seedSessions,
} from "./sessions-read-cache.test-support.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const key = "agent:main:active";
const scope = { sessionKey: key, agentId: "main" };
const identity = { ...scope, sessionId: "main-active" };
function registerSource(runId: string, target = captureRpcTargetForTest(identity)) {
  return registerChatAbortController({
    target,
    runId,
    ...identity,
    timeoutMs: 60_000,
    kind: "agent",
  });
}

function activityReader(
  context: GatewayRequestContext,
  client: GatewayClient,
  runId: string,
  projected = false,
) {
  const read = sessionReader(context, client, key);
  return async (status: "queued" | "running" | "done", active: boolean, filter = false) => {
    const expected = {
      key,
      status,
      hasActiveRun: active,
      ...(!projected || !active ? { activeRunIds: active ? [runId] : [] } : {}),
    };
    const described = await read();
    expect(described).toMatchObject({ session: expected });
    const roster = await listSessions({ context, client, request: { search: key } });
    expect(roster.sessions).toEqual([expect.objectContaining(expected)]);
    if (projected && active) {
      expect(described).not.toHaveProperty("session.activeRunIds");
      expect(roster.sessions[0]).not.toHaveProperty("activeRunIds");
    }
    if (filter) {
      const filtered = await listSessions({
        context,
        client,
        request: { search: key, activeOnly: true },
      });
      expect(filtered.sessions).toEqual(active ? [expect.objectContaining(expected)] : []);
    }
  };
}

it.each(["chat", "projected"] as const)(
  "describes current %s activity consistently with the roster, independently of the goal",
  async (owner) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = await seedSessions();
      const context = requestContext(cfg);
      const client = identifiedClient("owner@example.com");
      const runId = `describe-${owner}-run`;
      await upsertSessionEntryCore(scope, {
        status: "done",
        goal: {
          schemaVersion: 1,
          id: "active-goal",
          objective: "Finish the task",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
          tokenStart: 0,
          tokensUsed: 0,
          continuationTurns: 0,
        },
      });
      await initializeSessionReadContext(context);
      const assertActivity = activityReader(context, client, runId, owner === "projected");
      const chat = owner === "chat" ? registerSource(runId) : undefined;
      const releaseSource = chat?.entry ? await claimRpcSourceForTest(chat.entry) : undefined;
      registerAgentRunContext(runId, {
        ...identity,
        ...(owner === "projected" ? { projectSessionActive: true } : {}),
      });
      const releaseWait = registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
      const cleanup = () => {
        releaseSource?.();
        chat?.cleanup();
        clearAgentRunContext(runId);
      };
      try {
        await assertActivity("queued", true);
        releaseWait?.();
        await assertActivity("running", true);
        cleanup();
        await assertActivity("done", false);
        await upsertSessionEntryCore(scope, { status: "done", endedAt: Date.now() });
        // A yielded task may retain an active goal without owning a live turn.
        await assertActivity("done", false);
      } finally {
        releaseWait?.();
        cleanup();
      }
    });
  },
);

it("projects configured-locator admissions through preparation and queuing without foreign-store activity", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = await seedSessions();
    const context = requestContext(cfg);
    const resolveGatewayContext = () => context;
    context.resolveGatewayContext = resolveGatewayContext;
    const client = identifiedClient("owner@example.com");
    const runId = "configured-admission";
    const sourceWork = createDeferred();
    const registrations: ReturnType<typeof registerChatAbortController>[] = [];
    await upsertSessionEntryCore(scope, { status: "done" });
    await initializeSessionReadContext(context);
    const foreign = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      registerSource(
        "foreign-admission",
        captureSessionTarget({
          storeScope: state.statePath("foreign.sqlite"),
          ...scope,
          incarnation: identity.sessionId,
        }),
      ),
    );
    expect(foreign.registered).toBe(true);
    const foreignInput = expectDefined(foreign.entry, "foreign source").input;
    expect(getGatewayContextResolver(foreignInput)).toBe(resolveGatewayContext);
    const readActivity = activityReader(context, client, runId);
    const assertActivity = (active: boolean) =>
      readActivity(active ? "queued" : "done", active, true);
    try {
      // Identical logical identity in another physical store cannot activate this row.
      await assertActivity(false);
      const io = { emitAcceptance: vi.fn(), emitFinal: vi.fn() };
      const preflight = expectDefined(
        await prepareAgentRequestPreflight({
          request: { message: "Continue the task", sessionKey: key, idempotencyKey: runId },
          context,
          client,
          io,
        }),
        "agent preflight",
      );
      await withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
        registerAgentTurnSourceAdmission({
          preflight,
          io,
          sourceWork: sourceWork.promise,
          lifecycleGeneration: getAgentRunLifecycleGeneration(),
          principal: client,
          sessionKey: key,
          assertRequestCurrent: () => {},
          isSourcePreparationComplete: () => false,
          onCancelled: vi.fn(),
          onRegistered: (registration) => registrations.push(registration),
        }),
      );
      expect(io.emitAcceptance).not.toHaveBeenCalled();
      const entry = expectDefined(registrations[0]?.entry, "configured source");
      expect(getGatewayContextResolver(entry.input)).toBe(resolveGatewayContext);
      const projection = expectDefined(getSessionRowProjection(context), "row projection");
      const row = expectDefined(projection.capture({ key, agentId: "main" }), "physical row");
      expect(entry.input.target?.storeScope).not.toBe(row.storeTarget.storePath);
      expect(entry.input.phase).toBe("preparing");
      // Reads occur outside the admission's ambient scope and must use their declared Gateway.
      await assertActivity(true);

      const queued = createQueueTestRun({ prompt: "Continue the task" });
      queued.run = { ...queued.run, ...identity, config: cfg };
      queued.abortSignal = entry.input.abortSignal;
      bindSessionControllerSource(entry.input, queued);
      expect(enqueueFollowupRun(key, queued, { mode: "followup" }, "none", undefined, false)).toBe(
        true,
      );
      expect(entry.input.phase).toBe("waiting");
      await assertActivity(true);

      retireSessionControllerInput(entry.input);
      sourceWork.resolve();
      await withinTest(entry.input.settlement.promise, signal);
      // The foreign source remains registered after the visible source settles.
      expect(foreignInput.phase).toBe("preparing");
      await assertActivity(false);
    } finally {
      sourceWork.resolve();
      for (const registration of registrations) {
        if (registration.entry) {
          retireSessionControllerInput(registration.entry.input);
        }
        registration.cleanup();
      }
      foreign.cleanup();
      await withinTest(
        Promise.all(
          [...registrations, foreign].flatMap(({ entry }) =>
            entry ? [entry.input.settlement.promise] : [],
          ),
        ),
        signal,
      );
    }
  });
});
