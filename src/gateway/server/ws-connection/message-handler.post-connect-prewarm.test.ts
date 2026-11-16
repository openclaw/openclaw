// Keep vi.mock registrations local: imported fixture hooks cannot hoist them before the handler.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../../../infra/diagnostic-events.js";
import { ensureProfileForTailscaleIdentity } from "../../../state/user-profiles.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createGatewaySnapshotFixture } from "../health-state.test-support.js";
import { expectEphemeralOwnerConnect } from "./message-handler.owner-reconnect.test-support.js";
import {
  cleanupGatewayHarnesses,
  connectTrustedProxyUser,
  createGatewayHarnessGate,
} from "./message-handler.post-connect-health.test-support.js";

const {
  commitPresenceMock,
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
  resolveHostAccountNameMock,
  upsertPresenceMock,
} = vi.hoisted(() => ({
  commitPresenceMock: vi.fn(),
  buildGatewaySnapshotMock: vi.fn(() => createGatewaySnapshotFixture()),
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
  resolveHostAccountNameMock: vi.fn(async () => "Gateway Person"),
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

vi.mock("../../../infra/host-account-name.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/host-account-name.js")>()),
  resolveHostAccountName: resolveHostAccountNameMock,
}));

// mock-isolation: Keep remote enrichment synthetic while native connection admission stays real.
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
vi.mock("../../../config/runtime-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/runtime-snapshot.js")>()),
  readRuntimeConfig: loadConfigMock,
}));
vi.mock("../../../infra/system-presence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/system-presence.js")>()),
  commitPresence: commitPresenceMock,
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

describe("post-connect session-history prewarm and capabilities", () => {
  beforeEach(async () => {
    const state = await createOpenClawTestState({
      label: "post-connect-health",
      prepareProfileCatalog: true,
    });
    onTestFinished(async () => {
      await cleanupGatewayHarnesses();
      await state.cleanup();
    });
  });

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
        expect.objectContaining({ isCancelled: expect.any(Function) }),
      );
      expect(JSON.parse(harness.socketSend.mock.calls[0]![0])).toMatchObject({
        ok: true,
        payload: {
          type: "hello-ok",
          features: {
            capabilities: expect.arrayContaining([
              "node-worker-prepared-workspace-base-v1",
              "node-worker-prepared-workspace-deferred-verification-v1",
            ]),
          },
        },
      });
    } finally {
      prewarm.resolve();
    }
  });

  it.each([
    ["cli", "token"],
    ["backend", "token"],
    ["probe", "token"],
    ["probe", "none"],
  ] as const)(
    "keeps %s admission and identity independent of presence (auth: %s)",
    async (mode, authMethod) => {
      await withOpenClawTestState(
        { label: "gateway-owner-ephemeral", prepareProfileCatalog: true },
        async () => {
          await expectEphemeralOwnerConnect(mode, authMethod);
          expect(upsertPresenceMock).not.toHaveBeenCalled();
          expect(prewarmGatewaySessionHistoryMock).not.toHaveBeenCalled();
        },
      );
    },
  );
});
