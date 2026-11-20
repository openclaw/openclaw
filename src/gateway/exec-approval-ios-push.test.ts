import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import type { UserProfileIdentity } from "../state/user-profiles.types.js";
import {
  createExecApprovalIosPushDelivery,
  createPluginApprovalIosPushDelivery,
} from "./exec-approval-ios-push.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.js";
import { setDeviceTokenBindingOwner } from "./openclaw-id/device-token-binding.js";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
} from "./openclaw-id/tunnel-principal.js";
import type { OperatorScope } from "./operator-scopes.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-target.types.js";

const mocks = vi.hoisted(() => ({
  pairing: vi.fn(),
  registrations: vi.fn(),
  directAuth: vi.fn(),
  relayConfig: vi.fn(),
  execAlert: vi.fn(),
  execWake: vi.fn(),
  pluginAlert: vi.fn(),
  pluginWake: vi.fn(),
  linkedProfiles: vi.fn(),
  profiles: vi.fn(),
  sessionFacts: vi.fn(),
}));

const registrationDefaults = {
  topic: "ai.openclaw.ios.test",
  environment: "sandbox",
  updatedAtMs: 1,
};
const directAuthConfig = { teamId: "team", keyId: "key", privateKey: "private-key" };

function apnsRegistration(nodeId = "ios-device-1") {
  return { nodeId, transport: "direct", token: "apns-token", ...registrationDefaults };
}

function relayApnsRegistration(nodeId = "ios-device-1") {
  return {
    ...registrationDefaults,
    nodeId,
    transport: "relay",
    relayHandle: `relay-${nodeId}`,
    sendGrant: `grant-${nodeId}`,
    installationId: `installation-${nodeId}`,
    distribution: "official",
    relayOrigin: "https://relay.example.test",
  };
}

function successfulApnsPushResult() {
  return { ok: true, status: 200 };
}

function approvalRequest(id: string): ExecApprovalRecord {
  return {
    id,
    request: { command: "echo ok", host: "gateway", allowedDecisions: ["allow-once"] },
    createdAtMs: 1,
    expiresAtMs: 2,
  };
}

function pluginApprovalRequest(id: string): PluginApprovalRequest {
  return {
    id,
    request: {
      title: "Install plugin update",
      description: "Allow the plugin to update its managed package.",
      detail: '{"package":"@openclaw/example","token":"review-only"}',
    },
    createdAtMs: 1,
    expiresAtMs: 2,
  };
}

const approvalScopes: OperatorScope[] = ["operator.approvals", "operator.read"];

function pairedIosOperator(
  scopes = approvalScopes,
  deviceId = "ios-device-1",
  approvedScopes?: string[],
) {
  return {
    deviceId,
    platform: "iOS 18",
    role: "operator",
    roles: ["operator"],
    approvedScopes,
    tokens: {
      operator: { token: "operator-token", role: "operator", scopes, createdAtMs: 1 },
    },
  };
}

function mockPairedIosOperators(...paired: ReturnType<typeof pairedIosOperator>[]) {
  mocks.pairing.mockResolvedValue({ pending: [], paired });
}

function mockPairedIosOperator(scopes = approvalScopes) {
  mockPairedIosOperators(pairedIosOperator(scopes));
}

function mockIdMemberIosDevice() {
  const peerKey = `iroh:${"a".repeat(64)}`;
  setDeviceTokenBindingOwner({
    lookup: (deviceId) => (deviceId === "id-ios" ? peerKey : undefined),
    record: async () => {},
    forget: async () => {},
    reportMismatch: () => {},
  });
  setOpenClawIdTunnelPrincipalLookup(() => ({
    kind: "member",
    peerKey,
    accountId: "member-account",
    role: "member",
  }));
  setOpenClawIdMemberAccountLookup((accountId) => accountId === "member-account");
  mocks.linkedProfiles.mockResolvedValue({
    "member-account": { id: "member-profile", displayName: null, email: null },
  });
  const profile: UserProfileIdentity = {
    profileId: "member-profile",
    role: "member",
    openclawIdAccountIds: ["member-account"],
    aliases: new Set(["member-profile", "member-profile-alias"]),
  };
  mocks.profiles.mockResolvedValue({
    readCurrentIdentity: (profileId: string) =>
      profile.aliases.has(profileId) ? profile : undefined,
    release: () => {},
  });
}

