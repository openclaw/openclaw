import { expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
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

const inState = (run: () => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, run);

function currentContext() {
  const context = createContext();
  let current = true;
  context.resolveGatewayContext = () => (current ? context : undefined);
  return {
    context,
    replace: () => {
      current = false;
    },
  };
}

async function participant(
  context: ReturnType<typeof createContext>,
  name: string,
  sessionKey: string,
  scopes = ["operator.read", "operator.write"],
) {
  const client = createOperatorClient({ profileName: name, scopes });
  let connected = true;
  const device = captureGatewayDeviceRevocation(
    context,
    { deviceId: name, role: "operator" },
    () => connected,
    undefined,
    { isCurrent: () => true, subscribe: () => () => {} },
  );
  const source = await captureGatewayOperatorRunAuthority({
    client,
    context,
    hasCurrentClientAuthority: device.isCurrent,
  });
  const origin = captureRequesterOrigin({
    sessionKey,
    operatorProfileId: client.authenticatedUserProfile?.profileId,
  });
  if (!source || !origin) {
    throw new Error("Expected authenticated requester authority");
  }
  const release = () => {
    source.release();
    device.release();
  };
  return {
    client,
    source,
    origin,
    release,
    disconnect() {
      connected = false;
      release();
    },
    revoke() {
      invalidateGatewayDeviceRevocation(context, name, "operator");
    },
    run<T>(
      extra: Parameters<typeof withGatewayToolCallerIdentity>[0],
      run: () => T,
      selected = false,
    ) {
      return withPluginRuntimeGatewayRequestScope(
        {
          client,
          context,
          resolveGatewayContext: context.resolveGatewayContext!,
          hasCurrentClientAuthority: device.isCurrent,
          isWebchatConnect: () => false,
        },
        () =>
          withOperatorToolGatewayAuthority(
            {
              scopes,
              ...(selected ? { authenticatedUserProfile: client.authenticatedUserProfile } : {}),
            },
            () =>
              withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey,
                  requesterOrigin: origin,
                  operatorAuthority: source.authority,
                  ...extra,
                },
                run,
              ),
          ),
      );
    },
  };
}

async function retainRequester() {
  const captured = await captureOperatorToolGatewayContinuationContext(undefined, {
    retainRequester: true,
  });
  if (!captured) {
    throw new Error("Expected retained requester owner");
  }
  return captured;
}

it.each(["consumed", "receiver-ended", "rejected", "source-revoked"] as const)(
  "settles queue custody on %s, never on an accepted confirmation error",
  async (boundary) =>
    inState(async () => {
      await captureRuntimeConfigAsyncReader()();
      const { context } = currentContext();
      const sessionKey = "agent:main:dashboard:queue-custody";
      const sessionId = "queue-custody-session";
      const owner = await participant(context, "queue-custody-owner", sessionKey);
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
          owner.run({}, () =>
            queueSessionsSendSteeringWithCustody(
              { agentId: "main", sessionKey, sessionId },
              operation,
              () => owner.source.authority.assertCurrent(),
              async (assertCurrent, lifecycle) => {
                assertRetained = assertCurrent;
                settle = lifecycle.onQueueSettled;
                assertCurrent();
                if (boundary === "source-revoked") {
                  owner.revoke();
                  assertCurrent();
                }
                if (boundary !== "rejected") {
                  lifecycle.onQueueAccepted?.(true);
                }
                throw failure;
              },
            ),
          ),
        ).rejects.toThrow(boundary === "source-revoked" ? undefined : failure.message);
        if (boundary !== "rejected" && boundary !== "source-revoked") {
          // Confirmation failure must not release an input the receiver already accepted.
          await Promise.resolve();
          expect(assertQueue).not.toThrow();
          if (boundary === "receiver-ended") {
            clearTestEmbeddedRun(sessionId, handle);
          } else {
            settle?.();
          }
        }
        await vi.waitFor(() => expect(assertQueue).toThrow());
      } finally {
        settle?.();
        clearTestEmbeddedRun(sessionId, handle);
        owner.release();
      }
    }),
);

