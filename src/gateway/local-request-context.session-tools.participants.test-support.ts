import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished, vi } from "vitest";
import { captureAgentHarnessCompletionCustody } from "../agents/agent-harness-completion-custody.js";
import { createAgentHarnessCompletionScope } from "../agents/agent-harness-completion-scope.js";
import {
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as inProcessGateway from "../agents/tools/in-process-gateway.js";
import { createSessionStatusTool } from "../agents/tools/session-status-tool.js";
import { createSessionsHistoryTool } from "../agents/tools/sessions-history-tool.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { createSessionsTool } from "../agents/tools/sessions-tool.js";
import { withPersonalToolTurn } from "../auto-reply/reply/personal-tool-turn.test-support.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { drainSystemEvents } from "../infra/system-events.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { mockSessionStatusModelDependencies } from "./local-request-context.session-status.test-support.js";
import {
  REQUESTER,
  TARGET,
  TARGET_ID,
  PARTICIPANT_SHARED,
  PARTICIPANT_DRAFT,
  PARTICIPANT_DRAFT_ID,
  withParticipantSessionToolsFixture,
} from "./local-request-context.session-tools.test-support.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import { createRequestGatewayMethodRegistry, handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

export function registerSessionToolParticipantTests() {
  it("keeps each admitted requester's session reads and writes under their own identity", async () => {
    await withParticipantSessionToolsFixture(async ({ cfg, turn, alice, bob }) => {
      const history = createSessionsHistoryTool({ config: cfg, agentSessionKey: REQUESTER });
      const read = (sessionKey: string, user?: string) =>
        history.execute("participant-history", { sessionKey, user });
      const expectDraft = async (user?: string) =>
        expect((await read(PARTICIPANT_DRAFT, user)).details).toMatchObject({
          messages: [expect.objectContaining({ content: "Alice's distinctive draft marker" })],
        });
      const patch = (user: string, agentSessionKey = REQUESTER) =>
        createSessionsTool({ config: cfg, agentSessionKey }).execute("participant-patch", {
          action: "patch",
          sessionKey: PARTICIPANT_DRAFT,
          expectedSessionId: PARTICIPANT_DRAFT_ID,
          label: "Selected participant write",
          user,
        });

      await expectDraft();
      expect(await turn.steer(bob)).toMatchObject({
        status: "rejected",
        reason: "tool_authority_mismatch",
      });
      await expectDraft();
      await expect(read(PARTICIPANT_SHARED, bob.profileId)).rejects.toThrow(/not a participant/);
      await expect(read(PARTICIPANT_DRAFT, "unknown-profile")).rejects.toThrow(/not a participant/);
      await withoutGatewayToolCallerIdentity(() =>
        withPersonalToolTurn(
          {
            owner: bob,
            sessionKey: TARGET,
            sessionId: TARGET_ID,
            runId: "bob-session-tools-run",
          },
          async (bobTurn) => {
            expect(getGatewayToolCallerIdentity()?.requesterOrigin?.operatorProfileId).toBe(
              bob.profileId,
            );
            const bobOptions = { config: cfg, agentSessionKey: TARGET };
            const bobHistory = createSessionsHistoryTool(bobOptions);
            const bobRead = (sessionKey: string) =>
              bobHistory.execute("bob-history", { sessionKey, user: bob.profileId });
            expect((await bobRead(PARTICIPANT_DRAFT)).details).toMatchObject({
              status: "error",
              error: expect.stringMatching(/not found|no session found/i),
            });
            expect((await bobRead(PARTICIPANT_SHARED)).details).toMatchObject({
              messages: [expect.objectContaining({ content: "Shared participant marker" })],
            });
            await expect(
              createSessionStatusTool(bobOptions).execute("draft-status", {
                sessionKey: PARTICIPANT_DRAFT,
                user: bob.profileId,
              }),
            ).rejects.toThrow(/not found|not visible/i);
            const notify = (sessionKey: string) =>
              createSessionsSendTool(bobOptions).execute("participant-notify", {
                sessionKey,
                message: "Bob's selected notification",
                mode: "notify",
                user: bob.profileId,
              });
            expect((await notify(PARTICIPANT_DRAFT)).details).toMatchObject({
              status: "error",
              error: expect.stringMatching(/not found|no session found/i),
            });
            expect(drainSystemEvents(PARTICIPANT_DRAFT)).toEqual([]);
            await expect(notify(PARTICIPANT_SHARED)).resolves.toMatchObject({
              details: { status: "queued", sessionKey: PARTICIPANT_SHARED, runStarted: false },
            });
            expect(drainSystemEvents(PARTICIPANT_SHARED)).toEqual([
              expect.stringContaining("Bob's selected notification"),
            ]);
            await expect(patch(bob.profileId, TARGET)).rejects.toThrow(
              "session is draft for this connection",
            );
            bobTurn.revoke(bob.profileId);
            await expect(bobRead(PARTICIPANT_SHARED)).rejects.toThrow(/Bob's access changed/);
          },
        ),
      );
      expect(turn.operation.abortSignal.aborted).toBe(false);
      await expectDraft(alice.profileId);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: PARTICIPANT_DRAFT })?.label,
      ).toBeUndefined();
      await expect(patch(alice.profileId)).resolves.toMatchObject({
        details: { status: "updated", sessionKey: PARTICIPANT_DRAFT },
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey: PARTICIPANT_DRAFT })?.label).toBe(
        "Selected participant write",
      );
      turn.complete();
      await expect(read(PARTICIPANT_DRAFT, alice.profileId)).rejects.toThrow(/turn has ended/);
    });
  });

  it("reads same-requester status after reconnect while keeping current-session status local", async () => {
    mockSessionStatusModelDependencies();
    await withParticipantSessionToolsFixture(async ({ cfg, turn, alice }) => {
      expect(await turn.steer({ ...alice })).toMatchObject({ status: "accepted" });
      const statusGateway = vi.spyOn(inProcessGateway, "callAgentToolGatewayRequest");
      onTestFinished(() => statusGateway.mockRestore());
      const sessionStatus = createSessionStatusTool({
        config: cfg,
        agentSessionKey: REQUESTER,
        runSessionKey: REQUESTER,
      });
      await expect(
        sessionStatus.execute("selected-status", { sessionKey: "current", user: alice.profileId }),
      ).resolves.toMatchObject({
        details: { ok: true, sessionKey: REQUESTER, agentId: "main" },
      });
      expect(
        statusGateway.mock.calls.filter(([request]) => request.method === "sessions.describe"),
      ).toHaveLength(0);
    });
  });

  it.each(["selected history", "unselected history", "unselected wake"] as const)(
    "preserves %s when another requester attempts steering during preparation",
    async (surface) => {
      await withParticipantSessionToolsFixture(async ({ cfg, turn, alice, bob }) => {
        const context = expectDefined(getPluginRuntimeGatewayRequestScope()?.context, "Gateway");
        const steer = vi
          .fn(async () => undefined)
          .mockImplementationOnce(async () => {
            expect(await turn.steer(bob)).toMatchObject({
              status: "rejected",
              reason: "tool_authority_mismatch",
            });
            return undefined;
          });
        const enqueueWake = vi.fn();
        const wake = vi.fn(async (opts: { commitGuard?: () => void }) => {
          opts.commitGuard?.();
          enqueueWake();
          return { ok: true as const };
        });
        if (surface === "unselected wake") {
          context.cron = { ...context.cron, prepareWake: steer, wake };
        } else {
          context.readChatStartupProjection = steer;
        }
        const history = createSessionsHistoryTool({
          config: cfg,
          agentSessionKey: REQUESTER,
        });
        const result = await (surface === "unselected wake"
          ? dispatchGatewayMethodInProcess("wake", {
              sessionKey: PARTICIPANT_DRAFT,
              mode: "now",
              text: "Wake the draft",
            })
          : surface === "unselected history"
            ? dispatchGatewayMethodInProcess("chat.history", { sessionKey: PARTICIPANT_DRAFT })
            : history.execute("racing-history", { sessionKey: PARTICIPANT_DRAFT }));
        const expectedHistory = {
          messages: [expect.objectContaining({ content: "Alice's distinctive draft marker" })],
        };
        expect(result).toMatchObject(
          surface === "unselected wake"
            ? { ok: true }
            : surface === "selected history"
              ? { details: expectedHistory }
              : expectedHistory,
        );
        expect(steer).toHaveBeenCalled();
        expect(turn.operation.abortSignal.aborted).toBe(false);
        if (surface === "unselected wake") {
          expect(enqueueWake).toHaveBeenCalledOnce();
        }
        expect(
          (
            await history.execute("selected-history", {
              sessionKey: PARTICIPANT_DRAFT,
              user: alice.profileId,
            })
          ).details,
        ).toMatchObject({
          messages: [expect.objectContaining({ content: "Alice's distinctive draft marker" })],
        });
      });
    },
  );

  it("preserves the current requester for unselected session calls after rejected steering", async () => {
    await withParticipantSessionToolsFixture(async ({ turn, bob }) => {
      const read = (sessionKey: string) =>
        dispatchGatewayMethodInProcess("chat.history", { sessionKey, agentId: "main" });
      await expect(read(PARTICIPANT_DRAFT)).resolves.toMatchObject({
        messages: [expect.objectContaining({ content: "Alice's distinctive draft marker" })],
      });
      expect(await turn.steer(bob)).toMatchObject({
        status: "rejected",
        reason: "tool_authority_mismatch",
      });
      await expect(read(REQUESTER)).resolves.toMatchObject({ sessionKey: REQUESTER });
      await expect(read(REQUESTER.replace("agent:main:", ""))).resolves.toMatchObject({
        messages: [],
      });
      await expect(read(PARTICIPANT_DRAFT)).resolves.toMatchObject({
        messages: [expect.objectContaining({ content: "Alice's distinctive draft marker" })],
      });
      await expect(dispatchGatewayMethodInProcess("sessions.list", {})).resolves.toMatchObject({
        sessions: expect.arrayContaining([expect.objectContaining({ key: PARTICIPANT_DRAFT })]),
      });
      await expect(
        dispatchGatewayMethodInProcess("agent.wait", {
          runId: turn.runtimeIdentity.operationalRunInstance.runId,
          timeoutMs: 0,
        }),
      ).resolves.toMatchObject({ status: "timeout" });
      await expect(
        dispatchGatewayMethodInProcess("agent.wait", { runId: "unknown-run", timeoutMs: 0 }),
      ).resolves.toMatchObject({ status: "timeout" });
      await expect(
        dispatchGatewayMethodInProcess("chat.abort", { sessionKey: PARTICIPANT_DRAFT }),
      ).resolves.toMatchObject({ ok: true, aborted: false, runIds: [] });
      expect(turn.operation.abortSignal.aborted).toBe(false);
      const context = getPluginRuntimeGatewayRequestScope()?.context;
      if (!context) {
        throw new Error("expected local Gateway context");
      }
      const custody = await captureAgentHarnessCompletionCustody(
        createAgentHarnessCompletionScope({ requesterSessionKey: REQUESTER }),
      );
      const runtime = createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: createRequestGatewayMethodRegistry,
        isDispatchAvailable: () => true,
      });
      try {
        expect(custody?.isCurrent()).toBe(true);
        // The closed recovery principal owns accepted cross-session delivery independently.
        await expect(
          runtime.recovery.dispatchSessionMethod("chat.history", {
            sessionKey: PARTICIPANT_DRAFT,
          }),
        ).resolves.toMatchObject({
          messages: [expect.objectContaining({ content: "Alice's distinctive draft marker" })],
        });
        context.readChatStartupProjection = async () => {
          turn.complete();
          return undefined;
        };
        await expect(read(REQUESTER)).rejects.toThrow(/turn has ended|no longer active/);
        await expect(
          dispatchGatewayMethodInProcess("agent", {
            sessionKey: REQUESTER,
            sessionId: PARTICIPANT_DRAFT_ID,
            message: "unselected transcript override",
            idempotencyKey: "unselected-transcript-override",
          }),
        ).rejects.toThrow(/turn has ended|no longer active/);
      } finally {
        runtime.close();
        custody?.release();
      }
    });
  });

  it("preserves the current requester for runtime-only reads after rejected steering", async () => {
    await withParticipantSessionToolsFixture(async ({ turn, alice, bob }) => {
      const context = getPluginRuntimeGatewayRequestScope()?.context;
      const operatorRunAuthority = getGatewayToolCallerIdentity()?.operatorAuthority;
      if (!context || !operatorRunAuthority) {
        throw new Error("expected local Gateway context and admitted operator");
      }
      const client = sharingPolicyClient({ user: alice.profileId });
      client.connect.client.id = "gateway-client";
      client.internal = {
        syntheticClient: true,
        agentRuntimeIdentity: turn.runtimeIdentity,
        operatorRunAuthority,
        operatorRoleActor: { kind: "operator", profileId: alice.profileId },
      };
      const respond = vi.fn<GatewayRequestOptions["respond"]>();
      const read = (sessionKey = PARTICIPANT_DRAFT) =>
        withoutGatewayToolCallerIdentity(() =>
          handleGatewayRequest({
            req: {
              type: "req",
              id: "runtime-participant-history",
              method: "chat.history",
              params: { sessionKey, agentId: "main" },
            },
            context,
            client,
            isWebchatConnect: () => false,
            respond,
          }),
        );
      await expect(read()).resolves.toBeUndefined();
      expect(respond.mock.calls).toMatchObject([
        [
          true,
          { messages: [expect.objectContaining({ content: "Alice's distinctive draft marker" })] },
        ],
      ]);
      expect(await turn.steer(bob)).toMatchObject({
        status: "rejected",
        reason: "tool_authority_mismatch",
      });
      respond.mockClear();
      await expect(read(REQUESTER)).resolves.toBeUndefined();
      expect(respond.mock.calls).toMatchObject([[true, { sessionKey: REQUESTER }]]);
      respond.mockClear();
      await expect(read()).resolves.toBeUndefined();
      expect(respond.mock.calls).toMatchObject([
        [
          true,
          { messages: [expect.objectContaining({ content: "Alice's distinctive draft marker" })] },
        ],
      ]);
      respond.mockClear();
      context.readChatStartupProjection = async () => {
        turn.complete();
        return undefined;
      };
      await expect(read(REQUESTER)).resolves.toBeUndefined();
      expect(respond.mock.calls).toMatchObject([
        [
          false,
          undefined,
          {
            code: "INVALID_REQUEST",
            message: expect.stringMatching(/turn has ended|no longer active/),
          },
        ],
      ]);
    });
  });
}
