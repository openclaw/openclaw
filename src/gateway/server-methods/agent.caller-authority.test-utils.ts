// Imported by agent.test.ts to reuse its existing mocked runtime graph.
import { expectDefined, isRecord } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAgentCommandExecutionIdentity } from "../../agents/agent-command-execution-identity.js";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayTool } from "../../agents/tools/in-process-gateway.js";
import {
  withPluginRuntimeGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import * as userTurn from "../agent-turn/agent-run-user-turn.js";
import {
  captureGatewayDeviceRevocation,
  closeGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { handleGatewayRequest } from "../server-methods.js";
import { disconnectStaleSharedGatewayAuthClients } from "../server-shared-auth-generation.js";
import { agentHandlers } from "./agent.js";
import {
  describe1AfterEach1,
  describe1BeforeEach0,
  getAgentTestMocks,
  makeContext,
  operatorWriteCliClient,
  prime,
  waitForAgentCommandCall,
  waitForAssertion,
} from "./agent.test-harness.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

describe("gateway agent caller authority custody", () => {
  beforeEach(describe1BeforeEach0);
  afterEach(describe1AfterEach1);

  it.each(["operator", "maintainer", "system"] as const)(
    "preserves accepted %s authority through command admission and later tool calls",
    async (kind) => {
      prime();
      const context = makeContext();
      context.resolveGatewayContext = () => context;
      const write = vi.fn(({ respond }: GatewayRequestHandlerOptions) =>
        respond(true, { saved: true }),
      );
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: "agent",
            scope: "operator.write",
            owner: { kind: "core", area: "agents" },
            handler: expectDefined(agentHandlers.agent, "agent handler missing"),
          },
          {
            name: "config.get",
            scope: "operator.read",
            owner: { kind: "core", area: "config" },
            handler: ({ client: reader, respond }: GatewayRequestHandlerOptions) => {
              if (kind !== "system") {
                expect(reader?.internal?.operatorRoleActor).toEqual({
                  kind: "operator",
                  profileId: `source-${kind}`,
                });
                expect(reader?.authenticatedUserProfile?.profileId).not.toBe("later-maintainer");
              }
              respond(true, { visible: true });
            },
          },
          {
            name: "config.set",
            scope: "operator.admin",
            owner: { kind: "core", area: "config" },
            handler: write,
          },
        ]);
      const connection = new AbortController();
      const client = {
        ...operatorWriteCliClient([kind === "maintainer" ? "operator.admin" : "operator.write"]),
        connectionSignal: connection.signal,
        invalidated: false,
        usesSharedGatewayAuth: true,
        sharedGatewaySessionGeneration: "original-generation",
        socket: { close: () => connection.abort() },
        internal: {
          operatorRoleActor:
            kind === "system"
              ? { kind: "system" as const }
              : { kind: "operator" as const, profileId: `source-${kind}` },
        },
      };
      const caller = captureGatewayDeviceRevocation(
        context,
        { deviceId: `device-${kind}`, role: "operator" },
        () => !client.invalidated,
        connection.signal,
      );
      const runId = `accepted-authority-${kind}`;
      let proof: Promise<void> | undefined;
      getAgentTestMocks().agentCommand.mockImplementation(
        (opts: AgentCommandGatewayIngressOpts) => {
          proof = (async () => {
            const admission = prepareAgentCommandExecutionIdentity({
              opts,
              prepared: {
                cfg: {},
                runId,
                sessionAgentId: "main",
                sessionId: "existing-session-id",
                sessionKey: "agent:main:main",
              },
              ingress: { kind: "gateway-client", boundary: "agent", state: "present" },
              lifecycleGeneration: expectDefined(
                opts.lifecycleGeneration,
                "run generation missing",
              ),
            });
            try {
              const admitted = await admission.admit("embedded");
              expect(admitted.executionIdentityToken).toBeUndefined();
              const identity = createAdmittedGatewayToolCallerIdentity({
                admittedRunContext: admitted,
                agentId: "main",
                sessionKey: "agent:main:main",
              });
              await withPluginRuntimeGatewayContextResolver(
                () => context,
                () =>
                  withGatewayToolCallerIdentity(identity, async () => {
                    await expect(callInProcessGatewayTool("config.get", {})).resolves.toEqual({
                      visible: true,
                    });
                    if (kind === "operator") {
                      await withPluginRuntimeGatewayRequestScope(
                        {
                          context,
                          isWebchatConnect: () => false,
                          client: {
                            ...operatorWriteCliClient(["operator.admin"]),
                            authenticatedUserProfile: {
                              profileId: "later-maintainer",
                              displayName: null,
                              hasAvatar: false,
                              updatedAt: 1,
                            },
                          },
                          hasCurrentClientAuthority: () => false,
                        },
                        async () => {
                          await expect(callInProcessGatewayTool("config.get", {})).resolves.toEqual(
                            { visible: true },
                          );
                        },
                      );
                    }
                    const mutation = callInProcessGatewayTool("config.set", {});
                    if (kind === "operator") {
                      await expect(mutation).rejects.toThrow("missing scope: operator.admin");
                      expect(write).not.toHaveBeenCalled();
                    } else {
                      await expect(mutation).resolves.toEqual({ saved: true });
                      expect(write).toHaveBeenCalledOnce();
                    }
                    if (kind !== "system") {
                      if (kind === "maintainer") {
                        disconnectStaleSharedGatewayAuthClients({
                          clients: [client],
                          expectedGeneration: "rotated-generation",
                        });
                      } else {
                        invalidateGatewayDeviceRevocation(context, `device-${kind}`, "operator");
                      }
                      await expect(callInProcessGatewayTool("config.get", {})).rejects.toThrow(
                        "no longer active",
                      );
                    }
                  }),
                { inheritRequestScope: false },
              );
            } finally {
              await admission.finish();
            }
          })();
          return proof.then(() => ({ payloads: [{ text: "done" }], meta: { durationMs: 1 } }));
        },
      );
      try {
        await handleGatewayRequest({
          req: {
            type: "req",
            id: runId,
            method: "agent",
            params: { message: "hi", sessionKey: "agent:main:main", idempotencyKey: runId },
          },
          context,
          client,
          isWebchatConnect: () => false,
          hasCurrentClientAuthority: caller.isCurrent,
          methodRegistry: context.getGatewayMethodRegistry(),
          respond: (_ok, payload) => {
            if (isRecord(payload) && payload.status === "accepted") {
              caller.release();
              connection.abort();
            }
          },
        });
        await waitForAgentCommandCall();
        await expectDefined(proof, "command proof missing");
        await waitForAssertion(() => expect(context.chatAbortControllers.size).toBe(0));
        expect(caller.isCurrent()).toBe(false);
      } finally {
        caller.release();
        closeGatewayDeviceRevocation(context);
      }
    },
  );

  it("releases the original caller when the acceptance publisher throws", async () => {
    prime();
    const prepareInput = userTurn.prepareAgentRunUserTurn;
    let preparedInput: Awaited<ReturnType<typeof prepareInput>> | undefined;
    vi.spyOn(userTurn, "prepareAgentRunUserTurn").mockImplementationOnce(async (params) => {
      const prepared = await prepareInput(params);
      preparedInput = prepared;
      vi.spyOn(expectDefined(prepared.recorder, "input recorder missing"), "finishPendingInput");
      return prepared;
    });
    const context = makeContext();
    const caller = captureGatewayDeviceRevocation(
      context,
      { deviceId: "acceptance-device", role: "operator" },
      () => true,
    );
    const failure = new Error("acceptance publisher failed");
    const runId = "idem-acceptance-publisher-failure";
    const respond = vi.fn<RespondFn>((ok, payload) => {
      expect(ok).toBe(true);
      expect(payload).toMatchObject({ runId, status: "accepted" });
      caller.release();
      expect(caller.isCurrent()).toBe(true);
      throw failure;
    });
    try {
      await expect(
        expectDefined(
          agentHandlers.agent,
          "agent handler missing",
        )({
          params: { message: "hi", sessionKey: "agent:main:main", idempotencyKey: runId },
          req: { type: "req", id: runId, method: "agent" },
          context,
          client: null,
          isWebchatConnect: () => false,
          respond,
          hasCurrentClientAuthority: caller.isCurrent,
        }),
      ).rejects.toBe(failure);
      expect(respond).toHaveBeenCalledOnce();
      expect(getAgentTestMocks().agentCommand).not.toHaveBeenCalled();
      expect(caller.isCurrent()).toBe(false);
      const runtime = await expectDefined(
        vi.mocked(acquireAgentRunPreparedModelRuntime).mock.results.at(-1)?.value,
        "prepared runtime missing",
      );
      expect(runtime[Symbol.asyncDispose]).toHaveBeenCalledOnce();
      expect(preparedInput?.recorder?.finishPendingInput).toHaveBeenCalledExactlyOnceWith(
        "interrupted",
      );
    } finally {
      caller.release();
      closeGatewayDeviceRevocation(context);
    }
  });
});
