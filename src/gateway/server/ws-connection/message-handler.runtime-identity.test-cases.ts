import { expect, it, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { getOperatorApprovalRuntimeToken } from "../../operator-approval-runtime-token.js";
import { disconnectDisallowedGatewayPolicyClients } from "../ws-origin-policy.js";
import type { GatewayWsClient } from "../ws-types.js";
import {
  attachGatewayHarness,
  BACKEND_CONNECT_PARAMS,
  connectTrustedProxyUser,
  createGatewayHarnessGate,
  useGatewayTestConfig,
  createCloseMock,
  createTestAgentRuntimeIdentityLease,
  waitForFast,
} from "./message-handler.post-connect-health.test-support.js";

export const TEST_CONNECT_PARAMS = {
  ...BACKEND_CONNECT_PARAMS,
  client: { id: "test", version: "dev", platform: "test", mode: "test" },
};

export const REMOTE_BACKEND_OPTIONS = {
  requestHost: "gateway.example.com:18789",
  remoteAddr: "203.0.113.50",
  resolvedAuth: { mode: "token", token: "gateway-token", allowTailscale: false },
} as const;

export function registerRuntimeIdentityTokenTests() {
  it.each(["missing", "local", "remote"] as const)(
    "attests approval runtime authority for a %s token",
    async (kind) => {
      const harness = attachGatewayHarness({
        connId: "approval-runtime",
        connectNonce: "approval-runtime",
        ...(kind === "remote" ? REMOTE_BACKEND_OPTIONS : {}),
      });
      harness.sendConnect("connect", {
        ...BACKEND_CONNECT_PARAMS,
        scopes: ["operator.approvals"],
        auth: {
          ...(kind === "remote" ? { token: "gateway-token" } : {}),
          ...(kind === "missing"
            ? {}
            : { approvalRuntimeToken: getOperatorApprovalRuntimeToken() }),
        },
      });
      await waitForFast(() => expect(harness.socketSend).toHaveBeenCalled());
      // SAFETY: The successful hello installs the real handler's GatewayWsClient into this generic fixture holder.
      const client = harness.client as GatewayWsClient;
      if (kind === "missing") {
        expect(client.connect.scopes).toEqual(["operator.approvals"]);
      }
      if (kind === "local") {
        expect(client.internal?.approvalRuntime).toBe(true);
      } else {
        expect(client.internal?.approvalRuntime).not.toBe(true);
      }
    },
  );

  it.each([
    { kind: "local", error: undefined },
    {
      kind: "remote",
      error: "agent runtime identity token is only accepted from local backend gateway clients",
    },
    { kind: "invalid", error: "invalid agent runtime identity token" },
  ] as const)("attests agent runtime identity for a $kind token", async ({ kind, error }) => {
    const close = createCloseMock();
    const harness = attachGatewayHarness({
      connId: "agent-runtime",
      connectNonce: "agent-runtime",
      ...(kind === "remote" ? REMOTE_BACKEND_OPTIONS : {}),
      close,
    });
    const identityLease =
      kind === "invalid" ? undefined : await createTestAgentRuntimeIdentityLease();
    try {
      harness.sendConnect("connect", {
        ...BACKEND_CONNECT_PARAMS,
        scopes: ["operator.write"],
        auth: {
          ...(kind === "remote" ? { token: "gateway-token" } : {}),
          agentRuntimeIdentityToken: identityLease?.token ?? "not-a-valid-token",
        },
      });
      if (error) {
        await waitForFast(() => expect(close).toHaveBeenCalledWith(1008, error));
        expect(harness.client).toBeNull();
      } else {
        await waitForFast(() => expect(harness.socketSend).toHaveBeenCalled());
        // SAFETY: Only the admitted local-token case reaches this branch; the real handshake owns the client shape.
        expect((harness.client as GatewayWsClient).internal?.agentRuntimeIdentity).toMatchObject({
          agentId: "ops",
          sessionKey: "agent:ops:telegram:direct:alice",
        });
      }
    } finally {
      identityLease?.close();
    }
  });
}

export function registerHandshakePolicyTest({
  loadConfigMock,
  prepareGatewayNodeConnectMock,
}: {
  loadConfigMock: Mock<
    () => { gateway: { auth: { mode: string }; controlUi: { allowedOrigins: string[] } } }
  >;
  prepareGatewayNodeConnectMock: Mock;
}) {
  it("binds handshake policy to the verified login rather than unrelated identity grants", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const preparationStarted = createDeferred();
      const releasePreparation = createGatewayHarnessGate();
      prepareGatewayNodeConnectMock.mockImplementationOnce(async () => {
        preparationStarted.resolve();
        await releasePreparation.promise;
        return true;
      });
      const harness = connectTrustedProxyUser(
        loadConfigMock,
        "identity-policy",
        { id: "openclaw-control-ui" },
        ["operator.read"],
      );
      await preparationStarted.promise;
      const config = structuredClone(loadConfigMock());
      const next: OpenClawConfig = {
        ...config,
        gateway: {
          ...config.gateway,
          auth: { ...config.gateway.auth, mode: "trusted-proxy" },
        },
      };
      const scopes = next.gateway!.auth!.identityScopes!;
      scopes["other@example.test"] = ["operator.admin"];
      // SAFETY: next preserves the default mock's required gateway/auth/controlUi fields while adding typed identity scopes.
      useGatewayTestConfig(loadConfigMock, () => next as ReturnType<typeof loadConfigMock>);
      releasePreparation.resolve();
      await harness.whenAttached;
      // SAFETY: whenAttached completes the real handler's admitted-client publication into the generic fixture holder.
      const client = harness.client as GatewayWsClient;
      expect(client.authenticatedUserId).toBe("alice@example.com");
      expect(client.connect.scopes).toEqual(["operator.read"]);
      disconnectDisallowedGatewayPolicyClients([client], next);
      expect(client.invalidated).not.toBe(true);
      const removed = structuredClone(next);
      delete removed.gateway!.auth!.identityScopes!["alice@example.com"];
      disconnectDisallowedGatewayPolicyClients([client], removed);
      expect(client.invalidated).toBe(true);
    });
  });
}