it.each(["released", "device revoked", "gateway replaced", "selected participant"] as const)(
  "retains requester selection until %s",
  async (boundary) =>
    inState(async () => {
      const delegated = boundary === "selected participant";
      const gateway = currentContext();
      const sessionKey = "agent:main:requester";
      const alice = await participant(
        gateway.context,
        "requester",
        sessionKey,
        delegated ? ["operator.write"] : undefined,
      );
      const bob = delegated
        ? await participant(gateway.context, "selected-bob", sessionKey, [
            "operator.read",
            "operator.write",
            "operator.approvals",
          ])
        : undefined;
      const selected = bob ?? alice;
      const origin = bob
        ? { ...bob.origin, delegatedCreatorProfileId: alice.source.authority.profileId }
        : alice.origin;
      const participants = bob
        ? createReplyTurnParticipants({
            operatorAuthority: alice.source.authority,
            requesterOrigin: alice.origin,
          })
        : undefined;
      if (bob) {
        participants!.accept({
          operatorAuthority: bob.source.authority,
          requesterOrigin: bob.origin,
        });
      }
      let receiptCurrent = true;
      let captured: Awaited<ReturnType<typeof retainRequester>> | undefined;
      try {
        const capture = () => {
          if (!bob) {
            return retainRequester();
          }
          return withGatewayPersonalToolUser(bob.source.authority.profileId, async () => {
            const selection = resolveGatewayToolOperatorSelection({ requireRequesterOrigin: true });
            expect(selection.requesterOrigin).toEqual(origin);
            expect(selection.operatorAuthority).toBe(bob.source.authority);
            return retainRequester();
          });
        };
        captured = await alice.run(
          {
            operationalRunInstance: createOperationalRunInstanceRef("ended-requester"),
            receiptAuthority: () => receiptCurrent,
            fullPermission: true,
            ...(bob
              ? { personalToolParticipants: participants }
              : { sessionEventToolsAllow: ["sessions_send"] }),
          },
          capture,
          delegated,
        );
        participants?.close();
        receiptCurrent = false;
        alice.disconnect();
        bob?.disconnect();
        expect(captured.run(() => getGatewayToolCallerIdentity())).toBeUndefined();
        if (bob) {
          expect(captured.scopes).toEqual(["operator.read", "operator.write"]);
          expect(captured.operatorAuthority?.scopes).toEqual(["operator.read", "operator.write"]);
          expect(captured.operatorAuthority?.profileId).toBe(bob.source.authority.profileId);
        }
        const retained = await captured.runWithRequester(async () => {
          const caller = getGatewayToolCallerIdentity();
          expect(caller?.agentId).toBe("main");
          expect(caller?.sessionKey).toBe(sessionKey);
          for (const key of [
            "operationalRunInstance",
            "receiptAuthority",
            "fullPermission",
            "sessionEventToolsAllow",
            "approvalAuthority",
            "personalToolParticipants",
          ] as const) {
            expect(caller?.[key]).toBeUndefined();
          }
          const selection = resolveGatewayToolOperatorSelection({ requireRequesterOrigin: true });
          expect(selection.requesterOrigin).toEqual(origin);
          expect(selection.operatorAuthority).toBe(captured?.operatorAuthority);
          selection.assertCurrent();
          if (bob) {
            expect(selection.requesterOrigin).not.toEqual(alice.origin);
            expect(selection.operatorAuthority?.scopes).toEqual([
              "operator.read",
              "operator.write",
            ]);
            const client = getPluginRuntimeGatewayRequestScope()?.client;
            expect(client?.internal?.operatorRunAuthority).toBe(captured?.operatorAuthority);
            expect(client?.connect.scopes).toEqual(["operator.read", "operator.write"]);
            await expect(
              withGatewayPersonalToolUser(alice.source.authority.profileId, async () =>
                resolveGatewayToolOperatorSelection({ requireRequesterOrigin: true }),
              ),
            ).rejects.toThrow("Selecting user requires an active personal-tool turn");
          }
          return selection;
        });
        if (boundary === "released") {
          captured.release();
        } else if (boundary === "gateway replaced") {
          gateway.replace();
        } else {
          selected.revoke();
        }
        expect(retained.assertCurrent).toThrow();
        const effect = vi.fn(async () => {});
        await expect((async () => captured?.runWithRequester(effect))()).rejects.toThrow();
        expect(effect).not.toHaveBeenCalled();
        expect(getGatewayToolCallerIdentity()).toBeUndefined();
      } finally {
        captured?.release();
        participants?.close();
        alice.release();
        bob?.release();
      }
    }),
);