async function expectRejectedRequest(id: string) {
  const delivery = createExecApprovalIosPushDelivery({ log: {} });
  expect(await delivery.handleRequested(approvalRequest(id))).toBe(false);
  expect(mocks.registrations).not.toHaveBeenCalled();
  expect(mocks.execAlert).not.toHaveBeenCalled();
}

function expectPluginAlert(expected: Record<string, unknown>) {
  expect(mocks.pluginAlert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(expected));
}

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => getRuntimeConfigSnapshot() ?? { gateway: {} },
}));

vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  prepareUserProfileCatalog: mocks.profiles,
}));

vi.mock("../state/user-profile-openclaw-id.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-openclaw-id.js")>()),
  readOpenClawIdUserProfiles: mocks.linkedProfiles,
}));

// mock-isolation: Supply committed profile/session facts without opening stores; retain real policy.
vi.mock("./session-sharing-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing-preparation.js")>()),
  prepareSessionMutationFacts: mocks.sessionFacts,
}));

vi.mock("../infra/device-pairing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing.js")>()),
  listDevicePairing: mocks.pairing,
}));

vi.mock("../infra/device-pairing-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-worker.js")>()),
  withCurrentDevicePairingSnapshot: (async (_stateDir, prepare, preparePublication) => {
    const { paired } = await mocks.pairing();
    await preparePublication?.();
    return prepare(paired)?.start();
  }) satisfies typeof import("../infra/device-pairing-worker.js").withCurrentDevicePairingSnapshot,
}));

vi.mock("../infra/device-identity-async.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-identity-async.js")>()),
  loadOrCreateProcessDeviceIdentityAsync: () => ({ deviceId: "gateway-device-1" }),
}));

