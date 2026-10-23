import { describe, expect, it, vi } from "vitest";
import {
  clearTestEmbeddedRun,
  registerTestEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { captureRequesterOrigin } from "../agents/requester-origin.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { queueSessionsSendSteeringWithCustody } from "../agents/tools/sessions-send-tool.steering.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
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
