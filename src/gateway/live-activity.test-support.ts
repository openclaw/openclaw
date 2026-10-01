import { generateKeyPairSync } from "node:crypto";
import { expect, vi } from "vitest";
import {
  validatePushLiveActivityPrepareResult,
  validatePushLiveActivityRegistrationResult,
  type PushLiveActivityPrepareResult,
} from "../../packages/gateway-protocol/src/index.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitAgentEventForOwner,
  getAgentEventLifecycleGeneration,
  onAgentRuntimeEvent,
} from "../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { persistDevicePairingStoreState } from "../infra/device-pairing-store.js";
import type { PairedDevice } from "../infra/device-pairing.js";
import type { LiveActivityDestination } from "../infra/push-live-activity-store.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { createLiveActivityCoordinator } from "./live-activity-coordinator.js";
import { readLiveActivitySource } from "./live-activity-source.js";
import { liveActivityHandlers } from "./server-methods/push-live-activity.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

export const ACTIVITY_EPOCH = 1_800_000_000_000;
export const activityAuth = {
  teamId: "TEAM123",
  keyId: "KEY123",
  privateKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  }),
};
export const activityRelay = {
  transport: "relay",
  relayHandle: "activity-handle",
  sendGrant: "activity-grant",
  installationId: "activity-installation",
  relayOrigin: "https://ios-push-relay-sandbox.openclaw.ai",
  relayRevision: 1,
  topic: "ai.openclaw.ios",
  environment: "sandbox",
} satisfies LiveActivityDestination;
export const activityDirect: LiveActivityDestination = {
  transport: "direct",
  token: "a".repeat(64),
  topic: "ai.openclaw.ios",
  environment: "sandbox",
};

export function readActivityRequestBody(request: RequestInit | undefined): string {
  const body = request?.body;
  if (typeof body !== "string") {
    throw new Error("Activity request requires a string body");
  }
  return body;
}

type ActivityFixtureOptions = { publicRunId?: string; internalRunId?: string };

