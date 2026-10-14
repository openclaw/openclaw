import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createRestartRecoveryOperatorSource } from "../agents/operator-run-recovery-source.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "../infra/device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../infra/device-pairing-store-readonly.js";
import { persistDevicePairingStoreState } from "../infra/device-pairing-store.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import type { GatewayAccessGrantRef } from "../plugins/gateway-access-policy.types.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { restoreGatewayOperatorRecovery } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";

export async function createOperatorRecoveryFixture(params: {
  stateDir: string;
  context: GatewayRequestContext;
  profileId: string;
  config: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  scopes?: string[];
  device?: PairedDevice;
  tokenlessDevice?: boolean;
  gatewayAccessGrant?: GatewayAccessGrantRef;
  sharedGeneration?: string;
}) {
  let config = params.config;
  const context = params.context;
  context.getRuntimeConfig = () => config;
  const client = createOperatorClient({
    profileId: params.profileId,
    scopes: params.scopes ?? ["operator.admin"],
  });
  client.connect.client.id = "openclaw-control-ui";
  client.connect.client.mode = "webchat";
  // These facts represent the authenticated handshake, not session attribution.
  client.internal = {
    authenticatedOperator: true,
    ...(client.connect.scopes?.includes("operator.admin") ? { controlUiAdmin: true } : {}),
  };
  client.authPolicy = captureGatewayAuthPolicy(config, {
    role: "operator",
    authMethod: params.tokenlessDevice ? "trusted-proxy" : "token",
  });
  if (params.sharedGeneration !== undefined) {
    client.usesSharedGatewayAuth = true;
    client.sharedGatewaySessionGeneration = params.sharedGeneration;
  }
  if (params.device) {
    persistDevicePairingStoreState(
      { pendingById: {}, pairedByDeviceId: { [params.device.deviceId]: params.device } },
      params.stateDir,
      "both",
    );
    client.connect.device = {
      id: params.device.deviceId,
      publicKey: params.device.publicKey,
      signature: "fixture-signature",
      signedAt: 1,
      nonce: "fixture-nonce",
    };
    client.internal.operatorDeviceTokenIdentity = params.tokenlessDevice
      ? null
      : expectDefined(
          resolveAuthenticatedDeviceTokenIdentity(
            await loadPairedDevicePairingStoreRecordReadOnly(params.device.deviceId),
            {
              role: "operator",
              publicKey: params.device.publicKey,
              token: expectDefined(params.device.tokens?.operator, "accepted operator token").token,
              scopes: client.connect.scopes ?? [],
            },
          ),
          "exact handshake token identity",
        );
  }
  const captured = expectDefined(
    await captureGatewayOperatorRunAuthority({
      client: expectDefined(captureAgentTurnPrincipal(client), "fresh typed operator principal"),
      context,
      sourceAuthority: params.gatewayAccessGrant
        ? { gatewayAccessGrant: params.gatewayAccessGrant, assertCurrent: () => {} }
        : null,
    }),
    "authenticated operator source",
  );
  const target = {
    agentId: "main",
    sessionKey: params.sessionKey ?? "agent:main:recovery-authority",
    sessionId: params.sessionId ?? "recovery-authority-session",
    storePath: path.join(params.stateDir, "agents", "main", "sessions", "sessions.json"),
    sourceRunId: "original-operator-turn",
    recoveryRunId: "recovered-operator-turn",
  };
  const entry: InternalSessionEntry = {
    sessionId: target.sessionId,
    updatedAt: 1,
    lifecycleRevision: "original-lifecycle",
    // Dashboard grouping is ancestry, not delegated execution.
    parentSessionKey: "agent:main:main",
    spawnDepth: 0,
    restartRecoveryDeliveryRunId: target.recoveryRunId,
    restartRecoveryDeliverySourceRunId: target.sourceRunId,
    restartRecoverySourceIngress: "control-ui",
    createdActor: { type: "human", source: "profile", id: params.profileId },
  };
  entry.restartRecoveryOperatorSource = expectDefined(
    createRestartRecoveryOperatorSource({
      authority: captured.authority,
      entry,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      sourceRunId: target.sourceRunId,
    }),
    "host-captured recovery source",
  );
  await replaceSessionEntry(target, entry);
  const sourceAuthority = captured.authority;
  captured.release();
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("Recovery claim retired");
    }
  };
  return {
    client,
    context,
    target,
    entry,
    sourceAuthority,
    setConfig: (next: OpenClawConfig) => {
      config = next;
    },
    retire: () => {
      current = false;
    },
    restore: () => restoreGatewayOperatorRecovery({ target, context, assertCurrent }),
  };
}
