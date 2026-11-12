import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as followupCustody from "../agents/tools/sessions-send-followup-custody.js";
import { createSessionsSendTool } from "../agents/tools/sessions-send-tool.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
  retainGatewayDeviceRevocation,
} from "./device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayClient } from "./server-methods/types.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  hasCurrentGatewayPolicyClientSource,
  onGatewayPolicyClientInvalidated,
  type GatewayPolicyClient,
} from "./server/ws-policy-close.js";
import { loadSessionEntry } from "./session-utils.js";
import { installGatewayTestHooks, prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";

// Followup custody for a paired backend adapter: device token, read/write, no profile and no
// role actor. The Gateway admits it without operator run authority, so custody holds its grant.
describe("followup custody under a device grant", () => {
  let harness: GatewayServerHarness;
  let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
  installGatewayTestHooks({
    scope: "suite",
    setup: async () => {
      const module = await import("./server-kernel.js");
      const create = module.createGatewayKernel;
      const capture = vi
        .spyOn(module, "createGatewayKernel")
        .mockImplementation(async (...args) => {
          kernel = await create(...args);
          return kernel;
        });
      try {
        harness = await startGatewayServerHarness();
      } finally {
        capture.mockRestore();
      }
    },
    cleanup: async () => {
      await harness?.close();
    },
  });

  it.for([
    "tool accepted",
    "accepted",
    "transport closed",
    "device revoked",
    "roles configured",
    "target archived",
    "requester reset",
  ] as const)(
    "keeps a profileless device operator's followup under its device grant: %s",
    async (outcome) => {
      await prepareGatewayReplyRuntimeForTest();
      const context = kernel.gatewayRequestContext;
      const cfg = context.getRuntimeConfig();
      const runId = randomUUID();
      const parentKey = `agent:main:dashboard:device-parent-${runId}`;
      const childKey = `agent:main:subagent:device-child-${runId}`;
      const deviceId = `device-${runId}`;
      const connection = new AbortController();
      const client: GatewayClient & GatewayPolicyClient = {
        socket: { close: () => connection.abort(new Error("socket closed")) },
        connId: `conn-${deviceId}`,
        isDeviceTokenAuth: true,
        connectionSignal: connection.signal,
        connect: {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          client: {
            id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
            version: "1",
            platform: "linux",
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
          device: {
            id: deviceId,
            publicKey: "key",
            signature: "signature",
            signedAt: 1,
            nonce: "n",
          },
        },
        internal: { authenticatedOperator: true },
      };
      for (const sessionKey of [parentKey, childKey]) {
        await sessionAccessor.upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey,
            updatedAt: Date.now(),
            createdVia: "operator",
            ...(sessionKey === childKey ? { spawnedBy: parentKey, spawnDepth: 1 } : {}),
          },
        );
      }
      // The request's native device guard, captured as authenticated dispatch does.
      const request = captureGatewayDeviceRevocation(
        context,
        { deviceId, role: "operator" },
        () => hasCurrentGatewayPolicyClientSource(client),
        connection.signal,
        {
          isCurrent: () => hasCurrentGatewayPolicyClientSource(client),
          subscribe: (onRevoked) => onGatewayPolicyClientInvalidated(client, onRevoked),
        },
      );
      expect(
        await captureGatewayOperatorRunAuthority({
          client,
          context,
          hasCurrentClientAuthority: request.isCurrent,
        }),
      ).toBeUndefined();
      // The admitted run keeps the device grant after its request completes.
      const releaseRun = expectDefined(
        retainGatewayDeviceRevocation(request.isCurrent),
        "run device grant",
      );
      request.release();
      const admission = prepareAgentRunAdmission({
        cfg,
        operationalRunInstance: createOperationalRunInstanceRef(`requester-${runId}`),
        facts: {
          runId: `requester-${runId}`,
          agentId: "main",
          ingress: { kind: "gateway-client", boundary: "agent", state: "present" },
        },
      });
      const admitted = await admission.admit("embedded");
      const asParentTool = <T>(run: () => Promise<T>) =>
        withPluginRuntimeGatewayRequestScope(
          {
            client,
            context,
            resolveGatewayContext: () => context,
            isWebchatConnect: () => false,
            hasCurrentClientAuthority: request.isCurrent,
          },
          () =>
            withGatewayToolCallerIdentity(
              createAdmittedGatewayToolCallerIdentity({
                admittedRunContext: admitted,
                agentId: "main",
                sessionKey: parentKey,
              }),
              run,
            ),
        );
      const prepare = () =>
        asParentTool(() =>
          followupCustody.prepareSessionsSendFollowup({
            runId,
            requesterAgentId: "main",
            requesterSessionKey: parentKey,
            targetAgentId: "main",
            targetSessionKey: childKey,
          }),
        );
      try {
        if (outcome === "tool accepted") {
          const result = await asParentTool(() =>
            createSessionsSendTool({
              agentSessionKey: parentKey,
              requesterTurnRunId: admission.operationalRunInstance.runId,
              config: cfg,
              idempotencyKey: runId,
            }).execute("device-followup", {
              sessionKey: childKey,
              mode: "followup",
              timeoutSeconds: 0,
              message: "Second turn from the device operator's agent.",
            }),
          );
          expect(result.details).toMatchObject({ status: "accepted", sessionKey: childKey });
          return;
        }
        if (outcome === "roles configured") {
          setRuntimeConfigSnapshot({
            ...cfg,
            gateway: {
              ...cfg.gateway,
              roles: {
                default: "write",
                definitions: {
                  write: {
                    sessions: { others: "write" },
                    agents: "*",
                    scopes: ["operator.read", "operator.write"],
                  },
                },
              },
            },
          });
          // An unidentified operator has no role under configured roles.
          await expect(prepare()).rejects.toThrow("revoked");
          return;
        }
        const followup = expectDefined(await prepare(), "followup custody");
        try {
          expect(() => followup.custody.assertCurrent()).not.toThrow();
          if (outcome === "transport closed") {
            connection.abort(new Error("socket closed"));
            expect(followup.custody.signal.aborted).toBe(false);
            expect(() => followup.custody.assertCurrent()).not.toThrow();
          } else if (outcome === "device revoked") {
            invalidateGatewayDeviceRevocation(context, deviceId, "operator");
            // Registry publication and settlement both assert this custody.
            expect(followup.custody.signal.aborted).toBe(true);
            expect(() => followup.custody.assertCurrent()).toThrow("revoked");
          } else if (outcome === "target archived" || outcome === "requester reset") {
            const key = outcome === "target archived" ? childKey : parentKey;
            const entry = expectDefined(loadSessionEntry(key, { agentId: "main" }).entry, key);
            await sessionAccessor.replaceSessionEntry(
              { agentId: "main", sessionKey: key },
              outcome === "target archived"
                ? { ...entry, archivedAt: Date.now() }
                : { ...entry, sessionId: `${key}-reset`, lifecycleRevision: randomUUID() },
            );
            expect(() => followup.custody.assertCurrent()).toThrow();
          }
        } finally {
          followup.custody.release();
        }
      } finally {
        setRuntimeConfigSnapshot(cfg);
        admission.close();
        releaseRun();
      }
    },
  );
});
