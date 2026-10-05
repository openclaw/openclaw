// WebSocket message-handler health tests cover post-connect startup-unavailable and health-gated dispatch.
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes, PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { resetDiagnosticEventsForTest } from "../../../infra/diagnostic-events.js";
import { tryBeginGatewaySuspendAdmission } from "../../../process/gateway-work-admission.js";
import {
  linkEmail,
  setAvatar,
  setDisplayName,
  syncGitHubIdentity,
} from "../../../state/user-profile-writes.worker.js";
import {
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
} from "../../../state/user-profiles.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../../auth.js";
import { gitHubPublicApi } from "../../github-public-api.js";
import type { HealthSummary } from "../../health/types.js";
import {
  HEALTH_REFRESH_INTERVAL_MS,
  MAX_PREAUTH_PAYLOAD_BYTES,
  MAX_QUEUED_GATEWAY_PREAUTH_FRAMES,
} from "../../server-constants.js";
import { handleGatewayRequest } from "../../server-methods.js";
import { resolveGatewayCronCreatorAuthorityAdmission } from "../../server-methods/cron-creator-authority-admission.js";
import { healthHandlers } from "../../server-methods/health.js";
import type { GatewayRequestContext } from "../../server-methods/types.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  SharedGatewaySessionGenerationState,
} from "../../server-shared-auth-generation.js";
import { createGatewayWsTestLogger as createLogger } from "../ws-connection.test-helpers.js";
import { resolveSharedGatewaySessionGeneration } from "../ws-shared-generation.js";
import type { GatewayWsClient } from "../ws-types.js";
import { expectAuthenticatedOwnerReconnect } from "./message-handler.owner-reconnect.test-support.js";
import {
  attachGatewayHarness,
  BACKEND_CONNECT_PARAMS,
  cleanupGatewayHarnesses,
  connectTrustedProxyUser,
  createGatewayHarnessGate,
  captureSecurityEvents,
  createCloseMock,
  createConnectedTestClient,
  createHealthSummary,
  createSetCloseCauseMock,
  DEVICE_TOKEN_MUTATION_PARAMS,
  localUserIngressFor,
  useGatewayTestConfig,
  waitForFast,
  withGatewayTestState,
  type CloseGatewayConnection,
} from "./message-handler.post-connect-health.test-support.js";
import {
  registerHandshakePolicyTest,
  registerRuntimeIdentityTokenTests,
  TEST_CONNECT_PARAMS,
  REMOTE_BACKEND_OPTIONS,
} from "./message-handler.runtime-identity.test-cases.js";

const {
  buildGatewaySnapshotMock,
  getHealthCacheMock,
  getHealthVersionMock,
  loadConfigMock,
  createAuthenticatedGitHubIdentitySyncMock,
  adoptTailscaleProfileAvatarMock,
  ensureProfileForEmailMock,
  ensureGatewayOwnerProfileMock,
  prepareGatewayNodeConnectMock,
  prewarmGatewaySessionHistoryMock,
  resolveConnectAuthStateMock,
  upsertPresenceMock,
} = vi.hoisted(() => ({
  buildGatewaySnapshotMock: vi.fn(() => ({
    presence: [],
    health: {},
    stateVersion: { presence: 1, health: 1 },
    uptimeMs: 1,
    sessionDefaults: {
      defaultAgentId: "main",
      mainKey: "main",
      mainSessionKey: "main",
      scope: "per-sender",
    },
  })),
  getHealthCacheMock: vi.fn(() => null),
  getHealthVersionMock: vi.fn(() => 1),
  loadConfigMock: vi.fn(() => ({
    gateway: {
      auth: { mode: "none" },
      controlUi: {
        allowedOrigins: ["http://127.0.0.1:19001"],
      },
    },
  })),
  createAuthenticatedGitHubIdentitySyncMock: vi.fn(),
  adoptTailscaleProfileAvatarMock: vi.fn(),
  ensureProfileForEmailMock: vi.fn(),
  ensureGatewayOwnerProfileMock: vi.fn(),
  prepareGatewayNodeConnectMock: vi.fn(),
  prewarmGatewaySessionHistoryMock: vi.fn(async () => {}),
  resolveConnectAuthStateMock: vi.fn(),
  upsertPresenceMock: vi.fn(),
}));

vi.mock("../../../state/user-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../state/user-profiles.js")>();
  adoptTailscaleProfileAvatarMock.mockImplementation(actual.adoptTailscaleProfileAvatar);
  return {
    ...actual,
    adoptTailscaleProfileAvatar: adoptTailscaleProfileAvatarMock,
  };
});

vi.mock("../../../state/user-profile-writes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../state/user-profile-writes.js")>();
  ensureProfileForEmailMock.mockImplementation(actual.ensureCanonicalUserProfileForEmail);
  ensureGatewayOwnerProfileMock.mockImplementation(actual.ensureCanonicalGatewayOwnerProfile);
  return {
    ...actual,
    ensureCanonicalUserProfileForEmail: ensureProfileForEmailMock,
    ensureCanonicalGatewayOwnerProfile: ensureGatewayOwnerProfileMock,
  };
});

vi.mock("../../../infra/host-account-name.js", () => ({
  resolveHostAccountName: vi.fn(async () => "Gateway Person"),
}));

vi.mock("../../github-user-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../github-user-identity.js")>()),
  createAuthenticatedGitHubIdentitySync: createAuthenticatedGitHubIdentitySyncMock,
}));

vi.mock("./auth-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth-context.js")>();
  resolveConnectAuthStateMock.mockImplementation(actual.resolveConnectAuthState);
  return { ...actual, resolveConnectAuthState: resolveConnectAuthStateMock };
});

vi.mock("./connect-node-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./connect-node-session.js")>();
  prepareGatewayNodeConnectMock.mockImplementation(actual.prepareGatewayNodeConnect);
  return { ...actual, prepareGatewayNodeConnect: prepareGatewayNodeConnectMock };
});

vi.mock("../../server-history-prewarm.js", () => ({
  prewarmGatewaySessionHistory: prewarmGatewaySessionHistoryMock,
}));

vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
}));

vi.mock("../../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));
vi.mock("../../../infra/system-presence.js", () => ({
  commitPresence: vi.fn(),
  upsertPresence: upsertPresenceMock,
  listSystemPresence: vi.fn(() => []),
}));

vi.mock("../../server-methods.js", () => ({
  handleGatewayRequest: vi.fn(),
}));

vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: buildGatewaySnapshotMock,
  getHealthCache: getHealthCacheMock,
  getHealthVersion: getHealthVersionMock,
}));

beforeEach(() => {
  loadConfigMock.mockReset();
});