async function createFixture(stateDir: string, options: ActivityFixtureOptions) {
  const gatewayIdentity = loadOrCreateDeviceIdentity();
  const profile = ensureProfileForEmail("activity-owner@example.test");
  setUserProfileRole(profile.id, "writer");
  const cfg: OpenClawConfig = {
    gateway: {
      push: { apns: { relay: { baseUrl: activityRelay.relayOrigin } } },
      roles: {
        definitions: {
          writer: { scopes: ["operator.admin"], agents: "*", sessions: { others: "none" } },
          reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
        },
      },
    },
  };
  const device: PairedDevice = {
    deviceId: "activity-device",
    publicKey: "activity-public-key",
    role: "operator",
    roles: ["operator", "node"],
    tokens: {
      operator: {
        token: "activity-operator-token",
        role: "operator",
        scopes: ["operator.admin"],
        createdAtMs: 100,
      },
      node: { token: "activity-node-token", role: "node", scopes: [], createdAtMs: 100 },
    },
    nodeSurface: { createdAtMs: 200, approvedAtMs: 300 },
    createdAtMs: 100,
    approvedAtMs: 300,
  };
  const pair = () =>
    persistDevicePairingStoreState(
      { pendingById: {}, pairedByDeviceId: { [device.deviceId]: device } },
      stateDir,
      "paired",
    );
  pair();
  const session = { agentId: "main", sessionKey: "agent:main:activity" };
  const sessionId = "activity-session";
  const lifecycleRevision = "session-revision";
  await upsertSessionEntryCore(session, {
    sessionId,
    lifecycleRevision,
    updatedAt: ACTIVITY_EPOCH,
    createdActor: { type: "human", source: "profile", id: profile.id },
    visibility: "draft",
  });
  const publicRunId = options.publicRunId ?? "public-activity-run";
  const internalRunId = options.internalRunId ?? "internal-activity-producer";
  let admissionCurrent = true;
  const entry: ChatAbortControllerEntry = {
    controller: new AbortController(),
    ...session,
    sessionId,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    preparedSession: Object.freeze({ sessionId, lifecycleRevision }),
    liveActivityRun: Object.freeze({ publicRunId, internalRunId }),
    isAdmissionCurrent: () => admissionCurrent,
    startedAtMs: ACTIVITY_EPOCH,
    expiresAtMs: ACTIVITY_EPOCH + 8 * 3_600_000,
    kind: "chat-send",
  };
  const chatAbortControllers = new Map([[publicRunId, entry]]);
  const claimId = claimAgentRunContext(
    internalRunId,
    {
      ...session,
      sessionId,
      lifecycleGeneration: entry.lifecycleGeneration,
    },
    { exclusive: true, trackOwner: true },
  );
  if (!claimId) {
    throw new Error("Fixture requires a real producer claim");
  }
  const log = { warn: vi.fn() };
  const coordinator = createLiveActivityCoordinator({
    gatewayIdentity,
    chatAbortControllers,
    getRuntimeConfig: () => cfg,
    log,
  });
  const client: GatewayClient = {
    connId: "activity-connection",
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.admin"],
      client: { id: "cli", version: "test", platform: "ios", mode: "cli" },
      device: {
        id: device.deviceId,
        publicKey: "key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
    },
  };
  let connected = true;
  let connectedClient = client;
  const context = {
    liveActivityCoordinator: coordinator,
    chatAbortControllers,
    getRuntimeConfig: () => cfg,
    getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
      new Set(connected && (!filter || filter(connectedClient)) ? [connectedClient.connId] : []),
  } as unknown as GatewayRequestContext;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const handler = liveActivityHandlers[method];
    if (!handler) {
      throw new Error(`Missing activity method: ${method}`);
    }
    const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
    await handler({
      req: { type: "req", id: "activity-request", method },
      params,
      context,
      client,
      respond,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledOnce();
    return respond.mock.calls[0]!;
  };
  const prepare = async () => {
    const response = await rpc("push.liveActivity.prepare", {
      key: session.sessionKey,
      agentId: session.agentId,
      sessionId,
      publicRunId,
    });
    if (!response[0] || !validatePushLiveActivityPrepareResult(response[1])) {
      throw new Error("Fixture preparation failed");
    }
    return response[1];
  };
  const register = async (
    destination: LiveActivityDestination = activityRelay,
    expected?: PushLiveActivityPrepareResult,
    activityId = "activity-1",
  ) => {
    const prepared = expected ?? (await prepare());
    const response = await rpc("push.liveActivity.register", {
      activityId,
      expected: { binding: prepared.binding, sourceIncarnation: prepared.sourceIncarnation },
      destination,
    });
    if (!response[0] || !validatePushLiveActivityRegistrationResult(response[1])) {
      throw new Error("Fixture registration failed");
    }
    return response[1];
  };
  const selectors = {
    gatewayDeviceId: coordinator.gatewayId,
    deviceId: device.deviceId,
    profileId: profile.id,
    ...session,
    sessionId,
    runId: publicRunId,
  };
  const persisting = new Set<Promise<void>>();
  const unsubscribe = onAgentRuntimeEvent((event) => {
    if (event.runId !== internalRunId) {
      return;
    }
    coordinator.observeRuntimeEvent(event);
    if (event.stream === "lifecycle") {
      const persistence = persistGatewaySessionLifecycleEvent({
        ...session,
        event,
        liveActivitySource: readLiveActivitySource(event),
        onCommitted: coordinator.observe,
      });
      persisting.add(persistence);
      void persistence.then(
        () => persisting.delete(persistence),
        () => persisting.delete(persistence),
      );
    }
  });
  const emit = async (stream: string, data: Record<string, unknown>) => {
    emitAgentEventForOwner({ runId: internalRunId, stream, data }, claimId);
    await Promise.all(persisting);
  };
  return {
    coordinator,
    cfg,
    profile,
    device,
    pair,
    entry,
    session,
    selectors,
    client,
    chatAbortControllers,
    gatewayIdentity,
    log,
    rpc,
    prepare,
    register,
    emit,
    internalRunId,
    publicRunId,
    claimId,
    stopObserving: unsubscribe,
    disconnect: () => {
      connected = false;
    },
    replaceConnection: () => {
      connectedClient = { ...client };
    },
    closeAdmission: () => {
      admissionCurrent = false;
    },
    cleanup: async () => {
      unsubscribe();
      await Promise.allSettled(persisting);
      await coordinator.stop();
      releaseAgentRunContext(internalRunId, claimId);
    },
  };
}

export async function withLiveActivityFixture(
  operation: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  options: ActivityFixtureOptions = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(ACTIVITY_EPOCH);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ status: "sent" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
    try {
      fixture = await createFixture(state.stateDir, options);
      await operation(fixture);
    } finally {
      await fixture?.cleanup();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });
}
