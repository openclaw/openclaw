/**
 * Gateway request context construction tests.
 */
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import * as userProfileCatalog from "../state/user-profile-list.js";
import { ensureProfileForEmail, linkEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureGatewayDeviceRevocation } from "./device-revocation.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import {
  makeContextParams,
  makeCronState,
  makeGatewayClient,
  type RequestRuntime,
} from "./server-request-context.test-support.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

vi.mock("./server/health-state.js", () => ({
  getHealthCache: vi.fn(() => null),
  getHealthVersion: vi.fn(() => 1),
  incrementPresenceVersion: vi.fn(() => 1),
}));

function makeDeviceClient(connId: string, deviceId: string, role = "primary") {
  return {
    connId,
    connect: { device: { id: deviceId }, role },
    socket: { close: vi.fn() },
  };
}

describe("createGatewayRequestContext", () => {
  it("prepares every recipient before the real merge's first notification and contains resolution failure", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const source = ensureProfileForEmail("event-source@example.test");
      const target = ensureProfileForEmail("event-target@example.test");
      const third = ensureProfileForEmail("event-third@example.test");
      const frames: Array<{ connId: string; event: string; recipientProfileId?: string }> = [];
      const clients = new GatewayClientRegistry();
      for (const [index, profile] of [source, target, third].entries()) {
        clients.add({
          ...makeGatewayClient({
            connId: `event-${index}`,
            clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
            scopes: ["operator.admin"],
          }),
          usesSharedGatewayAuth: false,
          presenceKey: `event-${index}`,
          authenticatedUserProfile: {
            profileId: profile.id,
            displayName: null,
            avatarRevision: "1",
            hasAvatar: false,
            updatedAt: profile.updatedAt,
          },
          socket: {
            readyState: 1,
            bufferedAmount: 0,
            close: vi.fn(),
            send: (wire: string, done?: () => void) => {
              frames.push({ connId: `event-${index}`, ...JSON.parse(wire) });
              done?.();
            },
          } as unknown as GatewayWsClient["socket"],
        });
      }
      const peers = [...clients];
      const broadcaster = createGatewayBroadcaster({
        clients,
        preparePresenceProjection: (presence) => () => presence,
      });
      const params = makeContextParams({ clients, ...broadcaster });
      const context = createGatewayRequestContext(params);
      for (const peer of peers) {
        prepareGatewayRecipientProfile(peer);
      }
      const subscribers = createSessionEventSubscriberRegistry();
      for (const peer of peers) {
        subscribers.subscribe(peer.connId);
      }
      const chatRunState = createChatRunState();
      const subscriptions = startGatewayEventSubscriptions({
        scheduler: createTestGatewayScheduler(),
        ...broadcaster,
        signal: new AbortController().signal,
        log: params.log,
        nodeHasSessionSubscribers: () => false,
        nodeSendToSession: vi.fn(),
        agentRunSeq: new Map(),
        chatRunState,
        toolEventRecipients: chatRunState.toolEventRecipients,
        sessionEventSubscribers: subscribers,
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
        chatAbortControllers: new Map(),
        restartRecoveryCandidates: new Map(),
        refreshConnectedUserProfiles: () => context.refreshConnectedUserProfile?.(),
      });
      try {
        linkEmail("event-source@example.test", target.id);
        for (const [index, profileId] of [target.id, target.id, third.id].entries()) {
          const first = frames.find((frame) => frame.connId === `event-${index}`);
          expect(first).toMatchObject({ recipientProfileId: profileId });
          expect(
            frames
              .filter((frame) => frame.connId === `event-${index}`)
              .every((frame) => frame.recipientProfileId === profileId),
          ).toBe(true);
        }
        expect(frames.some((frame) => frame.event === "sessions.changed")).toBe(true);
        const authenticated = peers.map((peer) => peer.authenticatedUserProfile);
        const resolve = vi
          .spyOn(userProfileCatalog, "readUserProfileIdentity")
          .mockImplementationOnce(() => {
            throw new Error("fixture storage unavailable");
          });
        try {
          context.refreshConnectedUserProfile?.();
          expect(peers[0]!.preparedRecipientProfileId).toBeUndefined();
          expect(peers[1]!.preparedRecipientProfileId).toBe(target.id);
          expect(peers[2]!.preparedRecipientProfileId).toBe(third.id);
          peers.forEach((peer, index) => {
            expect(peer.authenticatedUserProfile).toBe(authenticated[index]);
            expect(peer.invalidated).not.toBe(true);
          });
        } finally {
          resolve.mockRestore();
        }
      } finally {
        subscriptions.lifecycleUnsub();
        subscriptions.heartbeatUnsub();
        subscriptions.transcriptUnsub();
        await subscriptions.agentUnsub();
      }
    });
  });

  it("reuses the canonical connection liveness predicate", () => {
    const isConnectionActive = vi.fn(() => true);
    const params = makeContextParams();
    Object.assign(params.runtime, { isConnectionActive });

    const context = createGatewayRequestContext(params);

    expect(context.isConnectionActive).toBe(isConnectionActive);
  });

  it("cleans connection-scoped replace-sets with the other session subscriptions", () => {
    const order: string[] = [];
    const unsubscribeAllSessionEvents = vi.fn(() => order.push("session-events"));
    const unsubscribeMessages = vi.fn(() => order.push("messages"));
    const removeObserver = vi.fn(() => order.push("observer"));
    const unsubscribePullRequests = vi.fn(() => order.push("pull-requests"));
    const unsubscribeViewerPresence = vi.fn(() => order.push("presence"));
    const params = makeContextParams();
    params.runtime.sessionEventSubscribers.unsubscribe = unsubscribeAllSessionEvents;
    params.runtime.sessionMessageSubscribers.unsubscribeAll = unsubscribeMessages;
    params.runtime.sessionObserver.removeConnection = removeObserver;
    params.runtime.runtimeState.controlUiSessionPullRequests = {
      unsubscribe: unsubscribePullRequests,
    } as never;
    params.runtime.runtimeState.sessionViewerPresence = {
      unsubscribe: unsubscribeViewerPresence,
    } as never;
    const context = createGatewayRequestContext(params);

    context.unsubscribeAllSessionEvents("conn-control-ui");

    expect(unsubscribeAllSessionEvents).toHaveBeenCalledWith("conn-control-ui");
    expect(unsubscribeMessages).toHaveBeenCalledWith("conn-control-ui");
    expect(removeObserver).toHaveBeenCalledWith("conn-control-ui");
    expect(unsubscribePullRequests).toHaveBeenCalledWith("conn-control-ui");
    expect(unsubscribeViewerPresence).toHaveBeenCalledWith("conn-control-ui");
    expect(order).toEqual(["session-events", "messages", "observer", "pull-requests", "presence"]);
  });

  it("reads the portal service after its transport becomes available", () => {
    let portalService: GatewayRequestContext["portalService"];
    const params = makeContextParams();
    params.runtime.transportBridge.getPortalService = () => portalService;
    const context = createGatewayRequestContext(params);

    expect(context.portalService).toBeUndefined();
    portalService = {
      open: vi.fn(async () => {
        throw new Error("unused");
      }),
      list: vi.fn(() => []),
      listWorkerPortals: vi.fn(() => []),
      close: vi.fn(async () => {}),
      closeWorkerPortals: vi.fn(async () => {}),
      closeAll: vi.fn(async () => {}),
    };
    expect(context.portalService).toBe(portalService);
    portalService = undefined;
    expect(context.portalService).toBeUndefined();
  });

  it("reads cron state live from runtime state", () => {
    const cronA = { start: vi.fn(), stop: vi.fn() } as never;
    const cronB = { start: vi.fn(), stop: vi.fn() } as never;
    const runtimeState: RequestRuntime["runtimeState"] = {
      cronState: makeCronState({ cron: cronA, storePath: "/tmp/cron-a" }),
      configReloader: { isConfigReloadSettled: () => true },
    };

    const context = createGatewayRequestContext(makeContextParams({ runtimeState }));

    expect(context.cron).toBe(cronA);
    expect(context.cronStorePath).toBe("/tmp/cron-a");

    runtimeState.cronState = makeCronState({ cron: cronB, storePath: "/tmp/cron-b" });

    expect(context.cron).toBe(cronB);
    expect(context.cronStorePath).toBe("/tmp/cron-b");
  });

  it("reads config reload status and readiness through the live kernel bridge", () => {
    let status: "active" | "disabled" | undefined;
    let settled = true;
    const params = makeContextParams();
    params.runtime.kernel.getConfigReloaderHotReloadStatus = () => status;
    params.runtime.runtimeState.configReloader.isConfigReloadSettled = () => settled;
    const context = createGatewayRequestContext(params);

    expect(context.getConfigReloaderHotReloadStatus?.()).toBeUndefined();
    expect(context.getDeferredChannelReloads?.()).toEqual([]);

    status = "active";
    expect(context.getConfigReloaderHotReloadStatus?.()).toBe("active");
    expect(context.isConfigReloadSettled()).toBe(true);
    settled = false;
    expect(context.isConfigReloadSettled()).toBe(false);

    status = "disabled";
    expect(context.getConfigReloaderHotReloadStatus?.()).toBe("disabled");

    const deferred = [{ channel: "discord", publicationPending: true }];
    params.runtime.runtimeState.configReloader = {
      isConfigReloadSettled: () => false,
      getDeferredChannelReloads: () => deferred,
    };
    expect(context.getDeferredChannelReloads?.()).toEqual(deferred);

    params.runtime.lifecycle.closePreludeStarted = true;
    expect(context.getDeferredChannelReloads?.()).toEqual([]);
  });

  it("publishes worker services through the kernel bridge", () => {
    const workerPlacementDiskSpaceReader = { read: vi.fn(), version: vi.fn(() => 1) };
    const repositoryWorkspaceMutationService = { mutate: vi.fn() };
    const context = createGatewayRequestContext(
      makeContextParams({
        workerPlacementRuntime: {
          diskSpace: workerPlacementDiskSpaceReader,
          runnerAvailability: undefined,
          repositoryWorkspaceMutationService,
        },
      }),
    );

    expect(context.workerPlacementDiskSpaceReader).toBe(workerPlacementDiskSpaceReader);
    expect(context.workerRepositoryWorkspaceMutationService).toBe(
      repositoryWorkspaceMutationService,
    );
  });

  it("does not treat scoped CLI or backend callers as approval delivery routes", () => {
    const clients = new Set([
      makeGatewayClient({
        connId: "cli",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.admin"],
      }),
      makeGatewayClient({
        connId: "backend",
        clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: ["operator.approvals"],
      }),
    ]) as never;
    const context = createGatewayRequestContext(makeContextParams({ clients }));

    expect(context.hasExecApprovalClients?.()).toBe(false);
    expect(context.getApprovalClientConnIds?.()).toEqual(new Set());
    expect(context.getApprovalClientConnIds?.({ approvalKind: "plugin" })).toEqual(new Set());
  });

  it("preserves only clients that handle each approval kind", () => {
    const clients = new Set([
      makeGatewayClient({
        connId: "control-ui",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        scopes: ["operator.approvals"],
      }),
      makeGatewayClient({
        connId: "ios",
        clientId: GATEWAY_CLIENT_IDS.IOS_APP,
        mode: GATEWAY_CLIENT_MODES.UI,
        scopes: ["operator.admin"],
      }),
      makeGatewayClient({
        connId: "bridge",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
      }),
      makeGatewayClient({
        connId: "acp",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
      }),
      makeGatewayClient({
        connId: "tui",
        clientId: GATEWAY_CLIENT_IDS.TUI,
        scopes: ["operator.approvals"],
      }),
      makeGatewayClient({
        connId: "plugin-bridge",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.approvals"],
        caps: [GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS],
      }),
      makeGatewayClient({
        connId: "runtime",
        clientId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
        scopes: ["operator.approvals"],
        approvalRuntime: true,
      }),
      makeGatewayClient({
        connId: "invalidated-ui",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        scopes: ["operator.approvals"],
        invalidated: true,
      }),
      makeGatewayClient({
        connId: "unscoped-ui",
        clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
      }),
    ]) as never;
    const context = createGatewayRequestContext(makeContextParams({ clients }));

    expect(context.hasExecApprovalClients?.()).toBe(true);
    expect(context.getApprovalClientConnIds?.()).toEqual(
      new Set(["control-ui", "ios", "bridge", "acp", "runtime"]),
    );
    expect(context.getApprovalClientConnIds?.({ approvalKind: "plugin" })).toEqual(
      new Set(["control-ui", "bridge", "tui", "plugin-bridge", "runtime"]),
    );
    expect(context.getApprovalClientConnIds?.({ approvalKind: "system-agent" })).toEqual(
      new Set(["control-ui", "bridge", "runtime"]),
    );
    expect(context.hasExecApprovalClients?.("control-ui")).toBe(true);
    expect(
      context.getApprovalClientConnIds?.({
        excludeConnId: "control-ui",
        filter: (client) => client.connect.client.id === GATEWAY_CLIENT_IDS.IOS_APP,
      }),
    ).toEqual(new Set(["ios"]));
  });

  it("invalidateClientsForDevice sets the flag on matching clients without closing the socket", () => {
    const target = makeDeviceClient("conn-target", "device-1");
    const unrelated = makeDeviceClient("conn-unrelated", "device-2");
    const clients = new Set([target, unrelated]) as never;
    const invalidateDeviceTransports = vi.fn();
    const invalidateConnectionForPairingChange = vi.fn();

    const context = createGatewayRequestContext(
      makeContextParams({
        clients,
        watchNodeHttpRuntime: {
          invalidateSessionsForDevice: invalidateDeviceTransports,
          disconnectSessionsForDevice: vi.fn(),
        },
        nodeRegistry: { invalidateConnectionForPairingChange } as never,
      }),
    );
    const detached = captureGatewayDeviceRevocation(context, { deviceId: "device-1" }, () => true);
    onTestFinished(detached.release);
    expect(detached.isCurrent()).toBe(true);
    context.invalidateClientsForDevice?.("device-1", { reason: "device-token-rotated" });
    expect(detached.isCurrent()).toBe(false);

    expect((target as { invalidated?: boolean }).invalidated).toBe(true);
    expect((target as { invalidatedReason?: string }).invalidatedReason).toBe(
      "device-token-rotated",
    );
    expect(target.socket.close).not.toHaveBeenCalled();
    expect(invalidateConnectionForPairingChange).toHaveBeenCalledWith(
      "conn-target",
      "device-token-rotated",
    );

    expect((unrelated as { invalidated?: boolean }).invalidated).toBeUndefined();
    expect(unrelated.socket.close).not.toHaveBeenCalled();
    expect(invalidateDeviceTransports).toHaveBeenCalledWith("device-1", {
      reason: "device-token-rotated",
    });
  });

  it("disconnectClientsForDevice also marks the invalidated flag before closing", () => {
    const target = makeDeviceClient("conn-target", "device-1");
    const clients = new Set([target]) as never;
    const disconnectDeviceTransports = vi.fn();

    const context = createGatewayRequestContext(
      makeContextParams({
        clients,
        watchNodeHttpRuntime: {
          invalidateSessionsForDevice: vi.fn(),
          disconnectSessionsForDevice: disconnectDeviceTransports,
        },
      }),
    );
    const detached = captureGatewayDeviceRevocation(context, { deviceId: "device-1" }, () => true);
    onTestFinished(detached.release);
    expect(detached.isCurrent()).toBe(true);
    context.disconnectClientsForDevice?.("device-1");
    expect(detached.isCurrent()).toBe(false);

    expect((target as { invalidated?: boolean }).invalidated).toBe(true);
    expect((target as { invalidatedReason?: string }).invalidatedReason).toBe("device-removed");
    expect(target.socket.close).toHaveBeenCalledWith(4001, "device removed");
    expect(disconnectDeviceTransports).toHaveBeenCalledWith("device-1", undefined);
  });

  it.each(["live", "disconnected"])(
    "disconnects only authority for the reassigned durable profile (%s transport)",
    (transport) => {
      const target = {
        ...makeGatewayClient({
          connId: "profile-target",
          clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
          scopes: ["operator.admin"],
        }),
        authenticatedUserProfile: {
          profileId: "profile-ada",
          displayName: "Ada",
          hasAvatar: false,
          updatedAt: 1,
        },
      };
      const unrelated = {
        ...makeGatewayClient({
          connId: "profile-unrelated",
          clientId: GATEWAY_CLIENT_IDS.CONTROL_UI,
        }),
        authenticatedUserProfile: {
          profileId: "profile-grace",
          displayName: "Grace",
          hasAvatar: false,
          updatedAt: 1,
        },
      };
      const unidentified = makeGatewayClient({
        connId: "shared-secret",
        clientId: GATEWAY_CLIENT_IDS.CLI,
        scopes: ["operator.admin"],
      });
      const clients = new GatewayClientRegistry([target, unrelated, unidentified] as never);
      const releases = Array.from(clients, (peer) => clients.retainRequest(peer));
      onTestFinished(() => {
        releases.forEach((release) => release());
        expect([...clients.authorityClients]).toEqual([...clients]);
      });
      if (transport === "disconnected") {
        clients.clear();
      }
      const context = createGatewayRequestContext(makeContextParams({ clients }));
      target.socket.close.mockImplementation(() => {
        expect((target as { invalidated?: boolean }).invalidated).toBe(true);
      });

      if (transport === "disconnected") {
        expect(context.getClientConnIds?.()).toEqual(new Set());
        expect(context.hasExecApprovalClients?.()).toBe(false);
      }
      context.disconnectClientsForUserProfile?.("profile-ada");

      expect((target as { invalidated?: boolean }).invalidated).toBe(true);
      expect((target as { invalidatedReason?: string }).invalidatedReason).toBe(
        "operator-role-changed",
      );
      expect(target.socket.close).toHaveBeenCalledWith(4001, "operator role changed");
      expect(unrelated.socket.close).not.toHaveBeenCalled();
      expect(unidentified.socket.close).not.toHaveBeenCalled();
    },
  );

  it("invalidateClientsForDevice filters by role when provided", () => {
    const primary = makeDeviceClient("conn-primary", "device-1");
    const secondary = makeDeviceClient("conn-secondary", "device-1", "secondary");
    const clients = new Set([primary, secondary]) as never;

    const context = createGatewayRequestContext(makeContextParams({ clients }));
    context.invalidateClientsForDevice?.("device-1", { role: "primary" });

    expect((primary as { invalidated?: boolean }).invalidated).toBe(true);
    expect((secondary as { invalidated?: boolean }).invalidated).toBeUndefined();
  });
});
