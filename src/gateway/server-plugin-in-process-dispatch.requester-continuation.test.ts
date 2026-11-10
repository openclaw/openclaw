import { describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import {
  clearTestEmbeddedRun,
  registerTestEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { captureRequesterOrigin } from "../agents/requester-origin.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
  withGatewayToolCallerIdentity,
  withGatewayPersonalToolUser,
} from "../agents/tools/gateway-caller-context.js";
import { queueSessionsSendSteeringWithCustody } from "../agents/tools/sessions-send-tool.steering.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  clearAgentRunContext,
} from "../infra/agent-run-registry.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createReplyTurnParticipants } from "../sessions/session-controller.tool-authority.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import {
  captureOperatorToolGatewayContinuationContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

describe("accepted steering queue custody", () => {
  it.each(["consumed", "receiver-ended", "rejected", "source-revoked"] as const)(
    "settles queue custody on %s, never on an accepted confirmation error",
    async (boundary) =>
      withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
        await captureRuntimeConfigAsyncReader()();
        const client = createOperatorClient({
          profileName: "queue-custody-owner",
          scopes: ["operator.read", "operator.write"],
        });
        const context = createContext();
        const resolveGatewayContext = () => context;
        context.resolveGatewayContext = resolveGatewayContext;
        const device = captureGatewayDeviceRevocation(
          context,
          { deviceId: "queue-custody-device", role: "operator" },
          () => true,
          undefined,
          { isCurrent: () => true, subscribe: () => () => {} },
        );
        const source = await captureGatewayOperatorRunAuthority({
          client,
          context,
          hasCurrentClientAuthority: device.isCurrent,
        });
        const sessionKey = "agent:main:dashboard:queue-custody";
        const sessionId = "queue-custody-session";
        const requesterOrigin = captureRequesterOrigin({
          sessionKey,
          operatorProfileId: client.authenticatedUserProfile?.profileId,
        });
        if (!source || !requesterOrigin) {
          throw new Error("Expected an authenticated original source");
        }
        const handle = {
          runId: "queue-custody-active-run",
          isStreaming: () => true,
          isCompacting: () => false,
          queueMessage: async () => {},
          abort: () => {},
        };
        await replaceSessionEntry({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
        const operation = registerTestEmbeddedRun(sessionId, handle, sessionKey, undefined, "main");
        let assertRetained: (() => void) | undefined;
        let settle: (() => void) | undefined;
        const failure = new Error("Synthetic confirmation unavailable");
        const assertQueue = () => {
          if (!assertRetained) {
            throw new Error("Queue preparation did not capture its real source assertion");
          }
          assertRetained();
        };
        try {
          await expect(
            withPluginRuntimeGatewayRequestScope(
              {
                client,
                context,
                resolveGatewayContext,
                hasCurrentClientAuthority: device.isCurrent,
                isWebchatConnect: () => false,
              },
              () =>
                withOperatorToolGatewayAuthority({ scopes: client.connect.scopes ?? [] }, () =>
                  withGatewayToolCallerIdentity(
                    {
                      agentId: "main",
                      sessionKey,
                      requesterOrigin,
                      operatorAuthority: source.authority,
                    },
                    () =>
                      queueSessionsSendSteeringWithCustody(
                        { agentId: "main", sessionKey, sessionId },
                        operation,
                        () => source.authority.assertCurrent(),
                        async (assertCurrent, lifecycle) => {
                          assertRetained = assertCurrent;
                          settle = lifecycle.onQueueSettled;
                          assertCurrent();
                          if (boundary === "source-revoked") {
                            invalidateGatewayDeviceRevocation(
                              context,
                              "queue-custody-device",
                              "operator",
                            );
                            assertCurrent();
                          }
                          if (boundary !== "rejected") {
                            lifecycle.onQueueAccepted?.(true);
                          }
                          throw failure;
                        },
                      ),
                  ),
                ),
            ),
          ).rejects.toThrow(boundary === "source-revoked" ? undefined : failure.message);
          if (boundary === "rejected" || boundary === "source-revoked") {
            await vi.waitFor(() => expect(assertQueue).toThrow());
            return;
          }
          // This is the actual retained mutation/source guard, not an echo of the ACK.
          // A caller error cannot release input already accepted by this exact receiver.
          await Promise.resolve();
          expect(assertQueue).not.toThrow();
          if (boundary === "receiver-ended") {
            clearTestEmbeddedRun(sessionId, handle);
          } else {
            settle?.();
          }
          await vi.waitFor(() => expect(assertQueue).toThrow());
        } finally {
          settle?.();
          clearTestEmbeddedRun(sessionId, handle);
          source.release();
          device.release();
        }
      }),
  );
});

describe("retained requester continuation", () => {
  it.each([
    ["released", true],
    ["device revoked", true],
    ["gateway replaced", true],
    ["released", false],
    ["device revoked", false],
    ["gateway replaced", false],
  ] as const)(
    "fences requester selection when its retained owner is %s (origin: %s)",
    async (boundary, hasOrigin) =>
      withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
        const client = createOperatorClient({
          profileName: "retained-requester",
          scopes: ["operator.read", "operator.write"],
        });
        const context = createContext();
        let gatewayCurrent = true;
        let connected = true;
        let receiptCurrent = true;
        const resolveGatewayContext = () => (gatewayCurrent ? context : undefined);
        context.resolveGatewayContext = resolveGatewayContext;
        const device = captureGatewayDeviceRevocation(
          context,
          { deviceId: "retained-requester-device", role: "operator" },
          () => connected,
          undefined,
          { isCurrent: () => true, subscribe: () => () => {} },
        );
        const source = await captureGatewayOperatorRunAuthority({
          client,
          context,
          hasCurrentClientAuthority: device.isCurrent,
        });
        const requesterOrigin = captureRequesterOrigin({
          sessionKey: "agent:main:requester",
          operatorProfileId: client.authenticatedUserProfile?.profileId,
        });
        if (!source || !requesterOrigin) {
          throw new Error("Expected authenticated requester authority");
        }
        const admitted = createTestAdmittedRunContext("ended-requester");
        const approvalAuthority = claimAgentRunDelegatedAuthority(admitted.operationalRunInstance);
        let captured: Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>;
        try {
          captured = await withPluginRuntimeGatewayRequestScope(
            {
              client,
              context,
              resolveGatewayContext,
              hasCurrentClientAuthority: device.isCurrent,
              isWebchatConnect: () => false,
            },
            () =>
              withOperatorToolGatewayAuthority({ scopes: client.connect.scopes ?? [] }, () =>
                withGatewayToolCallerIdentity(
                  {
                    agentId: "main",
                    sessionKey: "agent:main:requester",
                    requesterOrigin: hasOrigin ? requesterOrigin : undefined,
                    operatorAuthority: source.authority,
                    operationalRunInstance: admitted.operationalRunInstance,
                    approvalAuthority,
                    receiptAuthority: () => receiptCurrent,
                    fullPermission: true,
                    sessionEventToolsAllow: ["sessions_send"],
                  },
                  async () => {
                    expect(getGatewayToolCallerIdentity()?.approvalAuthority).toBe(
                      approvalAuthority,
                    );
                    const pending = captureOperatorToolGatewayContinuationContext(undefined, {
                      retainRequester: true,
                    });
                    if (!pending) {
                      throw new Error("Expected retained requester owner");
                    }
                    return await pending;
                  },
                ),
              ),
          );
          if (!captured) {
            throw new Error("Requester transfer did not capture its source");
          }
          receiptCurrent = false;
          connected = false;
          source.release();
          device.release();
          // Ordinary cleanup never reacquires a tool caller.
          expect(captured.run(() => getGatewayToolCallerIdentity())).toBeUndefined();
          const retained = await captured.runWithRequester(async () => {
            const caller = getGatewayToolCallerIdentity();
            expect(caller?.agentId).toBe("main");
            expect(caller?.sessionKey).toBe("agent:main:requester");
            expect(caller?.approvalAuthority).toBeUndefined();
            expect(caller?.operationalRunInstance).toBeUndefined();
            expect(caller?.receiptAuthority).toBeUndefined();
            expect(caller?.fullPermission).toBeUndefined();
            expect(caller?.sessionEventToolsAllow).toBeUndefined();
            const selection = resolveGatewayToolOperatorSelection({ requireRequesterOrigin: true });
            expect(selection.requesterOrigin).toEqual(hasOrigin ? requesterOrigin : undefined);
            expect(selection.operatorAuthority).toBe(captured?.operatorAuthority);
            selection.assertCurrent();
            return selection;
          });
          if (boundary === "released") {
            captured.release();
          } else if (boundary === "device revoked") {
            invalidateGatewayDeviceRevocation(context, "retained-requester-device", "operator");
          } else {
            gatewayCurrent = false;
          }
          expect(retained.assertCurrent).toThrow();
          const effect = vi.fn(async () => {});
          await expect((async () => captured?.runWithRequester(effect))()).rejects.toThrow();
          expect(effect).not.toHaveBeenCalled();
          expect(getGatewayToolCallerIdentity()).toBeUndefined();
        } finally {
          captured?.release();
          releaseAgentRunDelegatedAuthority(approvalAuthority);
          clearAgentRunContext(admitted.operationalRunInstance.runId);
          source.release();
          device.release();
        }
      }),
  );

  it("retains Bob selected through Alice with their scope intersection and Bob's source fence", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const alice = createOperatorClient({
        profileName: "selecting-alice",
        scopes: ["operator.write"],
      });
      const bob = createOperatorClient({
        profileName: "selected-bob",
        scopes: ["operator.read", "operator.write", "operator.approvals"],
      });
      const context = createContext();
      const resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
      let aliceConnected = true;
      let bobConnected = true;
      let receiptCurrent = true;
      const aliceDevice = captureGatewayDeviceRevocation(
        context,
        { deviceId: "selecting-alice-device", role: "operator" },
        () => aliceConnected,
        undefined,
        { isCurrent: () => true, subscribe: () => () => {} },
      );
      const bobDevice = captureGatewayDeviceRevocation(
        context,
        { deviceId: "selected-bob-device", role: "operator" },
        () => bobConnected,
        undefined,
        { isCurrent: () => true, subscribe: () => () => {} },
      );
      const aliceSource = await captureGatewayOperatorRunAuthority({
        client: alice,
        context,
        hasCurrentClientAuthority: aliceDevice.isCurrent,
      });
      const bobSource = await captureGatewayOperatorRunAuthority({
        client: bob,
        context,
        hasCurrentClientAuthority: bobDevice.isCurrent,
      });
      const sessionKey = "agent:main:selected-requester";
      const aliceOrigin = captureRequesterOrigin({
        sessionKey,
        operatorProfileId: alice.authenticatedUserProfile?.profileId,
      });
      const bobOrigin = captureRequesterOrigin({
        sessionKey,
        operatorProfileId: bob.authenticatedUserProfile?.profileId,
      });
      if (!aliceSource || !bobSource || !aliceOrigin || !bobOrigin) {
        throw new Error("Expected both authenticated participant sources");
      }
      const selectedBobOrigin = {
        ...bobOrigin,
        delegatedCreatorProfileId: aliceSource.authority.profileId,
      };
      const participants = createReplyTurnParticipants({
        operatorAuthority: aliceSource.authority,
        requesterOrigin: aliceOrigin,
      });
      participants.accept({
        operatorAuthority: bobSource.authority,
        requesterOrigin: bobOrigin,
      });
      let captured: Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>;
      try {
        captured = await withPluginRuntimeGatewayRequestScope(
          {
            client: alice,
            context,
            resolveGatewayContext,
            hasCurrentClientAuthority: aliceDevice.isCurrent,
            isWebchatConnect: () => false,
          },
          () =>
            withOperatorToolGatewayAuthority(
              {
                authenticatedUserProfile: alice.authenticatedUserProfile,
                scopes: alice.connect.scopes ?? [],
              },
              () =>
                withGatewayToolCallerIdentity(
                  {
                    agentId: "main",
                    sessionKey,
                    requesterOrigin: aliceOrigin,
                    operatorAuthority: aliceSource.authority,
                    personalToolParticipants: participants,
                    operationalRunInstance:
                      createOperationalRunInstanceRef("finished-alice-selector"),
                    receiptAuthority: () => receiptCurrent,
                    fullPermission: true,
                  },
                  () =>
                    withGatewayPersonalToolUser(bobSource.authority.profileId, async () => {
                      const selected = resolveGatewayToolOperatorSelection({
                        requireRequesterOrigin: true,
                      });
                      expect(selected.requesterOrigin).toEqual(selectedBobOrigin);
                      expect(selected.operatorAuthority).toBe(bobSource.authority);
                      const pending = captureOperatorToolGatewayContinuationContext(undefined, {
                        retainRequester: true,
                      });
                      if (!pending) {
                        throw new Error("Expected selected participant custody");
                      }
                      return await pending;
                    }),
                ),
            ),
        );
        if (!captured) {
          throw new Error("Selected participant source was not captured");
        }
        // Participant/turn membership and both sockets end; the accepted owner holds Bob's source.
        participants.close();
        receiptCurrent = false;
        aliceConnected = false;
        bobConnected = false;
        aliceSource.release();
        bobSource.release();
        aliceDevice.release();
        bobDevice.release();
        // Write implies read; approvals belong only to Bob and must not survive Alice's ceiling.
        expect(captured.scopes).toEqual(["operator.read", "operator.write"]);
        expect(captured.operatorAuthority?.scopes).toEqual(["operator.read", "operator.write"]);
        expect(captured.operatorAuthority?.profileId).toBe(bobSource.authority.profileId);
        const retained = await captured.runWithRequester(async () => {
          const caller = getGatewayToolCallerIdentity();
          expect(caller?.operationalRunInstance).toBeUndefined();
          expect(caller?.receiptAuthority).toBeUndefined();
          expect(caller?.fullPermission).toBeUndefined();
          expect(caller?.personalToolParticipants).toBeUndefined();
          const selection = resolveGatewayToolOperatorSelection({ requireRequesterOrigin: true });
          expect(selection.requesterOrigin).toEqual(selectedBobOrigin);
          expect(selection.requesterOrigin).not.toEqual(aliceOrigin);
          expect(selection.operatorAuthority).toBe(captured?.operatorAuthority);
          expect(selection.operatorAuthority?.scopes).toEqual(["operator.read", "operator.write"]);
          const client = getPluginRuntimeGatewayRequestScope()?.client;
          expect(client?.internal?.operatorRunAuthority).toBe(captured?.operatorAuthority);
          expect(client?.connect.scopes).toEqual(["operator.read", "operator.write"]);
          selection.assertCurrent();
          await expect(
            withGatewayPersonalToolUser(aliceSource.authority.profileId, async () =>
              resolveGatewayToolOperatorSelection({ requireRequesterOrigin: true }),
            ),
          ).rejects.toThrow("Selecting user requires an active personal-tool turn");
          return selection;
        });
        invalidateGatewayDeviceRevocation(context, "selected-bob-device", "operator");
        expect(retained.assertCurrent).toThrow();
        const effect = vi.fn(async () => {});
        await expect((async () => captured?.runWithRequester(effect))()).rejects.toThrow();
        expect(effect).not.toHaveBeenCalled();
        expect(getGatewayToolCallerIdentity()).toBeUndefined();
      } finally {
        captured?.release();
        participants.close();
        aliceSource.release();
        bobSource.release();
        aliceDevice.release();
        bobDevice.release();
      }
    });
  });
});
