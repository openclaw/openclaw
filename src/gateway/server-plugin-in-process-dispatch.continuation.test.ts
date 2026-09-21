import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGitHubIdentityStatusTool } from "../agents/tools/github-identity-status-tool.js";
import { callAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
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

  it.each(["sessions_send", "subagent_announce", "subagent_settle"] as const)(
    "preserves GitHub identity access after %s admits a write-only continuation",
    async (sourceTool) => {
      const owner = createOperatorClient({
        profileId: "continuation-owner",
        scopes: ["operator.read", "operator.write"],
      });
      const readResult = { effective: { credentialState: "available", refreshState: "idle" } };
      const readHandler = vi.fn(({ client, respond }: GatewayRequestHandlerOptions) => {
        expect(client?.connect.scopes).toEqual(["operator.read"]);
        expect(client?.authenticatedUserProfile?.profileId).toBe("continuation-owner");
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

  it.each(["current cohort", "revoked source", "retired cohort", "provenance only"] as const)(
    "checks %s for a settle wake after the spawning tool ends",
    async (state) => {
      const { runAnnounceAgentCall } =
        await import("../agents/subagents/announce/subagent-announce-completion-delivery.js");
      const owner = createOperatorClient({
        profileId: "settle-owner",
        scopes: ["operator.write"],
      });
      const context = createContext();
      const sourceSignal = new AbortController();
      const source = captureGatewayOperatorRunAuthority({
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
              () =>
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
                }),
            ),
        );
        if (state === "current cohort") {
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
    },
  );
});