// mock-isolation: Exercise approval routing with synthetic APNs registrations and no network delivery.
vi.mock("../infra/push-apns.js", () => ({
  loadApnsRegistrations: mocks.registrations,
  resolveApnsAuthConfigFromEnv: mocks.directAuth,
  resolveApnsRelayConfigFromEnv: mocks.relayConfig,
  sendApnsExecApprovalAlert: mocks.execAlert,
  sendApnsExecApprovalResolvedWake: mocks.execWake,
  sendApnsPluginApprovalAlert: mocks.pluginAlert,
  sendApnsPluginApprovalResolvedWake: mocks.pluginWake,
  clearApnsRegistrationIfCurrent: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

describe("createExecApprovalIosPushDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pairing.mockResolvedValue({ pending: [], paired: [] });
    mocks.registrations.mockImplementation(async (nodeIds: readonly string[]) =>
      nodeIds.map((nodeId) => ({ nodeId, registration: apnsRegistration(nodeId) })),
    );
    mocks.directAuth.mockResolvedValue({ ok: true, value: directAuthConfig });
    mocks.relayConfig.mockReturnValue({ ok: false, error: "unused" });
    mocks.execAlert.mockResolvedValue(successfulApnsPushResult());
    mocks.execWake.mockResolvedValue(successfulApnsPushResult());
    mocks.pluginAlert.mockResolvedValue(successfulApnsPushResult());
    mocks.pluginWake.mockResolvedValue(successfulApnsPushResult());
    mocks.linkedProfiles.mockResolvedValue({});
    mocks.profiles.mockReset();
    mocks.sessionFacts.mockReset();
  });

  it("does not target iOS devices whose active operator token lacks operator.approvals", async () => {
    mockPairedIosOperators(pairedIosOperator(["operator.read"], undefined, ["operator.approvals"]));

    await expectRejectedRequest("approval-1");
  });

  it("does not target approval-only iOS devices that cannot validate gateway ownership", async () => {
    mockPairedIosOperator(["operator.approvals"]);

    await expectRejectedRequest("approval-no-read");
  });

  it("does not target iOS devices outside the request's reviewer binding", async () => {
    mockPairedIosOperator();
    const delivery = createExecApprovalIosPushDelivery({ log: {} });
    expect(
      await delivery.handleRequested({
        ...approvalRequest("approval-filtered"),
        requestedByDeviceId: "other-requester",
        approvalReviewerDeviceIds: ["other-reviewer"],
      }),
    ).toBe(false);
    expect(mocks.execAlert).not.toHaveBeenCalled();
  });

  it("does not treat iOS as a live approval route when every push fails", async () => {
    const warn = vi.fn();
    mockPairedIosOperator();
    mocks.execAlert.mockResolvedValue({
      ...successfulApnsPushResult(),
      ok: false,
      status: 410,
      reason: "Unregistered",
    });

    const delivery = createExecApprovalIosPushDelivery({ log: { warn } });

    expect(await delivery.handleRequested(approvalRequest("approval-dead-route"))).toBe(false);
    expect(mocks.execAlert).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "exec approvals: iOS request push failed node=ios-device-1 status=410 reason=Unregistered",
    );
    expect(warn).toHaveBeenCalledWith(
      "exec approvals: iOS request push reached no devices approvalId=approval-dead-route attempted=1",
    );
  });

  it("waits for request delivery to finish before sending cleanup pushes", async () => {
    mockPairedIosOperator();
    const requestedPush = createDeferred<ReturnType<typeof successfulApnsPushResult>>();
    mocks.execAlert.mockReturnValue(requestedPush.promise);

    const delivery = createExecApprovalIosPushDelivery({ log: {} });

    const requested = delivery.handleRequested(approvalRequest("approval-ordered-cleanup"));
    const resolved = delivery.handleResolved({ id: "approval-ordered-cleanup" });

    await Promise.resolve();
    expect(mocks.execWake).not.toHaveBeenCalled();

    requestedPush.resolve(successfulApnsPushResult());
    await requested;
    await resolved;

    expect(mocks.execWake).toHaveBeenCalledTimes(1);
    expect(mocks.registrations).toHaveBeenLastCalledWith(["ios-device-1"]);
  });

  it("skips cleanup pushes when the original request target set is unknown", async () => {
    const debug = vi.fn();
    const delivery = createExecApprovalIosPushDelivery({ log: { debug } });

    await delivery.handleResolved({ id: "approval-missing-targets" });

    expect(debug).toHaveBeenCalledWith(
      "exec approvals: iOS cleanup push skipped approvalId=approval-missing-targets reason=missing-targets",
    );
    expect(mocks.pairing).not.toHaveBeenCalled();
    expect(mocks.registrations).not.toHaveBeenCalled();
    expect(mocks.execWake).not.toHaveBeenCalled();
  });

  afterEach(() => {
    setDeviceTokenBindingOwner(undefined);
    setOpenClawIdTunnelPrincipalLookup(undefined);
    setOpenClawIdMemberAccountLookup(undefined);
    clearRuntimeConfigSnapshot();
  });

  it("caps an ID device's fresh approval pushes without reducing independent local grants", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        openclawId: { enabled: true },
        roles: {
          definitions: {
            member: { scopes: ["operator.admin"], sessions: { others: "write" }, agents: "*" },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    mockIdMemberIosDevice();
    mockPairedIosOperators(
      pairedIosOperator(["operator.admin"], "id-ios"),
      pairedIosOperator(["operator.admin"], "local-ios"),
    );
    const delivery = createPluginApprovalIosPushDelivery({ log: {} });
    expect(await delivery.handleRequested(pluginApprovalRequest("plugin:before"))).toBe(true);
    expect(mocks.pluginAlert.mock.calls.map(([p]) => p.nodeId)).toEqual(["id-ios", "local-ios"]);
    mocks.pluginAlert.mockClear();
    mocks.profiles.mockResolvedValueOnce({
      readCurrentIdentity: () => undefined,
      release: () => {},
    });
    expect(await delivery.handleRequested(pluginApprovalRequest("plugin:missing-profile"))).toBe(
      true,
    );
    expect(mocks.pluginAlert.mock.calls.map(([p]) => p.nodeId)).toEqual(["local-ios"]);
    mocks.pluginAlert.mockClear();
    cfg.gateway!.roles!.definitions!.member = {
      scopes: ["operator.read"],
      sessions: { others: "none" },
      agents: "*",
    };
    setRuntimeConfigSnapshot(cfg);
    expect(await delivery.handleRequested(pluginApprovalRequest("plugin:after"))).toBe(true);
    expect(mocks.pluginAlert.mock.calls.map(([p]) => p.nodeId)).toEqual(["local-ios"]);
  });

  it("rechecks ID policy after APNs preparation while preserving local delivery and cleanup", async () => {
    const cfg: OpenClawConfig = {
      gateway: {
        openclawId: { enabled: true },
        roles: {
          definitions: {
            member: { scopes: approvalScopes, sessions: { others: "write" }, agents: "*" },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    mockIdMemberIosDevice();
    mockPairedIosOperators(
      pairedIosOperator(approvalScopes, "id-ios"),
      pairedIosOperator(approvalScopes, "local-ios"),
    );
    const authStarted = createDeferred();
    const authReady = createDeferred();
    mocks.directAuth.mockImplementationOnce(async () => {
      authStarted.resolve();
      await authReady.promise;
      return { ok: true, value: directAuthConfig };
    });
    const sent: string[] = [];
    mocks.execAlert.mockImplementation(
      async (
        push: Parameters<typeof import("../infra/push-apns.js").sendApnsExecApprovalAlert>[0],
      ) => {
        if (push.isCurrent && !(await push.isCurrent())) {
          return { ok: false, status: 0, reason: "stale-authority" };
        }
        sent.push(push.nodeId);
        return successfulApnsPushResult();
      },
    );
    const delivery = createExecApprovalIosPushDelivery({ log: {} });
    const request = approvalRequest("approval-policy-during-auth");
    const requested = delivery.handleRequested(request);
    try {
      await authStarted.promise;
      expect(mocks.execAlert).not.toHaveBeenCalled();
      cfg.gateway!.roles!.definitions!.member = {
        scopes: ["operator.read"],
        sessions: { others: "none" },
        agents: "*",
      };
      setRuntimeConfigSnapshot(cfg);
      authReady.resolve();
      expect(await requested).toBe(true);
      expect(sent).toEqual(["local-ios"]);

      await delivery.handleResolved({ id: request.id });
      expect(mocks.execWake.mock.calls.map(([push]) => push.nodeId)).toEqual([
        "id-ios",
        "local-ios",
      ]);
    } finally {
      authReady.resolve();
      await requested;
    }
  });

  it.each([
    {
      audience: "creator alias",
      creatorId: "member-profile-alias",
      withSession: true,
      visible: true,
    },
    { audience: "another profile", creatorId: "other-profile", withSession: true, visible: false },
    { audience: "missing source", creatorId: "other-profile", withSession: false, visible: false },
  ])(
    "uses the ID session ceiling for a $audience approval despite a linked admin role",
    async ({ creatorId, withSession, visible }) => {
      setRuntimeConfigSnapshot({
        gateway: {
          openclawId: { enabled: true },
          roles: {
            definitions: {
              member: { scopes: approvalScopes, sessions: { others: "none" }, agents: "*" },
            },
          },
        },
      });
      mockIdMemberIosDevice();
      mockPairedIosOperators(pairedIosOperator(approvalScopes, "id-ios"));
      const sessionKey = "agent:main:approval-source";
      const facts: PreparedSessionMutationFacts = {
        target: {
          agentId: "main",
          canonicalKey: sessionKey,
          storeKey: sessionKey,
          storeKeys: [sessionKey],
          storePath: "/synthetic/sessions.sqlite",
          entry: {
            sessionId: "approval-source",
            updatedAt: 1,
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: creatorId },
          },
        },
        membership: new Set(),
      };
      mocks.sessionFacts.mockResolvedValue({
        storageTarget: {
          agentId: "main",
          canonicalKey: sessionKey,
          storePath: "/synthetic/sessions.sqlite",
        },
        bindCreation: () => {},
        prepareRead: () => undefined,
        readCurrent: () => facts,
        release: () => {},
      } satisfies import("./session-sharing-preparation.js").SessionFactsRead<PreparedSessionMutationFacts>);
      const request = approvalRequest("approval-session-policy");
      request.requestedByDeviceId = "other-requester";
      request.approvalReviewerDeviceIds = ["id-ios"];
      if (withSession) {
        request.request.sessionKey = sessionKey;
        request.request.agentId = "main";
      }
      expect(await createExecApprovalIosPushDelivery({ log: {} }).handleRequested(request)).toBe(
        visible,
      );
      expect(mocks.execAlert.mock.calls.map(([push]) => push.nodeId)).toEqual(
        visible ? ["id-ios"] : [],
      );
    },
  );

  describe("createPluginApprovalIosPushDelivery", () => {
    it("targets only paired iOS operators with approval and read scopes", async () => {
      mockPairedIosOperators(
        pairedIosOperator(approvalScopes, "ios-approved"),
        pairedIosOperator(["operator.read"], "ios-read-only"),
      );

      const delivery = createPluginApprovalIosPushDelivery({ log: {} });
      const accepted = await delivery.handleRequested(pluginApprovalRequest("plugin:direct"));

      expect(accepted).toBe(true);
      expect(mocks.registrations).toHaveBeenCalledWith(["ios-approved"]);
      expectPluginAlert({
        nodeId: "ios-approved",
        approvalId: "plugin:direct",
        gatewayDeviceId: "gateway-device-1",
        title: "Install plugin update",
        description: "Allow the plugin to update its managed package.",
      });
      expect(mocks.pluginAlert.mock.calls[0]?.[0]).not.toHaveProperty("detail");
    });

    it("uses the shared relay delivery plan for plugin alerts", async () => {
      const relayConfig = { baseUrl: "https://relay.example.test", timeoutMs: 10_000 };
      mockPairedIosOperator();
      mocks.registrations.mockResolvedValue([
        { nodeId: "ios-device-1", registration: relayApnsRegistration() },
      ]);
      mocks.relayConfig.mockReturnValue({ ok: true, value: relayConfig });

      const delivery = createPluginApprovalIosPushDelivery({ log: {} });
      const accepted = await delivery.handleRequested(pluginApprovalRequest("plugin:relay"));

      expect(accepted).toBe(true);
      expectPluginAlert({
        registration: expect.objectContaining({ transport: "relay" }),
        relayConfig,
        approvalId: "plugin:relay",
      });
      expect(mocks.directAuth).not.toHaveBeenCalled();
    });

    it("sends plugin cleanup wakes for resolved and expired requests", async () => {
      mockPairedIosOperator();
      const delivery = createPluginApprovalIosPushDelivery({ log: {} });
      const resolvedRequest = pluginApprovalRequest("plugin:resolved");
      const expiredRequest = pluginApprovalRequest("plugin:expired");

      await delivery.handleRequested(resolvedRequest);
      await delivery.handleRequested(expiredRequest);
      await delivery.handleResolved({ id: resolvedRequest.id });
      await delivery.handleExpired(expiredRequest);

      expect(mocks.pluginWake.mock.calls).toEqual([
        [expect.objectContaining({ approvalId: "plugin:resolved" })],
        [expect.objectContaining({ approvalId: "plugin:expired" })],
      ]);
    });
  });
});
