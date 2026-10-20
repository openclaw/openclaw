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
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  listSessions,
  requestContext,
  seedSessions,
} from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

it.each(["chat", "projected"] as const)(
  "describes current %s activity consistently with the roster, independently of the goal",
  async (owner) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = await seedSessions();
      const context = requestContext(cfg);
      const client = identifiedClient("owner@example.com");
      const key = "agent:main:active";
      const runId = `describe-${owner}-run`;
      const sessionId = "main-active";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        {
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
        },
      );
      await initializeSessionReadContext(context);
      const describe = async () => {
        const responses: Parameters<RespondFn>[] = [];
        await sessionByKeyReadHandlers["sessions.describe"]!({
          req: { type: "req", id: "describe-activity", method: "sessions.describe" },
          params: { key },
          context,
          client,
          isWebchatConnect: () => false,
          respond: (...response) => responses.push(response),
        });
        expect(responses).toHaveLength(1);
        expect(responses[0]?.[0]).toBe(true);
        return responses[0]?.[1];
      };
      const assertActivity = async (
        status: "queued" | "running" | "done",
        hasActiveRun: boolean,
      ) => {
        const expected = {
          key,
          status,
          hasActiveRun,
          ...(owner === "chat" || !hasActiveRun
            ? { activeRunIds: hasActiveRun ? [runId] : [] }
            : {}),
        };
        const described = await describe();
        expect(described).toMatchObject({ session: expected });
        const roster = await listSessions({ context, client, request: { search: key } });
        expect(roster.sessions).toEqual([expect.objectContaining(expected)]);
        if (owner === "projected" && hasActiveRun) {
          expect(described).not.toHaveProperty("session.activeRunIds");
          expect(roster.sessions[0]).not.toHaveProperty("activeRunIds");
        }
      };
      const chat =
        owner === "chat"
          ? registerChatAbortController({
              target: captureRpcTargetForTest({ sessionKey: key, sessionId, agentId: "main" }),
              runId,
              sessionId,
              sessionKey: key,
              agentId: "main",
              timeoutMs: 60_000,
              kind: "agent",
            })
          : undefined;
      const releaseSource = chat?.entry ? await claimRpcSourceForTest(chat.entry) : undefined;
      registerAgentRunContext(runId, {
        sessionId,
        sessionKey: key,
        agentId: "main",
        ...(owner === "projected" ? { projectSessionActive: true } : {}),
      });
      const releaseCapacityWait = registerAgentRunCapacityWait(
        runId,
        getAgentRunLifecycleGeneration(),
      );
      try {
        await assertActivity("queued", true);
        releaseCapacityWait?.();
        await assertActivity("running", true);
        releaseSource?.();
        chat?.cleanup();
        clearAgentRunContext(runId);
        await assertActivity("done", false);
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          { status: "done", endedAt: Date.now() },
        );
        // A yielded task may retain an active goal without owning a live turn.
        await assertActivity("done", false);
      } finally {
        releaseCapacityWait?.();
        releaseSource?.();
        chat?.cleanup();
        clearAgentRunContext(runId);
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
    const key = "agent:main:active";
    const sessionId = "main-active";
    const runId = "configured-admission";
    const sourceWork = createDeferred();
    const registrations: ReturnType<typeof registerChatAbortController>[] = [];
    await upsertSessionEntryCore({ agentId: "main", sessionKey: key }, { status: "done" });
    await initializeSessionReadContext(context);
    const foreign = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
      registerChatAbortController({
        target: captureSessionTarget({
          storeScope: state.statePath("foreign.sqlite"),
          sessionKey: key,
          incarnation: sessionId,
          agentId: "main",
        }),
        runId: "foreign-admission",
        sessionId,
        sessionKey: key,
        agentId: "main",
        timeoutMs: 60_000,
        kind: "agent",
      }),
    );
    expect(foreign.registered).toBe(true);
    expect(getGatewayContextResolver(expectDefined(foreign.entry, "foreign source").input)).toBe(
      resolveGatewayContext,
    );
    const assertActivity = async (active: boolean) => {
      const expected = {
        key,
        status: active ? "queued" : "done",
        hasActiveRun: active,
        activeRunIds: active ? [runId] : [],
      };
      const responses: Parameters<RespondFn>[] = [];
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "configured-activity", method: "sessions.describe" },
        params: { key },
        context,
        client,
        isWebchatConnect: () => false,
        respond: (...response) => responses.push(response),
      });
      expect(responses).toHaveLength(1);
      expect(responses[0]?.[0]).toBe(true);
      expect(responses[0]?.[1]).toHaveProperty("session.hasActiveRun", active);
      expect(responses[0]?.[1]).toMatchObject({ session: expected });
      const roster = await listSessions({ context, client, request: { search: key } });
      expect(roster.sessions).toEqual([expect.objectContaining(expected)]);
      const activeRoster = await listSessions({
        context,
        client,
        request: { search: key, activeOnly: true },
      });
      expect(activeRoster.sessions).toEqual(active ? [expect.objectContaining(expected)] : []);
    };
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
      const registration = expectDefined(registrations[0], "configured admission");
      const entry = expectDefined(registration.entry, "configured source");
      expect(getGatewayContextResolver(entry.input)).toBe(resolveGatewayContext);
      const projection = expectDefined(getSessionRowProjection(context), "row projection");
      const row = expectDefined(projection.capture({ key, agentId: "main" }), "physical row");
      expect(entry.input.target?.storeScope).not.toBe(row.storeTarget.storePath);
      expect(entry.input.phase).toBe("preparing");
      // Reads occur outside the admission's ambient scope and must use their declared Gateway.
      await assertActivity(true);

      const queued = createQueueTestRun({ prompt: "Continue the task" });
      queued.run = { ...queued.run, sessionKey: key, sessionId, agentId: "main", config: cfg };
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
      expect(foreign.entry?.input.phase).toBe("preparing");
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
        Promise.all([
          ...registrations.flatMap((registration) =>
            registration.entry ? [registration.entry.input.settlement.promise] : [],
          ),
          ...(foreign.entry ? [foreign.entry.input.settlement.promise] : []),
        ]),
        signal,
      );
    }
  });
});
