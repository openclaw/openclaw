import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { GatewayClientInfo } from "../../packages/gateway-protocol/src/client-info.js";
import { createRestartRecoveryOperatorSource } from "../agents/operator-run-recovery-source.js";
import type { RequesterOrigin } from "../agents/requester-origin.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "../infra/device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../infra/device-pairing-store-readonly.js";
import { persistDevicePairingStoreState } from "../infra/device-pairing-store.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import type { GatewayAccessGrantRef } from "../plugins/gateway-access-policy.types.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { restoreGatewayRunRecovery } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";

export async function createOperatorRecoveryFixture(params: {
  stateDir: string;
  context: GatewayRequestContext;
  profileId: string;
  config: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  parentSessionKey?: string | null;
  scopes?: string[];
  device?: PairedDevice;
  tokenlessDevice?: boolean;
  gatewayAccessGrant?: GatewayAccessGrantRef;
  sharedGeneration?: string;
  clientInfo?: Pick<GatewayClientInfo, "id" | "mode">;
  localOperator?: boolean;
  sourceIngress?: "control-ui" | "internal";
  sourceRunId?: string;
  inputProvenance?: InputProvenance;
  requesterOrigin?: RequesterOrigin;
}) {
  let config = params.config;
  const context = params.context;
  context.getRuntimeConfig = () => config;
  const client = createOperatorClient({
    profileId: params.profileId,
    scopes: params.scopes ?? ["operator.admin"],
  });
  client.connect.client.id =
    params.clientInfo?.id ?? (params.sourceIngress === "internal" ? "cli" : "openclaw-control-ui");
  client.connect.client.mode =
    params.clientInfo?.mode ?? (params.sourceIngress === "internal" ? "cli" : "webchat");
  // These facts represent the authenticated handshake, not session attribution.
  client.internal = {
    authenticatedOperator: true,
    ...(params.localOperator ? { isLocalClient: true } : {}),
    ...(client.connect.client.id === "openclaw-control-ui" &&
    client.connect.scopes?.includes("operator.admin")
      ? { controlUiAdmin: true }
      : {}),
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
  const agentId = params.agentId ?? "main";
  const target = {
    agentId,
    sessionKey: params.sessionKey ?? `agent:${agentId}:recovery-authority`,
    sessionId: params.sessionId ?? "recovery-authority-session",
    storePath: path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json"),
    sourceRunId: params.sourceRunId ?? "original-operator-turn",
    recoveryRunId: "recovered-operator-turn",
  };
  const entry: InternalSessionEntry = {
    sessionId: target.sessionId,
    updatedAt: 1,
    lifecycleRevision: "original-lifecycle",
    // Dashboard grouping is ancestry, not delegated execution.
    parentSessionKey:
      params.parentSessionKey === null
        ? undefined
        : (params.parentSessionKey ?? `agent:${agentId}:main`),
    spawnDepth: 0,
    restartRecoveryDeliveryRunId: target.recoveryRunId,
    restartRecoveryDeliverySourceRunId: target.sourceRunId,
    restartRecoverySourceIngress: params.sourceIngress ?? "control-ui",
    createdActor: { type: "human", source: "profile", id: params.profileId },
  };
  entry.restartRecoveryOperatorSource = expectDefined(
    createRestartRecoveryOperatorSource({
      authority: captured.authority,
      entry,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      sourceRunId: target.sourceRunId,
      inputProvenance: params.inputProvenance,
      requesterOrigin: params.requesterOrigin,
    }),
    "host-captured recovery source",
  );
  entry.restartRecoverySourceIngress = entry.restartRecoveryOperatorSource.snapshot.sourceIngress;
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
    restore: async () =>
      (
        await restoreGatewayRunRecovery({
          target,
          context,
          assertCurrent,
          restoreOperator: true,
          restoreRequester: false,
        })
      ).operator,
  };
}