describe("attachGatewayWsMessageHandler post-connect health refresh", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    vi.clearAllMocks();
    createAuthenticatedGitHubIdentitySyncMock.mockImplementation(
      (params: {
        authResult: { method?: string; tailscaleIdentity?: { login: string } };
        authConfig?: { trustedProxy?: { userHeader?: string; requiredHeaders?: string[] } };
      }) => {
        const tailscaleGitHub = params.authResult.tailscaleIdentity?.login.endsWith("@github");
        const trustedProxy = params.authConfig?.trustedProxy;
        const cloudflareAccess =
          params.authResult.method === "trusted-proxy" &&
          trustedProxy?.userHeader?.toLowerCase() === "cf-access-authenticated-user-email" &&
          trustedProxy.requiredHeaders?.some(
            (header) => header.toLowerCase() === "cf-access-jwt-assertion",
          );
        if (!tailscaleGitHub && !cloudflareAccess) {
          return undefined;
        }
        return vi.fn(async () => {
          const profile = params.authResult.tailscaleIdentity
            ? ensureProfileForTailscaleIdentity(params.authResult.tailscaleIdentity)
            : await ensureProfileForEmailMock("authenticated@example.test");
          return { profileId: profile.id, updatedAt: profile.updatedAt };
        });
      },
    );
  });

  it("prewarms cold session history for an admitted operator without delaying hello", async () => {
    const prewarm = createGatewayHarnessGate();
    const prewarmStarted = createGatewayHarnessGate();
    const helloSent = createGatewayHarnessGate();
    prewarmGatewaySessionHistoryMock.mockImplementationOnce(() => {
      prewarmStarted.resolve();
      return prewarm.promise;
    });
    const harness = connectTrustedProxyUser(loadConfigMock, "history-prewarm");
    harness.socketSend.mockImplementation((_payload, callback) => {
      callback?.();
      helloSent.resolve();
    });
    try {
      await harness.whenAttached;
      await Promise.all([prewarmStarted.promise, helloSent.promise]);
      expect(prewarmGatewaySessionHistoryMock).toHaveBeenCalledWith(
        loadConfigMock(),
        expect.objectContaining({ onlyIfCold: true }),
      );
      expect(JSON.parse(harness.socketSend.mock.calls[0]![0])).toMatchObject({
        ok: true,
        payload: { type: "hello-ok" },
      });
    } finally {
      prewarm.resolve();
    }
  });

  it("keeps one editable owner profile across shared-secret and device-token reconnects", async () => {
    await withGatewayTestState({ label: "gateway-owner-reconnect" }, async () => {
      let profileId: string | undefined;
      for (const authMethod of ["token", "password", "device-token", "none"] as const) {
        resolveConnectAuthStateMock.mockResolvedValueOnce({
          authResult: { ok: true, method: authMethod },
          authOk: true,
          authMethod,
          sharedAuthOk: true,
        });
        const harness = attachGatewayHarness({
          connId: `owner-${authMethod}`,
          connectNonce: `nonce-${authMethod}`,
        });
        harness.sendConnect(`connect-${authMethod}`, {
          ...TEST_CONNECT_PARAMS,
          scopes: ["operator.read"],
          caps: [],
        });
        await harness.whenAttached;
        const resolvedProfileId = expectAuthenticatedOwnerReconnect(harness.client, {
          authMethod,
          previousProfileId: profileId,
          registeredProfileId: harness.registeredProfileId,
        });
        if (!profileId) {
          setDisplayName(resolvedProfileId, "Saved Owner");
        }
        profileId = resolvedProfileId;
        expect(upsertPresenceMock).toHaveBeenCalledWith(
          `owner-${authMethod}`,
          expect.objectContaining({
            user: expect.objectContaining({
              id: profileId,
              identity: { type: "profile", id: profileId },
            }),
          }),
          { pending: true },
        );
      }
    });
  });

  it.each(["password", "none"] as const)(
    "limits owner attribution to shared-secret %s access when roles are configured",
    async (authMethod) => {
      await withGatewayTestState({ label: "gateway-owner-role-gate" }, async () => {
        useGatewayTestConfig(loadConfigMock, () => ({
          gateway: {
            auth: { mode: "none" },
            roles: {
              default: "reader",
              definitions: {
                reader: {
                  sessions: { others: "view" as const },
                  agents: "*" as const,
                  scopes: ["operator.read" as const],
                },
              },
            },
            controlUi: { allowedOrigins: ["http://127.0.0.1:19001"] },
          },
        }));
        resolveConnectAuthStateMock.mockResolvedValueOnce({
          authResult: { ok: true, method: authMethod },
          authOk: true,
          authMethod,
          sharedAuthOk: true,
        });
        const harness = attachGatewayHarness({
          connId: `roles-${authMethod}`,
          connectNonce: `roles-${authMethod}`,
        });
        harness.sendConnect("connect", {
          ...TEST_CONNECT_PARAMS,
          auth: { token: "owner-fixture" },
          scopes: ["operator.read", "operator.admin"],
          caps: [],
        });
        const owner = authMethod === "password";
        if (!owner) {
          await waitForFast(() =>
            expect(harness.send).toHaveBeenCalledWith(
              expect.objectContaining({
                ok: false,
                error: expect.objectContaining({
                  details: expect.objectContaining({
                    code: ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED,
                  }),
                }),
              }),
            ),
          );
          expect(harness.client).toBeNull();
          expect(ensureGatewayOwnerProfileMock).not.toHaveBeenCalled();
          return;
        }
        await harness.whenAttached;
        const client = harness.client as {
          authenticatedUserId?: string;
          authenticatedUserProfile?: unknown;
          connect: { scopes: string[] };
          internal?: { operatorRoleActor?: unknown };
        };
        expect(client.authenticatedUserId).toBeUndefined();
        expect(Boolean(client.authenticatedUserProfile)).toBe(owner);
        expect(client.connect.scopes).toEqual([]);
        expect(client.internal?.operatorRoleActor).toEqual(owner ? { kind: "system" } : undefined);
      });
    },
  );

  it.each(["probe"])("keeps ephemeral %s connections unidentified", async (mode) => {
    await withOpenClawTestState({ label: "gateway-owner-ephemeral" }, async () => {
      resolveConnectAuthStateMock.mockResolvedValueOnce({
        authResult: { ok: true, method: "token" },
        authOk: true,
        authMethod: "token",
        sharedAuthOk: true,
      });
      const harness = attachGatewayHarness({
        connId: `ephemeral-${mode}`,
        connectNonce: `nonce-${mode}`,
      });
      harness.sendConnect("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: { id: "gateway-client", version: "dev", platform: "test", mode },
        role: "operator",
        auth: { token: "owner-fixture" },
        caps: [],
      });
      await waitForFast(() => expect(harness.client).not.toBeNull());
      expect(harness.client).not.toHaveProperty("authenticatedUserProfile");
    });
  });

  it("retains the watchdog through registration and holds pipelined frames until hello completion", async () => {
    const close = createCloseMock();
    const clearHandshakeTimer = vi.fn();
    const harness = attachGatewayHarness({
      connId: "conn-registered-hello-pending",
      connectNonce: "nonce-registered-hello-pending",
      deferSocketSend: true,
      close,
      clearHandshakeTimer,
    });

    try {
      harness.sendConnect("connect-before-registered-burst", BACKEND_CONNECT_PARAMS);
      for (let index = 0; index < MAX_QUEUED_GATEWAY_PREAUTH_FRAMES - 1; index += 1) {
        harness.sendRequest(`registered-request-${index}`, "status.summary");
      }

      await waitForFast(() => {
        expect(harness.setClient).toHaveBeenCalledOnce();
        expect(harness.socketSend).toHaveBeenCalledOnce();
      });
      expect(clearHandshakeTimer).toHaveBeenCalledOnce();
      expect(harness.handoffAuthenticatedReceive).toHaveBeenCalledOnce();
      expect(harness.setClient.mock.invocationCallOrder[0]).toBeLessThan(
        clearHandshakeTimer.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(clearHandshakeTimer.mock.invocationCallOrder[0]).toBeLessThan(
        harness.handoffAuthenticatedReceive.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(handleGatewayRequest).not.toHaveBeenCalled();

      harness.finishSocketSend();
      await waitForFast(() => {
        expect(handleGatewayRequest).toHaveBeenCalledTimes(MAX_QUEUED_GATEWAY_PREAUTH_FRAMES - 1);
      });
      expect(vi.mocked(handleGatewayRequest).mock.calls.map(([options]) => options.req.id)).toEqual(
        Array.from(
          { length: MAX_QUEUED_GATEWAY_PREAUTH_FRAMES - 1 },
          (_, index) => `registered-request-${index}`,
        ),
      );
      expect(close).not.toHaveBeenCalled();
    } finally {
      harness.finishSocketSend();
    }
  });

  it.each(["construction", "delivery"] as const)(
    "closes registered clients and discards pipelined frames when hello %s fails",
    async (failure) => {
      const close = createCloseMock();
      const harness = attachGatewayHarness({
        connId: "conn-failed-hello",
        connectNonce: "nonce-failed-hello",
        close,
      });
      const error = new Error(`synthetic hello ${failure} failure`);
      if (failure === "construction") {
        buildGatewaySnapshotMock.mockImplementationOnce(() => {
          throw error;
        });
      } else {
        harness.socketSend.mockImplementationOnce((_payload, callback) => callback?.(error));
      }

      harness.sendConnect("connect-before-failed-hello", BACKEND_CONNECT_PARAMS);
      harness.sendRequest("request-before-failed-hello", "status.summary");
      await harness.runWhenIdle();

      expect(buildGatewaySnapshotMock).toHaveBeenCalledOnce();
      expect({
        registrations: harness.setClient.mock.calls.length,
        closes: close.mock.calls.length,
        helloWrites: harness.socketSend.mock.calls.length,
        queuedRequests: vi.mocked(handleGatewayRequest).mock.calls.length,
      }).toEqual({
        registrations: 1,
        closes: 1,
        helloWrites: failure === "construction" ? 0 : 1,
        queuedRequests: 0,
      });
    },
  );

  it.each(["bytes", "count"] as const)(
    "rejects queued handshake %s overflow before registration",
    async (limit) => {
      let closed = false;
      const close = vi.fn<CloseGatewayConnection>(() => {
        closed = true;
      });
      const setCloseCause = createSetCloseCauseMock();
      const refreshHealthSnapshot = vi.fn(async () => createHealthSummary());
      const harness = attachGatewayHarness({
        connId: "handshake-overflow",
        connectNonce: "handshake-overflow",
        close,
        isClosed: () => closed,
        setCloseCause,
        refreshHealthSnapshot,
      });
      harness.sendConnect("connect", BACKEND_CONNECT_PARAMS);
      if (limit === "bytes") {
        harness.sendConnect("oversized", {
          ...BACKEND_CONNECT_PARAMS,
          pathEnv: "x".repeat(MAX_PREAUTH_PAYLOAD_BYTES + 1),
        });
      } else {
        for (let index = 0; index < MAX_QUEUED_GATEWAY_PREAUTH_FRAMES; index++) {
          harness.sendConnect(`overflow-${index}`, BACKEND_CONNECT_PARAMS);
        }
      }
      await waitForFast(() =>
        expect(close).toHaveBeenCalledWith(
          limit === "bytes" ? 1009 : 1008,
          limit === "bytes" ? "preauth payload too large" : "too many pending handshake frames",
        ),
      );
      if (limit === "bytes") {
        expect(setCloseCause).toHaveBeenCalledWith(
          "preauth-payload-too-large",
          expect.objectContaining({
            limitBytes: MAX_PREAUTH_PAYLOAD_BYTES,
            payloadBytes: expect.any(Number),
          }),
        );
      } else {
        expect(setCloseCause).toHaveBeenCalledWith("handshake-message-overflow", {
          queuedFrames: MAX_QUEUED_GATEWAY_PREAUTH_FRAMES - 1,
        });
      }
      expect(harness.client).toBeNull();
      expect(harness.setClient).not.toHaveBeenCalled();
      expect(harness.socketSend).not.toHaveBeenCalled();
      expect(refreshHealthSnapshot).not.toHaveBeenCalled();
      expect(handleGatewayRequest).not.toHaveBeenCalled();
    },
  );

  it("drains credential mutation barriers installed by earlier queued requests", async () => {
    const firstMutation = createGatewayHarnessGate();
    const secondMutation = createGatewayHarnessGate();
    let releaseFirstMutation: (() => void) | undefined;
    let releaseSecondMutation: (() => void) | undefined;
    const close = createCloseMock();
    const client = createConnectedTestClient({ connId: "conn-chained-invalidating" });
    vi.mocked(handleGatewayRequest).mockImplementation(async (opts) => {
      if (opts.req.method === "device.token.rotate") {
        releaseFirstMutation = firstMutation.resolve;
        await firstMutation.promise;
        return;
      }
      expect(opts.req.method).toBe("device.token.revoke");
      releaseSecondMutation = secondMutation.resolve;
      await secondMutation.promise;
      client.invalidated = true;
      client.invalidatedReason = "device-token-revoked";
    });

    const harness = attachGatewayHarness({
      connId: "conn-chained-invalidating",
      connectNonce: "nonce-chained-invalidating",
      client,
      close,
    });

    harness.sendRequest("rotate-1", "device.token.rotate", DEVICE_TOKEN_MUTATION_PARAMS);
    harness.sendRequest("revoke-1", "device.token.revoke", DEVICE_TOKEN_MUTATION_PARAMS);
    harness.sendRequest("queued-1", "status.summary");

    await waitForFast(() => {
      expect(handleGatewayRequest).toHaveBeenCalledTimes(1);
      expect(releaseFirstMutation).toBeTypeOf("function");
    });

    releaseFirstMutation?.();
    await waitForFast(() => {
      expect(handleGatewayRequest).toHaveBeenCalledTimes(2);
      expect(releaseSecondMutation).toBeTypeOf("function");
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(handleGatewayRequest).toHaveBeenCalledTimes(2);

    releaseSecondMutation?.();
    await waitForFast(() => {
      expect(close).toHaveBeenCalledWith(4001, "client invalidated: device-token-revoked");
    });
    expect(handleGatewayRequest).toHaveBeenCalledTimes(2);
  });

  it("shares the background health cadence after cached health without delaying explicit health", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const cached = createHealthSummary();
    cached.ts = now;
    const refreshHealthSnapshot = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(
      async () => cached,
    );
    let connection = 0;
    const connect = async (refresh = refreshHealthSnapshot) => {
      const id = `background-health-${++connection}`;
      const harness = attachGatewayHarness({
        connId: id,
        connectNonce: id,
        refreshHealthSnapshot: refresh,
      });
      harness.sendConnect(id, {
        ...BACKEND_CONNECT_PARAMS,
        caps: [],
      });
      await waitForFast(() => expect(harness.socketSend).toHaveBeenCalled());
      await nextTurn();
      const hello = JSON.parse(harness.socketSend.mock.calls[0]![0]);
      expect(hello.ok).toBe(true);
    };
    const health = async (probe = false, snapshot: HealthSummary | null = cached) => {
      const respond = vi.fn();
      await healthHandlers.health!({
        params: { probe },
        context: {
          getHealthCache: () => snapshot,
          getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
          refreshHealthSnapshot,
          logHealth: createLogger(),
        },
        respond,
      } as never);
      expect(respond.mock.calls[0]?.[0]).toBe(true);
    };
    try {
      await health();
      await connect();
      await connect();
      expect(refreshHealthSnapshot).toHaveBeenCalledTimes(1);

      await health(true);
      await health(false, null);
      await health(false, { ...cached, ts: now - HEALTH_REFRESH_INTERVAL_MS });
      expect(refreshHealthSnapshot).toHaveBeenCalledTimes(4);
      expect(refreshHealthSnapshot).toHaveBeenNthCalledWith(2, {
        probe: true,
        includeSensitive: false,
      });

      now += HEALTH_REFRESH_INTERVAL_MS;
      await connect();
      expect(refreshHealthSnapshot).toHaveBeenCalledTimes(5);
      expect(refreshHealthSnapshot).toHaveBeenLastCalledWith({ probe: false });
      const otherOwner = vi.fn<GatewayRequestContext["refreshHealthSnapshot"]>(async () => cached);
      await connect(otherOwner);
      expect(otherOwner).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it("waits for SQL-free profile acquisition, projects durable presence, and refreshes avatars on reconnect", async () => {
    await withGatewayTestState({ label: "gateway-profile-presence" }, async () => {
      const writes = await vi.importActual<typeof import("../../../state/user-profile-writes.js")>(
        "../../../state/user-profile-writes.js",
      );
      const started = createGatewayHarnessGate();
      const release = createGatewayHarnessGate();
      ensureProfileForEmailMock.mockImplementationOnce(
        async (...args: Parameters<typeof writes.ensureCanonicalUserProfileForEmail>) => {
          started.resolve();
          await release.promise;
          return writes.ensureCanonicalUserProfileForEmail(...args);
        },
      );
      const connect = async (suffix: string) => {
        const connId = `conn-trusted-proxy-user-${suffix}`;
        let sql: ReturnType<typeof observeMainThreadSql> | undefined;
        const harness = connectTrustedProxyUser(
          loadConfigMock,
          connId,
          { timeZone: "Europe/Vienna" },
          [],
          () => {
            try {
              sql?.expectIdle();
            } finally {
              sql?.restore();
            }
          },
        );
        try {
          if (suffix === "first") {
            await Promise.race([
              started.promise,
              harness.whenAttached.then(() => {
                throw new Error("Profile acquisition was skipped");
              }),
            ]);
            expect(harness.client).toBeNull();
            expect(upsertPresenceMock).not.toHaveBeenCalled();
            sql = observeMainThreadSql();
            release.resolve();
          }
          await harness.whenAttached;
        } finally {
          release.resolve();
          sql?.restore();
        }
        const presence = upsertPresenceMock.mock.calls.find(([key]) => key === connId)?.[1] as {
          user?: { id: string; email?: string; name?: string; avatarUrl?: string };
        };
        return { connId, harness, presence };
      };

      const first = await connect("first");
      expect(upsertPresenceMock).toHaveBeenCalledWith(
        first.connId,
        expect.objectContaining({ timeZone: "Europe/Vienna" }),
        { pending: true },
      );
      expect(createAuthenticatedGitHubIdentitySyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          authResult: expect.objectContaining({ method: "trusted-proxy" }),
          authConfig: expect.objectContaining({
            trustedProxy: expect.objectContaining({ userHeader: "x-forwarded-user" }),
          }),
        }),
      );
      expect(first.harness.client).not.toHaveProperty("authenticatedGitHubIdentitySync");
      const profileId = first.presence.user?.id;
      expect(first.presence.user).toEqual({
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
        identity: { type: "profile", id: profileId },
        email: "alice@example.com",
        name: "alice",
        avatarUrl: expect.stringMatching(
          new RegExp(`^/api/users/${profileId}/avatar\\?v=\\d+$`, "u"),
        ),
      });
      expect(
        first.harness.client,
        JSON.stringify(first.harness.logWsControl.warn.mock.calls),
      ).toMatchObject({
        authenticatedUserId: "alice@example.com",
        authenticatedUserProfile: {
          profileId,
          displayName: "alice",
          hasAvatar: false,
        },
        preparedSessionProfile: { profileId, aliases: expect.any(Set) },
      });
      expect(localUserIngressFor(first.harness.client)).toMatchObject({
        facts: {
          ingress: {
            kind: "gateway-client",
            rawSourceRef: profileId,
            state: "present",
          },
          invoker: {
            state: "present",
            kind: "person",
            rawPrincipalRef: profileId,
            displayLabel: "alice",
          },
          assurance: expect.arrayContaining([
            expect.objectContaining({ kind: "durable-profile" }),
            expect.objectContaining({ kind: "trusted-proxy" }),
          ]),
        },
      });

      expect(setAvatar(profileId!, new Uint8Array([1, 2, 3]), "image/png").ok).toBe(true);
      const second = await connect("second");
      const secondAvatarUrl = second.presence.user?.avatarUrl;
      expect(second.presence.user).toEqual({
        ...first.presence.user,
        avatarUrl: expect.stringMatching(
          new RegExp(`^/api/users/${profileId}/avatar\\?v=[0-9a-f]{64}-png$`, "u"),
        ),
      });
      expect(second.harness.client).toMatchObject({
        authenticatedUserProfile: { profileId, hasAvatar: true },
      });

      expect(setAvatar(profileId!, new Uint8Array([4, 5, 6]), "image/png").ok).toBe(true);
      const third = await connect("third");
      expect(third.presence.user?.avatarUrl).not.toBe(secondAvatarUrl);
      expect(third.presence.user?.avatarUrl).toMatch(
        new RegExp(`^/api/users/${profileId}/avatar\\?v=[0-9a-f]{64}-png$`, "u"),
      );

      expect(first.harness.logWsControl.info).toHaveBeenCalledWith(
        "authenticated user connected conn=conn-trusted-proxy-user-first user=alice@example.com",
      );
    });
  });

  it.each(["live", "closed"] as const)(
    "adopts the verified Factory avatar with connection lifetime authority (%s)",
    async (state) => {
      await withGatewayTestState({ label: "gateway-factory-avatar" }, async () => {
        const principal = "github:microsoft.ghe.com:101";
        const profile = ensureProfileForEmail(principal);
        const avatarUrl = "https://microsoft.ghe.com/avatars/u/101?size=96";
        createAuthenticatedGitHubIdentitySyncMock.mockReturnValueOnce(async () => ({
          profileId: profile.id,
          updatedAt: profile.updatedAt,
          factory: { accountId: 101, login: "alice", avatarUrl },
        }));
        const entered = createGatewayHarnessGate();
        const release = createGatewayHarnessGate();
        let assertCurrent: (() => void) | undefined;
        adoptTailscaleProfileAvatarMock.mockImplementationOnce(
          async (_id, _url, _options, fetchOptions) => {
            assertCurrent = fetchOptions?.assertCurrent;
            entered.resolve();
            await release.promise;
            assertCurrent?.();
            return profile;
          },
        );
        resolveConnectAuthStateMock.mockResolvedValueOnce({
          authResult: { ok: true, method: "trusted-proxy", user: principal },
          authOk: true,
          authMethod: "trusted-proxy",
          sharedAuthOk: true,
        });
        useGatewayTestConfig(loadConfigMock, () => ({
          gateway: {
            auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-factory-principal" } },
            controlUi: { allowedOrigins: ["http://127.0.0.1:19001"] },
          },
        }));
        let closed = false;
        const harness = attachGatewayHarness({
          connId: "factory-avatar",
          connectNonce: "factory-avatar",
          isClosed: () => closed,
          resolvedAuth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: { userHeader: "x-factory-principal" },
          },
          headers: { "x-factory-principal": principal },
        });
        harness.sendConnect("factory-avatar", {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: "gateway-client", version: "dev", platform: "test", mode: "backend" },
          role: "operator",
          caps: [],
        });
        try {
          await harness.whenAttached;
          await entered.promise;
          expect(adoptTailscaleProfileAvatarMock).toHaveBeenCalledWith(
            profile.id,
            avatarUrl,
            {},
            { assertCurrent: expect.any(Function) },
          );
          expect(assertCurrent).toBeTypeOf("function");
          expect(() => assertCurrent!()).not.toThrow();
          closed = state === "closed";
          if (closed) {
            expect(() => assertCurrent!()).toThrow("authority expired");
          }
        } finally {
          release.resolve();
        }
      });
    },
  );

  it("registers a verified profile before detached Tailscale avatar adoption completes", async () => {
    await withGatewayTestState({ label: "gateway-tailscale-avatar-detached" }, async () => {
      const avatar =
        createGatewayHarnessGate<ReturnType<typeof ensureProfileForTailscaleIdentity>>();
      let resolveAvatar: typeof avatar.resolve | undefined;
      adoptTailscaleProfileAvatarMock.mockImplementationOnce(async () => {
        resolveAvatar = avatar.resolve;
        return await avatar.promise;
      });
      resolveConnectAuthStateMock.mockResolvedValueOnce({
        authResult: {
          ok: true,
          method: "tailscale",
          user: "ada@passkey",
          tailscaleIdentity: {
            login: "ada@passkey",
            name: "Ada Lovelace",
            profilePic: "https://avatars.example.test/ada.png",
          },
        },
        authOk: true,
        authMethod: "tailscale",
        sharedAuthOk: true,
      });
      const harness = attachGatewayHarness({
        connId: "conn-tailscale-avatar-detached",
        connectNonce: "nonce-tailscale-avatar-detached",
      });

      harness.sendConnect("connect-tailscale-avatar-detached", {
        ...BACKEND_CONNECT_PARAMS,
        caps: [],
      });

      await harness.whenAttached;
      await waitForFast(() => {
        expect(harness.client).toMatchObject({
          authenticatedUserId: "ada@passkey",
          authenticatedUserIsTailscaleProvider: true,
          authenticatedUserProfile: { displayName: "Ada Lovelace", hasAvatar: false },
        });
        expect(localUserIngressFor(harness.client)).toMatchObject({
          facts: {
            invoker: { state: "present", kind: "person", displayLabel: "Ada Lovelace" },
            assurance: expect.arrayContaining([
              expect.objectContaining({ kind: "durable-profile" }),
              expect.objectContaining({ kind: "tailscale-whois" }),
            ]),
          },
        });
        expect(adoptTailscaleProfileAvatarMock).toHaveBeenCalledOnce();
      });
      expect(harness.socketSend).toHaveBeenCalled();

      const profile = (
        harness.client as {
          authenticatedUserProfile: { profileId: string; displayName: string; updatedAt: number };
        }
      ).authenticatedUserProfile;
      expect(setAvatar(profile.profileId, new Uint8Array([7, 8, 9]), "image/png").ok).toBe(true);
      const adoptedUpdatedAt = profile.updatedAt + 1;
      resolveAvatar?.({
        id: profile.profileId,
        displayName: profile.displayName,
        avatarMime: "image/png",
        mergedInto: null,
        createdAt: profile.updatedAt,
        updatedAt: adoptedUpdatedAt,
      });
      await waitForFast(() => {
        expect(harness.client).toMatchObject({
          authenticatedUserProfile: { hasAvatar: true, updatedAt: adoptedUpdatedAt },
        });
      });
      expect(createAuthenticatedGitHubIdentitySyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          authResult: expect.objectContaining({ method: "tailscale", user: "ada@passkey" }),
        }),
      );
    });
  });

  it.each(["closed", "merged"] as const)(
    "prepares deferred identity before publication only while its socket is live (%s)",
    async (state) => {
      await withGatewayTestState({ label: "gateway-github-profile-deferred" }, async () => {
        const canonical = ensureProfileForEmail("canonical@example.test");
        const mergedTarget = ensureProfileForEmail("canonical-target@example.test");
        const expectedProfileId = state === "merged" ? mergedTarget.id : canonical.id;
        const syncCompletion = createGatewayHarnessGate<{ profileId: string; updatedAt: number }>();
        let finishSync: (() => void) | undefined;
        const sync = vi.fn(async () => {
          finishSync = () =>
            syncCompletion.resolve({ profileId: canonical.id, updatedAt: canonical.updatedAt });
          return await syncCompletion.promise;
        });
        createAuthenticatedGitHubIdentitySyncMock.mockReturnValueOnce(sync);
        resolveConnectAuthStateMock.mockResolvedValueOnce({
          authResult: {
            ok: true,
            method: "tailscale",
            user: "ada@github",
            tailscaleIdentity: { login: "ada@github", name: "Ada Lovelace" },
          },
          authOk: true,
          authMethod: "tailscale",
          sharedAuthOk: true,
        });
        let closed = false;
        const harness = attachGatewayHarness({
          connId: "conn-github-identity-detached",
          connectNonce: "nonce-github-identity-detached",
          isClosed: () => closed,
        });

        harness.sendConnect("connect-github-identity-detached", {
          ...TEST_CONNECT_PARAMS,
          caps: [],
        });

        await waitForFast(() => {
          expect(harness.socketSend).toHaveBeenCalled();
          expect(harness.client).toMatchObject({
            authenticatedUserId: "ada@github",
            authenticatedGitHubIdentitySync: expect.any(Function),
          });
          expect(harness.client).not.toHaveProperty("authenticatedUserProfile");
          expect(localUserIngressFor(harness.client)).toMatchObject({
            facts: { invoker: { state: "unknown" } },
          });
          expect(createAuthenticatedGitHubIdentitySyncMock).toHaveBeenCalledWith(
            expect.objectContaining({
              authResult: expect.objectContaining({ method: "tailscale", user: "ada@github" }),
            }),
          );
          expect(sync).toHaveBeenCalledOnce();
        });
        const initialPresence = upsertPresenceMock.mock.calls.find(
          ([key]) => key === "conn-github-identity-detached",
        )?.[1];
        expect(initialPresence).not.toHaveProperty("user");
        expect(harness.registeredProfileId).toBeUndefined();
        expect(harness.socketSend.mock.invocationCallOrder[0]).toBeLessThan(
          sync.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(finishSync).toBeTypeOf("function");
        closed = state === "closed";
        if (state === "merged") {
          linkEmail("canonical@example.test", mergedTarget.id);
        }
        finishSync?.();

        if (closed) {
          await vi.dynamicImportSettled();
          expect(harness.client).not.toHaveProperty("authenticatedUserProfile");
          expect(harness.refreshConnectedUserProfile).not.toHaveBeenCalled();
          return;
        }

        await waitForFast(() => {
          expect(harness.client).toMatchObject({
            authenticatedUserProfile: { profileId: expectedProfileId },
            preparedRecipientProfileId: expectedProfileId,
          });
          expect(localUserIngressFor(harness.client)).toMatchObject({
            facts: {
              invoker: { state: "present", kind: "person", rawPrincipalRef: expectedProfileId },
            },
          });
          expect(harness.refreshConnectedUserProfile).toHaveBeenCalledWith(
            expect.objectContaining({ id: expectedProfileId }),
          );
        });
        expect(harness.refreshedProfileIds).toEqual([expectedProfileId]);
      });
    },
  );

  it.each(["resume", "close"] as const)(
    "settles identity sync parked by suspension when the Gateway handles %s",
    async (action) => {
      await withGatewayTestState({ label: "gateway-suspended-identity" }, async () => {
        const canonical = ensureProfileForEmail("canonical@example.test");
        const sync = vi.fn(async () => ({
          profileId: canonical.id,
          updatedAt: canonical.updatedAt,
        }));
        createAuthenticatedGitHubIdentitySyncMock.mockReturnValueOnce(sync);
        resolveConnectAuthStateMock.mockResolvedValueOnce({
          authResult: {
            ok: true,
            method: "tailscale",
            user: "ada@github",
            tailscaleIdentity: { login: "ada@github", name: "Ada Lovelace" },
          },
          authOk: true,
          authMethod: "tailscale",
          sharedAuthOk: true,
        });
        const suspension = tryBeginGatewaySuspendAdmission(() => {});
        expect(suspension?.commit()).toBe(true);
        let closing: Promise<void> | undefined;
        try {
          const harness = attachGatewayHarness({
            connId: "conn-suspended-identity",
            connectNonce: "nonce-suspended-identity",
          });
          harness.sendConnect("connect-suspended-identity", {
            ...TEST_CONNECT_PARAMS,
            caps: [],
          });
          await waitForFast(() => expect(harness.socketSend).toHaveBeenCalled());
          await nextTurn();
          expect(sync).not.toHaveBeenCalled();
          if (action === "resume") {
            suspension?.release();
            await waitForFast(() => expect(sync).toHaveBeenCalledOnce());
            return;
          }
          let drained = false;
          closing = cleanupGatewayHarnesses().then(() => {
            drained = true;
          });
          await nextTurn();
          expect.soft(drained, "closing does not wait for suspension expiry").toBe(true);
          suspension?.release();
          await closing;
          expect(sync).not.toHaveBeenCalled();
        } finally {
          suspension?.release();
          await closing;
        }
      });
    },
  );

  it("resolves a GitHub-backed role before registering the connection or sending hello", async () => {
    await withGatewayTestState({ label: "gateway-github-role-before-hello" }, async () => {
      const canonical = ensureProfileForEmail("canonical@example.test");
      const syncCompletion = createGatewayHarnessGate<{ profileId: string; updatedAt: number }>();
      const sync = vi.fn(async () => await syncCompletion.promise);
      createAuthenticatedGitHubIdentitySyncMock.mockReturnValueOnce(sync);
      useGatewayTestConfig(loadConfigMock, () => ({
        gateway: {
          auth: {
            mode: "none",
            identityScopes: { "ada@github": ["operator.read", "operator.admin"] },
          },
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "view" as const },
                agents: "*" as const,
                scopes: ["operator.read" as const],
              },
            },
          },
          controlUi: { allowedOrigins: ["http://127.0.0.1:19001"] },
        },
      }));
      resolveConnectAuthStateMock.mockResolvedValueOnce({
        authResult: {
          ok: true,
          method: "tailscale",
          user: "ada@github",
          tailscaleIdentity: { login: "ada@github", name: "Ada Lovelace" },
        },
        authOk: true,
        authMethod: "tailscale",
        sharedAuthOk: true,
      });
      const harness = attachGatewayHarness({
        connId: "conn-github-role-before-hello",
        connectNonce: "nonce-github-role-before-hello",
      });

      harness.sendConnect("connect-github-role-before-hello", {
        ...TEST_CONNECT_PARAMS,
        caps: [],
      });

      await waitForFast(() => expect(sync).toHaveBeenCalledOnce());
      expect(harness.client).toBeNull();
      expect(harness.socketSend).not.toHaveBeenCalled();
      syncCompletion.resolve({ profileId: canonical.id, updatedAt: canonical.updatedAt });

      await waitForFast(() => {
        expect(harness.client).toMatchObject({
          connect: { scopes: ["operator.read"] },
          authenticatedUserProfile: { profileId: canonical.id },
        });
        expect(harness.socketSend).toHaveBeenCalled();
      });
      expect(sync.mock.invocationCallOrder[0]).toBeLessThan(
        harness.socketSend.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    });
  });

  it.each([
    {
      error: new Error("private upstream failure"),
      message: "profile verification is unavailable",
      retryAfterMs: 1_000,
    },
    {
      error: new gitHubPublicApi.ControlUiGitHubError(429, "private upstream failure", {
        retryAtMs: 1_800_000_090_000,
      }),
      message: "GitHub is rate limiting profile verification",
      retryAfterMs: 90_000,
    },
  ])(
    "rejects unavailable configured-role identity with actionable guidance ($message)",
    async ({ error, message, retryAfterMs }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      onTestFinished(() => clock.mockRestore());
      await withGatewayTestState(
        { label: "gateway-github-role-verification-failure" },
        async () => {
          createAuthenticatedGitHubIdentitySyncMock.mockReturnValueOnce(
            vi.fn(async () => {
              throw error;
            }),
          );
          useGatewayTestConfig(loadConfigMock, () => ({
            gateway: {
              auth: {
                mode: "none",
                identityScopes: { "ada@github": ["operator.admin"] },
              },
              roles: {
                default: "guest",
                definitions: {
                  guest: {
                    sessions: { others: "view" as const },
                    agents: "*" as const,
                    scopes: ["operator.read" as const],
                  },
                },
              },
              controlUi: { allowedOrigins: ["http://127.0.0.1:19001"] },
            },
          }));
          resolveConnectAuthStateMock.mockResolvedValueOnce({
            authResult: {
              ok: true,
              method: "tailscale",
              user: "ada@github",
              tailscaleIdentity: { login: "ada@github", name: "Ada Lovelace" },
            },
            authOk: true,
            authMethod: "tailscale",
            sharedAuthOk: true,
          });
          const close = createCloseMock();
          const harness = attachGatewayHarness({
            connId: "conn-github-role-verification-failure",
            connectNonce: "nonce-github-role-verification-failure",
            close,
          });

          harness.sendConnect("connect-github-role-verification-failure", {
            ...TEST_CONNECT_PARAMS,
            caps: [],
          });

          await waitForFast(() => {
            expect(harness.send).toHaveBeenCalledWith(
              expect.objectContaining({
                id: "connect-github-role-verification-failure",
                ok: false,
                error: expect.objectContaining({
                  code: ErrorCodes.UNAVAILABLE,
                  message: expect.stringContaining(message),
                  retryable: true,
                  retryAfterMs,
                  details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
                }),
              }),
            );
            expect(close).toHaveBeenCalledWith(1013, expect.stringContaining(message));
          });
          expect(harness.client).toBeNull();
          expect(harness.socketSend).not.toHaveBeenCalled();
          expect(JSON.stringify(harness.send.mock.calls)).not.toContain("private upstream failure");
        },
      );
    },
  );

  it("keeps a mutable GitHub alias unattributed when immutable sync fails", async () => {
    await withGatewayTestState({ label: "gateway-github-profile-failure" }, async () => {
      syncGitHubIdentity({
        identity: { accountId: 10, login: "prior-owner" },
        authenticationAlias: { kind: "github-login", login: "released-login" },
        initialDisplayName: "Prior Verified Owner",
      });
      const sync = vi.fn(async () => {
        throw new Error("GitHub unavailable");
      });
      createAuthenticatedGitHubIdentitySyncMock.mockReturnValueOnce(sync);
      resolveConnectAuthStateMock.mockResolvedValueOnce({
        authResult: {
          ok: true,
          method: "tailscale",
          user: "released-login@github",
          tailscaleIdentity: { login: "released-login@github", name: "New Account" },
        },
        authOk: true,
        authMethod: "tailscale",
        sharedAuthOk: true,
      });
      const harness = attachGatewayHarness({
        connId: "conn-github-identity-failure",
        connectNonce: "nonce-github-identity-failure",
      });

      harness.sendConnect("connect-github-identity-failure", {
        ...TEST_CONNECT_PARAMS,
        caps: [],
      });

      await waitForFast(() => {
        expect(harness.socketSend).toHaveBeenCalled();
        expect(sync).toHaveBeenCalledOnce();
      });
      await waitForFast(() => {
        expect(harness.client).not.toHaveProperty("authenticatedUserProfile");
        expect(localUserIngressFor(harness.client)).toMatchObject({
          facts: { invoker: { state: "unknown" } },
        });
      });
      const presence = upsertPresenceMock.mock.calls.find(
        ([key]) => key === "conn-github-identity-failure",
      )?.[1];
      expect(presence).not.toHaveProperty("user");
      expect(harness.refreshConnectedUserProfile).not.toHaveBeenCalled();
    });
  });

  it("mints Cloudflare sync only for the standard trusted-proxy header contract", async () => {
    const assertion = "header.payload.signature";
    useGatewayTestConfig(loadConfigMock, () => ({
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: {
            userHeader: "cf-access-authenticated-user-email",
            requiredHeaders: ["CF-Access-JWT-Assertion"],
          },
        },
        trustedProxies: ["10.0.0.1"],
        controlUi: { allowedOrigins: ["https://team.openclaw.ai"] },
      },
    }));
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "trusted-proxy",
      allowTailscale: false,
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["CF-Access-JWT-Assertion"],
      },
    };
    const harness = attachGatewayHarness({
      connId: "conn-cloudflare-access",
      connectNonce: "nonce-cloudflare-access",
      requestHost: "team.openclaw.ai",
      requestOrigin: "https://team.openclaw.ai",
      remoteAddr: "10.0.0.1",
      resolvedAuth,
      headers: {
        "cf-access-authenticated-user-email": "ada@example.com",
        "cf-access-jwt-assertion": assertion,
        "x-forwarded-for": "203.0.113.10",
      },
      ingressAttribution: {
        kind: "trusted-proxy",
        clientIp: "203.0.113.10",
        rateLimit: { subject: { key: "203.0.113.10" }, resetOnSuccess: true },
      },
    });

    harness.sendConnect("connect-cloudflare-access", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "openclaw-control-ui",
        version: "dev",
        platform: "test",
        mode: "ui",
      },
      role: "operator",
      caps: [],
    });

    await waitForFast(() => {
      expect(harness.client).toMatchObject({
        authenticatedUserId: "ada@example.com",
        authenticatedGitHubIdentitySync: expect.any(Function),
      });
      expect(createAuthenticatedGitHubIdentitySyncMock).toHaveBeenCalledWith(
        expect.objectContaining({
          authResult: expect.objectContaining({
            method: "trusted-proxy",
            user: "ada@example.com",
          }),
          authConfig: expect.objectContaining({ mode: "trusted-proxy" }),
          requestHeaders: expect.objectContaining({
            "cf-access-jwt-assertion": assertion,
          }),
        }),
      );
    });
  });

  it.each(["owner", "proxy"] as const)(
    "continues %s admission with unattributed presence when profile storage fails",
    async (source) => {
      const profileWriter =
        source === "owner" ? ensureGatewayOwnerProfileMock : ensureProfileForEmailMock;
      profileWriter.mockImplementationOnce(() => {
        throw new Error("profile store unavailable");
      });
      let harness: ReturnType<typeof attachGatewayHarness>;
      if (source === "owner") {
        resolveConnectAuthStateMock.mockResolvedValueOnce({
          authResult: { ok: true, method: "token" },
          authOk: true,
          authMethod: "token",
          sharedAuthOk: true,
        });
        harness = attachGatewayHarness({
          connId: "owner-storage-failure",
          connectNonce: "owner-storage-failure",
        });
        harness.sendConnect("connect", {
          ...TEST_CONNECT_PARAMS,
          auth: { token: "owner-fixture" },
        });
        await waitForFast(() => expect(harness.client).not.toBeNull());
        expect(harness.client).not.toHaveProperty("authenticatedUserProfile");
        expect(harness.logWsControl.warn).toHaveBeenCalledWith(
          expect.stringContaining("user profile resolution failed"),
        );
        expect(harness.socketSend).toHaveBeenCalled();
        return;
      }
      harness = connectTrustedProxyUser(loadConfigMock, "conn-profile-store-failure");
      await waitForFast(() => {
        expect(upsertPresenceMock).toHaveBeenCalledWith(
          "conn-profile-store-failure",
          expect.objectContaining({
            user: { id: "alice@example.com", email: "alice@example.com" },
          }),
          { pending: true },
        );
      });
      expect(harness.client).toMatchObject({ authenticatedUserId: "alice@example.com" });
      expect(localUserIngressFor(harness.client)).toMatchObject({
        facts: {
          ingress: expect.not.objectContaining({ rawSourceRef: expect.anything() }),
          invoker: { state: "unknown" },
          assurance: [
            {
              kind: "trusted-proxy",
              rawEvidenceRef: "gateway-auth:trusted-proxy",
              strength: "boundary-verified",
            },
          ],
        },
      });
      expect(harness.client).not.toMatchObject({ authenticatedUserProfile: expect.anything() });
      expect(harness.logWsControl.warn).toHaveBeenCalledTimes(1);
      expect(harness.logWsControl.warn).toHaveBeenCalledWith(
        expect.stringContaining("profile store unavailable"),
      );
    },
  );

  it.each(["credentials", "Tailscale policy"])(
    "rejects a handshake when %s changes before session attachment",
    async (changed) => {
      const config = loadConfigMock();
      let allowTailscale = false;
      useGatewayTestConfig(loadConfigMock, () => ({
        ...config,
        gateway: { ...config.gateway, auth: { ...config.gateway.auth, allowTailscale } },
      }));
      const oldAuth = {
        mode: "token" as const,
        token: "gateway-token-old",
        allowTailscale: false,
      };
      const oldGeneration = resolveSharedGatewaySessionGeneration(oldAuth, []);
      const newGeneration = resolveSharedGatewaySessionGeneration(
        { ...oldAuth, token: "gateway-token-new" },
        [],
      );
      expect(oldGeneration).toBeTypeOf("string");
      expect(newGeneration).toBeTypeOf("string");
      const generationState = new SharedGatewaySessionGenerationState({
        current: oldGeneration,
        required: null,
      });
      const preparationStarted = createDeferred();
      const releasePreparation = createGatewayHarnessGate();
      prepareGatewayNodeConnectMock.mockImplementationOnce(async () => {
        preparationStarted.resolve();
        await releasePreparation.promise;
        return true;
      });
      const completed = createDeferred();
      const close = createCloseMock().mockImplementation(() => completed.resolve());
      const setCloseCause = createSetCloseCauseMock();
      const harness = attachGatewayHarness({
        connId: "conn-token-rotated-during-connect",
        connectNonce: "nonce-token-rotated-during-connect",
        resolvedAuth: oldAuth,
        getRequiredSharedGatewaySessionGeneration: generationState.reader,
        close,
        setCloseCause,
        handoffAuthenticatedReceive: () => completed.resolve(),
      });

      harness.sendConnect("connect-token-rotated-during-connect", {
        ...BACKEND_CONNECT_PARAMS,
        caps: [],
        auth: { token: oldAuth.token },
      });
      await preparationStarted.promise;
      if (changed === "credentials") {
        enforceSharedGatewaySessionGenerationForConfigWrite({
          state: generationState,
          nextConfig: {
            gateway: {
              auth: { mode: "token", token: "gateway-token-new" },
              reload: { mode: "off" },
            },
          },
          resolveRuntimeSnapshotGeneration: () => newGeneration,
          clients: [],
        });
      } else {
        allowTailscale = true;
      }
      releasePreparation.resolve();

      await completed.promise;
      expect(close).toHaveBeenCalledWith(4001, "gateway auth changed");
      expect(setCloseCause).toHaveBeenCalledWith("gateway-auth-rotated", {
        authGenerationStale: true,
      });
      expect(harness.client).toBeNull();
      expect(harness.socketSend).not.toHaveBeenCalled();
      expect(harness.send).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    },
  );

  it("rejects a pending handshake after host-header fallback stops allowing its browser origin", async () => {
    const origin = "https://browser.example.test";
    const previousLoadConfig = loadConfigMock.getMockImplementation();
    let controlUi: {
      allowedOrigins: string[];
      dangerouslyAllowHostHeaderOriginFallback: boolean;
    } = {
      allowedOrigins: [],
      dangerouslyAllowHostHeaderOriginFallback: true,
    };
    loadConfigMock.mockImplementation(() => ({
      gateway: { auth: { mode: "none" }, controlUi },
    }));
    const preparationStarted = createDeferred();
    const releasePreparation = createDeferred();
    prepareGatewayNodeConnectMock.mockImplementationOnce(async () => {
      preparationStarted.resolve();
      await releasePreparation.promise;
      return true;
    });
    const close = createCloseMock();
    const harness = attachGatewayHarness({
      connId: "origin-revoked-fallback",
      connectNonce: "origin-revoked-fallback",
      requestOrigin: origin,
      requestHost: "browser.example.test",
      remoteAddr: "203.0.113.50",
      resolvedAuth: { mode: "token", token: "gateway-token", allowTailscale: false },
      close,
    });

    try {
      harness.sendConnect("connect-origin-revoked", {
        ...BACKEND_CONNECT_PARAMS,
        caps: [],
        auth: { token: "gateway-token" },
      });
      await preparationStarted.promise;
      controlUi = {
        allowedOrigins: ["https://other.example.test"],
        dangerouslyAllowHostHeaderOriginFallback: false,
      };
      releasePreparation.resolve();

      await waitForFast(() => {
        expect(harness.send).toHaveBeenCalledWith(
          expect.objectContaining({
            ok: false,
            error: expect.objectContaining({
              details: expect.objectContaining({
                code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
              }),
            }),
          }),
        );
      });
      expect(close).toHaveBeenCalledWith(1008, expect.stringContaining("origin not allowed"));
      expect(harness.client).toBeNull();
      expect(harness.socketSend).not.toHaveBeenCalled();
    } finally {
      releasePreparation.resolve();
      if (previousLoadConfig) {
        loadConfigMock.mockImplementation(previousLoadConfig);
      }
    }
  });

  it("emits a security event for rejected gateway auth", async () => {
    const close = createCloseMock();
    const harness = attachGatewayHarness({
      connId: "conn-auth-failed",
      connectNonce: "nonce-auth-failed",
      requestHost: "gateway.example.com:18789",
      remoteAddr: "203.0.113.50",
      resolvedAuth: {
        mode: "token",
        token: "gateway-token",
        allowTailscale: false,
      },
      close,
    });
    const captured = captureSecurityEvents();

    try {
      harness.sendConnect("connect-auth-failed", {
        ...BACKEND_CONNECT_PARAMS,
        scopes: ["operator.admin"],
        caps: [],
        auth: { token: "wrong-token" },
      });

      await waitForFast(() => {
        expect(close).toHaveBeenCalledWith(1008, expect.stringContaining("unauthorized"));
      });
    } finally {
      captured.stop();
    }

    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "gateway.auth.failed",
      outcome: "denied",
      severity: "medium",
      reason: "token_mismatch",
      actor: { kind: "operator", role: "operator" },
      target: { kind: "gateway", name: "websocket" },
      policy: {
        id: "gateway.websocket-auth",
        decision: "deny",
        reason: "token_mismatch",
      },
      control: { id: "gateway.ws.connect", family: "auth" },
      attributes: {
        auth_mode: "token",
        auth_method: "token",
        auth_provided: "token",
        client_mode: "backend",
        has_device_identity: false,
        scope_count: 0,
        rate_limited: false,
      },
    });
    expect(JSON.stringify(captured.events)).not.toContain("wrong-token");
    expect(JSON.stringify(captured.events)).not.toContain("gateway-token");
    const response = harness.send.mock.calls.at(0)?.[0] as
      | { error?: Record<string, unknown> }
      | undefined;
    expect(response?.error).not.toHaveProperty("retryable");
    expect(response?.error).not.toHaveProperty("retryAfterMs");
    await harness.runWhenIdle();
    expect(prewarmGatewaySessionHistoryMock).not.toHaveBeenCalled();
  });

  it("returns retry timing when gateway auth is rate-limited", async () => {
    const retryAfterMs = 15_000;
    const rateLimiter: AuthRateLimiter = {
      check: vi.fn(() => ({ allowed: false, remaining: 0, retryAfterMs })),
      recordFailure: vi.fn(),
      recordFailureAndDelay: vi.fn(async () => {}),
      reset: vi.fn(),
      size: vi.fn(() => 0),
      prune: vi.fn(),
      dispose: vi.fn(),
    };
    const close = createCloseMock();
    const harness = attachGatewayHarness({
      connId: "conn-auth-rate-limited",
      connectNonce: "nonce-auth-rate-limited",
      requestHost: "gateway.example.com:18789",
      remoteAddr: "203.0.113.51",
      resolvedAuth: {
        mode: "token",
        token: "test-token",
        allowTailscale: false,
      },
      rateLimiter,
      close,
    });

    harness.sendConnect("connect-auth-rate-limited", {
      ...BACKEND_CONNECT_PARAMS,
      scopes: [],
      caps: [],
      auth: { token: "test-token" },
    });

    await waitForFast(() => {
      expect(close).toHaveBeenCalledWith(1008, expect.stringContaining("retry later"));
    });

    const response = harness.send.mock.calls.at(0)?.[0] as
      | { error?: Record<string, unknown> }
      | undefined;
    expect(response?.error).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: "unauthorized: too many failed authentication attempts (retry later)",
      retryable: true,
      details: {
        code: ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
        authReason: "rate_limited",
      },
    });
    expect(response?.error?.retryAfterMs).toBeGreaterThan(0);
  });

  it.each([false, true])(
    "retains handshake-attested operator locality (remote: %s)",
    async (remote) => {
      const harness = attachGatewayHarness({
        connId: "operator-authority",
        connectNonce: "operator-authority",
        ...(remote ? REMOTE_BACKEND_OPTIONS : {}),
      });
      harness.sendConnect("connect", {
        ...BACKEND_CONNECT_PARAMS,
        scopes: ["operator.admin"],
        ...(remote ? { auth: { token: "gateway-token" } } : {}),
      });
      await waitForFast(() => expect(harness.socketSend).toHaveBeenCalled());
      const client = harness.client as GatewayWsClient;
      expect(client.clientIp).toBe(remote ? "203.0.113.50" : undefined);
      expect(client.internal?.isLocalClient).toBe(remote ? undefined : true);
      const runId = `${remote ? "remote" : "local"}-operator-run`;
      expect(
        resolveGatewayCronCreatorAuthorityAdmission({
          runId,
          resolvedSessionKey: "agent:main:main",
          client,
          request: { message: "hello", idempotencyKey: runId },
          hasRestoredCronContinuation: false,
          isOneShotModelRun: false,
          isRestartRecoveryResumeRun: false,
        }),
      ).toEqual(remote ? undefined : { runId, callerOrigin: { kind: "local" } });
    },
  );

  it.each([
    ["openclaw-control-ui", "operator.admin", true],
    ["openclaw-control-ui", "operator.read", false],
    ["openclaw-tui", "operator.admin", false],
  ] as const)(
    "records authenticated remote management authority for %s with %s: %s",
    async (id, scope, allowed) => {
      await withOpenClawTestState({ label: "gateway-control-ui-admin" }, async () => {
        const harness = connectTrustedProxyUser(loadConfigMock, "control-ui-authority", { id }, [
          scope,
        ]);
        await harness.whenAttached;
        expect(harness.client).toMatchObject({ connect: { scopes: [scope] } });
        const admission = resolveGatewayCronCreatorAuthorityAdmission({
          runId: "control-ui-admin-run",
          resolvedSessionKey: "agent:main:main",
          client: harness.client as never,
          request: { message: "manage an automation", idempotencyKey: "control-ui-admin-run" },
          hasRestoredCronContinuation: false,
          isOneShotModelRun: false,
          isRestartRecoveryResumeRun: false,
        });
        const expected = allowed
          ? {
              runId: "control-ui-admin-run",
              callerOrigin: { kind: "unknown" },
              callerScopedCreation: true,
              managementEntitlement: { source: "control-ui-admin" },
            }
          : undefined;
        expect(admission).toEqual(expected);
      });
    },
  );

  registerHandshakePolicyTest({ loadConfigMock, prepareGatewayNodeConnectMock });

  registerRuntimeIdentityTokenTests();
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
