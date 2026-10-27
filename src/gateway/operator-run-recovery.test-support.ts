import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { GatewayClientInfo } from "../../packages/gateway-protocol/src/client-info.js";
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
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  captureOperatorToolGatewayContinuationContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-authority.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

export function recoveryFixture(
  stateDir: string,
  profileId: string,
  overrides: Partial<Parameters<typeof createOperatorRecoveryFixture>[0]> = {},
) {
  return createOperatorRecoveryFixture({
    stateDir,
    profileId,
    context: createContext(),
    config: {},
    ...overrides,
  });
}

export function pairedOperator(
  overrides: { deviceId?: string; token?: string } = {},
): PairedDevice {
  return {
    deviceId: overrides.deviceId ?? "recovery-device",
    publicKey: "fixture-public-key",
    roles: ["operator"],
    approvedScopes: ["operator.admin"],
    tokens: {
      operator: {
        token: overrides.token ?? "fixture-device-token",
        role: "operator",
        scopes: ["operator.admin"],
        createdAtMs: 1,
      },
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

export function persistDevices(stateDir: string, devices: PairedDevice[], mode: "paired" | "both") {
  persistDevicePairingStoreState(
    { pendingById: {}, pairedByDeviceId: Object.fromEntries(devices.map((d) => [d.deviceId, d])) },
    stateDir,
    mode,
  );
}

export async function createOperatorRecoveryFixture(params: {
  stateDir: string;
  context: GatewayRequestContext;
  profileId: string;
  config: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  storePath?: string;
  parentSessionKey?: string | null;
  scopes?: string[];
  device?: PairedDevice;
  tokenlessDevice?: boolean;
  gatewayAccessGrant?: GatewayAccessGrantRef;
  sharedGeneration?: string;
  clientInfo?: Pick<GatewayClientInfo, "id" | "mode">;
  localOperator?: boolean;
  sourceIngress?: "control-ui" | "internal";
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
    createdActor: { type: "human", source: "profile", id: params.profileId },
  };
  const snapshot = expectDefined(captured.authority.recoverySnapshot, "scheduled operator source");
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
    snapshot,
    setConfig: (next: OpenClawConfig) => {
      config = next;
    },
    retire: () => {
      current = false;
    },
    restore: () => restoreGatewayOperatorSource({ snapshot, target, context, assertCurrent }),
  };
}

export function compactRecoverySession(
  target: SessionTranscriptRuntimeTarget,
  assertActive: SessionSourceAssertion,
  sessionId: string,
) {
  const entry = expectDefined(loadSessionEntry(target), "compacting session");
  return acceptCompactionSuccessor({
    currentTarget: target,
    expectedEntry: { lifecycleRevision: undefined, activeWriterRunId: undefined, ...entry },
    assertActive,
    result: {
      ok: true,
      compacted: true,
      result: { sessionId, tokensBefore: 120, tokensAfter: 42 },
    },
  });
}

/** Use the actual accepted-child capture and writer-owned compaction boundary. */
export async function compactRecoveryChild(
  fixture: { context: GatewayRequestContext; target: SessionTranscriptRuntimeTarget },
  authority: AdmittedRunOperatorAuthority,
  beforeCompaction: () => void = () => {},
) {
  const source = { operatorRunAuthority: authority, scopes: ["operator.write"] };
  const client = createSyntheticPluginRuntimeClient({
    operatorRoleActor: { kind: "operator", profileId: authority.profileId },
    ...source,
  });
  const child = expectDefined(
    await withPluginRuntimeGatewayRequestScope(
      { client, context: fixture.context, isWebchatConnect: () => false },
      () =>
        withOperatorToolGatewayAuthority(
          source,
          async () => await captureOperatorToolGatewayContinuationContext(),
        ),
    ),
    "accepted child authority",
  );
  try {
    beforeCompaction();
    const target = {
      ...fixture.target,
      sessionKey: "agent:main:subagent:recovered-child",
      sessionId: "child-before-compaction",
    };
    await replaceSessionEntry(target, {
      sessionId: target.sessionId,
      lifecycleRevision: "child-lifecycle",
      updatedAt: 1,
    });
    const operatorAuthority = expectDefined(child.operatorAuthority, "child policy");
    const compacted = await compactRecoverySession(
      target,
      operatorAuthority.assertCurrent,
      "child-after-compaction",
    );
    target.sessionId = compacted.entry.sessionId;
    return { ...child, operatorAuthority, target };
  } catch (error) {
    child.release();
    throw error;
  }
}
