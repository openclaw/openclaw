// Connect journal tests cover the structured "client connected" control log line
// emitted once a connection completes its handshake.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../../../infra/diagnostic-events.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createGatewaySnapshotFixture } from "../health-state.test-support.js";
import {
  attachGatewayHarness,
  BACKEND_CONNECT_PARAMS,
  cleanupGatewayHarnesses,
} from "./message-handler.post-connect-health.test-support.js";

const REMOTE_BACKEND_OPTIONS = {
  requestHost: "gateway.example.com:18789",
  remoteAddr: "203.0.113.50",
  resolvedAuth: { mode: "token", token: "gateway-token", allowTailscale: false },
} as const;

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

// mock-isolation: Connect journal tests do not use Enterprise identity or remote enrichment.
vi.mock("../../github-user-identity.js", () => ({
  createAuthenticatedGitHubIdentitySync: createAuthenticatedGitHubIdentitySyncMock,
  resolveTrustedEnterpriseGitHubAccountId: () => undefined,
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

// mock-isolation: Connect journal tests do not exercise session-history prewarm.
vi.mock("../../server-history-prewarm.js", () => ({
  prewarmGatewaySessionHistory: prewarmGatewaySessionHistoryMock,
}));

// mock-isolation: Runtime config comes from the hoisted loadConfigMock fixture; real config readers would touch operator state.
vi.mock("../../../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
}));

// mock-isolation: Config IO readers are replaced by the same hoisted loadConfigMock fixture.
vi.mock("../../../config/io.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));

vi.mock("../../../infra/system-presence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/system-presence.js")>()),
  commitPresence: commitPresenceMock,
  upsertPresence: upsertPresenceMock,
  listSystemPresence: vi.fn(() => []),
}));

// mock-isolation: Connect journal tests never dispatch gateway RPC methods.
vi.mock("../../server-methods.js", () => ({
  handleGatewayRequest: vi.fn(),
}));

// mock-isolation: Connect journal tests do not read health snapshot state.
vi.mock("../health-state.js", () => ({
  buildGatewaySnapshot: buildGatewaySnapshotMock,
  getHealthCache: getHealthCacheMock,
  getHealthVersion: getHealthVersionMock,
}));

beforeEach(() => {
  loadConfigMock.mockReset();
  loadConfigMock.mockImplementation(() => ({
    gateway: {
      auth: { mode: "none" },
      controlUi: {
        allowedOrigins: ["http://127.0.0.1:19001"],
      },
    },
  }));
});

describe("connect journal line", () => {
  beforeEach(async () => {
    const state = await createOpenClawTestState({
      label: "connect-journal",
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
  });

  it("records the resolved pairing locality on the connect journal line", async () => {
    const local = attachGatewayHarness({
      connId: "conn-locality-local",
      connectNonce: "nonce-locality-local",
    });
    local.sendConnect("connect", { ...BACKEND_CONNECT_PARAMS });
    await local.runWhenIdle();
    const localLine = local.logWsControl.info.mock.calls
      .map(([message]) => message)
      .find((message) => message.startsWith("client connected "));
    expect(localLine).toContain("conn=conn-locality-local");
    expect(localLine).toContain("locality=direct_local");

    const remote = attachGatewayHarness({
      connId: "conn-locality-remote",
      connectNonce: "nonce-locality-remote",
      ...REMOTE_BACKEND_OPTIONS,
    });
    remote.sendConnect("connect", {
      ...BACKEND_CONNECT_PARAMS,
      auth: { token: "gateway-token" },
    });
    await remote.runWhenIdle();
    const remoteLine = remote.logWsControl.info.mock.calls
      .map(([message]) => message)
      .find((message) => message.startsWith("client connected "));
    expect(remoteLine).toContain("conn=conn-locality-remote");
    expect(remoteLine).toContain("remote=203.0.113.50");
    expect(remoteLine).toContain("locality=remote");
  });
});
