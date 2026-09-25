import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGitHubIdentityStatusTool } from "../agents/tools/github-identity-status-tool.js";
import {
  callAgentToolGatewayRequest,
  runWithGatewayToolContinuationContext,
} from "../agents/tools/in-process-gateway.js";
import { runSessionsSendA2AFlow } from "../agents/tools/sessions-send-tool.a2a.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
  readGatewayDeviceSourceAuthority,
} from "./device-revocation.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import * as operatorCapture from "./operator-run-authority.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  captureOperatorToolGatewayContinuationContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

const startTurn = vi.hoisted(() => vi.fn());
const waitForTurn = vi.hoisted(() => vi.fn());

vi.mock("./agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({
    startTurn,
    waitForTurn,
  }),
}));

describe("typed in-process agent continuation authorization", () => {
  beforeEach(() => {
    startTurn.mockReset();
    waitForTurn.mockReset();
  });

  it.each(["invocation", "receipt"] as const)(
    "rejects continuation transfer when its %s closes during preparation",
    async (closed) => {
      const client = createOperatorClient({
        profileName: "preparing-continuation",
        scopes: ["operator.write"],
      });
      const context = createContext();
      context.resolveGatewayContext = () => context;
      const source = await operatorCapture.captureGatewayOperatorRunAuthority({ client, context });
      if (!source) {
        throw new Error("Expected operator source");
      }
      client.internal = { operatorRunAuthority: source.authority };
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      let receiptCurrent = true;
      let pending: ReturnType<typeof captureOperatorToolGatewayContinuationContext>;
      let settled:
        | Promise<Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>>
        | undefined;
      const capture = operatorCapture.captureGatewayOperatorRunAuthority;
      let restoreCapture = () => {};
      try {
        await withPluginRuntimeGatewayRequestScope(
          { client, context, isWebchatConnect: () => false },
          () =>
            withOperatorToolGatewayAuthority({ scopes: ["operator.write"] }, async () => {
              const held = vi
                .spyOn(operatorCapture, "captureGatewayOperatorRunAuthority")
                .mockImplementationOnce(async (...args) => {
                  const captured = await capture(...args);
                  entered.resolve();
                  await resume.promise;
                  return captured;
                });
              restoreCapture = () => held.mockRestore();
              await withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey: "agent:main:main",
                  operationalRunInstance: createOperationalRunInstanceRef("preparing-continuation"),
                  receiptAuthority: () => receiptCurrent,
                },
                async () => {
                  pending = captureOperatorToolGatewayContinuationContext();
                  if (!pending) {
                    throw new Error("Expected continuation preparation");
                  }
                  settled = pending.catch(() => undefined);
                  await entered.promise;
                  if (closed === "receipt") {
                    receiptCurrent = false;
                    resume.resolve();
                    await expect(pending).rejects.toThrow("agent tool caller authority");
                  }
                },
              );
            }),
        );
        if (closed === "invocation") {
          resume.resolve();
          if (!pending) {
            throw new Error("Expected continuation preparation");
          }
          await expect(pending).rejects.toThrow("operator tool invocation authority expired");
        }
        source.release();
        expect(source.authority.assertCurrent).toThrow();
      } finally {
        resume.resolve();
        (await settled)?.release();
        restoreCapture();
        source.release();
      }
    },
  );

  it.each([false, true])(
    "preserves roles-enabled dispatch without promoting scoped unknown callers (%s)",
    async (scopedUnknown) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const context = createContext();
        context.getRuntimeConfig = () => ({
          agents: { list: [{ id: "main" }] },
          gateway: {
            roles: {
              default: "limited",
              definitions: {
                limited: {
                  sessions: { others: "none" },
                  agents: ["guest"],
                  scopes: ["operator.write"],
                },
              },
            },
          },
        });
        const sessionKey = "agent:main:requester";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "requester-session",
            updatedAt: 1,
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: "session-owner" },
          },
        );
        const unknownClient = {
          ...createOperatorClient({ profileId: "unknown", scopes: ["operator.write"] }),
          authenticatedUserId: undefined,
          authenticatedUserProfile: undefined,
        };
        const result = { runId: "system-reply", status: "ok" };
        startTurn.mockImplementation(async ({ io }) =>
          io.emitAcceptance([true, result, undefined]),
        );
        await withPluginRuntimeGatewayRequestScope(
          {
            context,
            resolveGatewayContext: () => context,
            isWebchatConnect: () => false,
            ...(scopedUnknown ? { client: unknownClient } : {}),
          },
          async () => {
            const dispatch = () =>
              callAgentToolGatewayRequest({
                method: "agent",
                params: {
                  sessionKey,
                  message: "Return the accepted result",
                  idempotencyKey: "system-reply",
                },
              });
            if (!scopedUnknown) {
              await expect(dispatch()).resolves.toEqual(result);
              expect(startTurn).toHaveBeenCalledOnce();
              startTurn.mockClear();
            }
            const continuation = runWithGatewayToolContinuationContext(dispatch);
            if (scopedUnknown) {
              await expect(continuation).rejects.toThrow(/not found|cannot create|identity/i);
              expect(startTurn).not.toHaveBeenCalled();
            } else {
              await expect(continuation).resolves.toEqual(result);
              expect(startTurn).toHaveBeenCalledOnce();
            }
          },
        );
      });
    },
  );

  it.each(["disconnected", "device revoked", "gateway replaced"] as const)(
    "settles sessions_send after its requester ends (%s)",
    async (boundary) => {
      const owner = createOperatorClient({
        profileName: "reply-owner",
        scopes: ["operator.read", "operator.write"],
      });
      const context = createContext();
      let connected = true;
      let gatewayCurrent = true;
      const resolveGatewayContext = () => (gatewayCurrent ? context : undefined);
      context.resolveGatewayContext = resolveGatewayContext;
      const source = captureGatewayDeviceRevocation(
        context,
        { deviceId: "reply-device", role: "operator" },
        () => connected,
        undefined,
        { isCurrent: () => true, subscribe: () => () => {} },
      );
      const dispatchErrors: string[] = [];
      const waitStarted = createDeferredCore();
      const targetFinished = createDeferredCore();
      waitForTurn.mockImplementation(async ({ runId }) => {
        if (runId === "target-followup") {
          waitStarted.resolve();
          await targetFinished.promise;
        }
        return {
          result: {
            status: "ok",
            terminalReply: { disposition: "visible", text: "Target work finished" },
          },
        };
      });
      startTurn.mockImplementation(async ({ principal, io, preflight: { request } }) => {
        expect(principal.connect.scopes).toEqual(["operator.write"]);
        expect(principal.authenticatedUserProfile?.profileId).toBe(
          owner.authenticatedUserProfile!.profileId,
        );
        io.emitAcceptance([true, { runId: request.idempotencyKey, status: "accepted" }, undefined]);
        io.emitFinal([true, { runId: request.idempotencyKey, status: "ok" }, undefined]);
      });
      try {
        const { pending: replyFlow } = await withPluginRuntimeGatewayRequestScope(
          {
            client: owner,
            context,
            isWebchatConnect: () => false,
            hasCurrentClientAuthority: source.isCurrent,
            resolveGatewayContext,
          },
          () =>
            withOperatorToolGatewayAuthority(
              {
                authenticatedUserProfile: owner.authenticatedUserProfile,
                scopes: owner.connect.scopes ?? [],
              },
              async () => {
                const pending = runWithGatewayToolContinuationContext(() =>
                  runSessionsSendA2AFlow({
                    targetAgentId: "main",
                    targetSessionKey: "agent:main:child",
                    displayKey: "agent:main:child",
                    requesterAgentId: "main",
                    requesterSessionKey: "agent:main:requester",
                    requesterChannel: "webchat",
                    replyMode: "one-way",
                    message: "Finish the task",
                    waitRunId: "target-followup",
                    announceTimeoutMs: 10_000,
                    maxPingPongTurns: 0,
                    callGateway: async (request) => {
                      try {
                        return await callAgentToolGatewayRequest(request);
                      } catch (error) {
                        dispatchErrors.push(String(error));
                        throw error;
                      }
                    },
                  }),
                );
                await waitStarted.promise;
                return { pending };
              },
            ),
        );
        connected = false;
        source.release();
        if (boundary === "device revoked") {
          invalidateGatewayDeviceRevocation(context, "reply-device", "operator");
        }
        if (boundary === "gateway replaced") {
          gatewayCurrent = false;
        }
        targetFinished.resolve();
        await replyFlow;
        expect(readGatewayDeviceSourceAuthority(source.isCurrent)?.()).toBe(false);
        if (boundary !== "disconnected") {
          expect(dispatchErrors.length).toBeGreaterThan(0);
          expect(startTurn).not.toHaveBeenCalled();
          return;
        }
        expect(dispatchErrors).toEqual([]);
        expect(startTurn).toHaveBeenCalledOnce();
        expect(startTurn.mock.calls[0]?.[0].preflight.request).toMatchObject({
          sessionKey: "agent:main:requester",
          inputProvenance: {
            sourceTool: "subagent_announce",
            sourceSessionKey: "agent:main:child",
          },
        });
      } finally {
        source.release();
        targetFinished.resolve();
      }
    },
  );

  it.each(["sessions_send", "subagent_announce", "subagent_settle"] as const)(
    "preserves GitHub identity access after %s admits a write-only continuation",
    async (sourceTool) => {
      const owner = createOperatorClient({
        profileName: "continuation-owner",
        scopes: ["operator.read", "operator.write"],
      });
      const readResult = { effective: { credentialState: "available", refreshState: "idle" } };
      const readHandler = vi.fn(({ client, respond }: GatewayRequestHandlerOptions) => {
        expect(client?.connect.scopes).toEqual(["operator.read"]);
        expect(client?.authenticatedUserProfile?.profileId).toBe(
          owner.authenticatedUserProfile!.profileId,
        );
        respond(true, readResult);
      });
      const context = createContext();
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "tools.github.status",
            scope: "operator.read",
            owner: { kind: "core", area: "sessions" },
            handler: readHandler,
          },
        ]);
      const runId = `continuation-${sourceTool}`;
      startTurn.mockImplementation(async ({ principal, io }) => {
        expect(principal.connect.scopes).toEqual(["operator.write"]);
        io.emitAcceptance([true, { runId, status: "accepted" }, undefined]);
        const result = await withGatewayToolCallerIdentity(
          { agentId: "main", sessionKey: "agent:main:continuation" },
          () => createGitHubIdentityStatusTool().execute("identity-status", {}),
        );
        expect(result.details).toEqual(readResult);
        io.emitFinal([true, { runId, status: "ok" }, undefined]);
      });
      const params = {
        message: "Continue the delegated task",
        idempotencyKey: runId,
        inputProvenance: {
          kind: "inter_session" as const,
          sourceSessionKey: "agent:main:child",
          sourceTool,
        },
      };
      await expect(
        withPluginRuntimeGatewayRequestScope(
          { client: owner, context, isWebchatConnect: () => false },
          async () => {
            if (sourceTool === "sessions_send") {
              return await callAgentToolGatewayRequest({
                method: "agent",
                params,
                expectFinal: true,
              });
            }
            const { runAnnounceAgentCall } =
              await import("../agents/subagents/announce/subagent-announce-completion-delivery.js");
            return await runAnnounceAgentCall({
              agentParams: params,
              expectFinal: true,
              isExecutionAllowed: () => true,
              resolveGatewayContext: () => context,
            });
          },
        ),
      ).resolves.toEqual({ runId, status: "ok" });
      expect(startTurn).toHaveBeenCalledOnce();
      expect(readHandler).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "current cohort",
    "finished invocation",
    "revoked source",
    "retired cohort",
    "provenance only",
  ] as const)("checks %s for a settle wake after the spawning tool ends", async (state) => {
    const { runAnnounceAgentCall } =
      await import("../agents/subagents/announce/subagent-announce-completion-delivery.js");
    const owner = createOperatorClient({
      profileName: "settle-owner",
      scopes: ["operator.write"],
    });
    const context = createContext();
    const sourceSignal = new AbortController();
    const source = await operatorCapture.captureGatewayOperatorRunAuthority({
      client: owner,
      context,
      sourceAuthority: {
        signal: sourceSignal.signal,
        assertCurrent: () => sourceSignal.signal.throwIfAborted(),
      },
    });
    if (!source) {
      throw new Error("expected original operator authority");
    }
    const runId = "announce:owned-settle-wake";
    const result = { runId, status: "ok" };
    startTurn.mockImplementation(async ({ principal, io }) => {
      expect(principal.connect.scopes).toEqual(["operator.write"]);
      expect(principal.internal.operatorRunAuthority).toBe(source.authority);
      io.emitAcceptance([true, { runId, status: "accepted" }, undefined]);
      io.emitFinal([true, result, undefined]);
    });
    const isExecutionAllowed = vi.fn(() => state !== "retired cohort");
    try {
      if (state === "revoked source") {
        sourceSignal.abort(new Error("original operator source revoked"));
      }
      const dispatch = withPluginRuntimeGatewayRequestScope(
        { client: owner, context, isWebchatConnect: () => false },
        () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: "agent:main:requester",
              operationalRunInstance: createOperationalRunInstanceRef("finished-spawner"),
              receiptAuthority: () => false,
              operatorAuthority: source.authority,
            },
            () => {
              const announce = () =>
                runAnnounceAgentCall({
                  agentParams: {
                    message: "Continue after the children settled",
                    idempotencyKey: runId,
                    inputProvenance: {
                      kind: "inter_session",
                      sourceSessionKey: "agent:main:child",
                      sourceTool: "subagent_settle",
                    },
                  },
                  settleWakeSourceSessionKeys:
                    state === "provenance only" ? undefined : ["agent:main:child"],
                  expectFinal: true,
                  isExecutionAllowed,
                  resolveGatewayContext: () => context,
                });
              if (state !== "finished invocation") {
                return announce();
              }
              const ready = createDeferredCore();
              return withOperatorToolGatewayAuthority(
                { scopes: source.authority.scopes, operatorRunAuthority: source.authority },
                async () => ({ pending: ready.promise.then(announce) }),
              ).then(({ pending }) => {
                ready.resolve();
                return pending;
              });
            },
          ),
      );
      if (state === "current cohort" || state === "finished invocation") {
        await expect(dispatch).resolves.toEqual(result);
        expect(isExecutionAllowed).toHaveBeenCalled();
        expect(startTurn).toHaveBeenCalledOnce();
      } else {
        const error = {
          "revoked source": "original operator source revoked",
          "retired cohort": "subagent source lifecycle changed before completion delivery",
          "provenance only": "agent tool caller authority is no longer active",
        }[state];
        await expect(dispatch).rejects.toThrow(error);
        expect(startTurn).not.toHaveBeenCalled();
      }
    } finally {
      source.release();
    }
  });
});
