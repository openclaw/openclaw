import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import { encodePngRgba } from "../media/png-encode.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.types.js";
import { createExecApprovalRecord } from "./exec-approval-registration.js";

const mocks = vi.hoisted(() => ({
  pairings: vi.fn(),
  subscriptions: vi.fn(),
  hasSubscriptions: vi.fn(),
  prepareSender: vi.fn(),
  send: vi.fn(),
  prepareDeliveries: vi.fn(),
  targets: vi.fn(),
  deleteTargets: vi.fn(),
  terminalIds: vi.fn(),
  preferences: vi.fn(),
  profiles: vi.fn(),
  rolePolicy: vi.fn(),
  visible: vi.fn(),
  approval: vi.fn(),
}));

vi.mock("../infra/device-pairing-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-worker.js")>()),
  withCurrentDevicePairingSnapshot: (async (_stateDir, prepare, preparePublication) => {
    const paired = mocks.pairings().paired;
    await preparePublication?.();
    return prepare(paired)?.start();
  }) satisfies typeof import("../infra/device-pairing-worker.js").withCurrentDevicePairingSnapshot,
}));

// mock-isolation: Use synthetic subscriptions and delivery receipts without external push or storage.
vi.mock("../infra/push-web.js", () => ({
  deleteWebPushApprovalDeliveryTargets: mocks.deleteTargets,
  withBoundWebPushSubscriptions: (async (stateDir, prepare) =>
    (
      await prepare(await mocks.subscriptions(stateDir), () => {})
    )?.start()) satisfies typeof import("../infra/push-web.js").withBoundWebPushSubscriptions,
  hasBoundWebPushSubscriptions: mocks.hasSubscriptions,
  listTerminalWebPushApprovalDeliveryIds: mocks.terminalIds,
  listWebPushApprovalDeliveryTargets: mocks.targets,
  prepareWebPushApprovalDeliveries: mocks.prepareDeliveries,
  prepareWebPushNotificationSender: mocks.prepareSender,
}));

vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  prepareUserProfileCatalog: mocks.profiles,
}));

vi.mock("../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-preferences.js")>()),
  getUserPreferenceValues: mocks.preferences,
}));

// mock-isolation: Approval routing uses synthetic session facts without opening session stores.
vi.mock("./session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: async () => ({
    prepareRead: () => undefined,
    readCurrent: () => ({ target: null, membership: new Set<string>() }),
    release: () => {},
  }),
}));

vi.mock("./operator-role-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operator-role-policy.js")>()),
  resolveOperatorRolePolicyForAssignment: mocks.rolePolicy,
}));

// mock-isolation: Control approval visibility without opening session and approval stores.
vi.mock("./server-methods/approval-record-lookup.js", () => ({
  canAccessApprovalSession: () => true,
  isApprovalRecordVisibleToClient: mocks.visible,
}));

vi.mock("./operator-approval-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operator-approval-store.js")>()),
  getOperatorApprovalDetailed: mocks.approval,
}));

function pairedOperator(deviceId: string, scopes = ["operator.approvals", "operator.read"]) {
  return {
    deviceId,
    publicKey: `public-${deviceId}`,
    role: "operator",
    roles: ["operator"],
    approvedScopes: scopes,
    createdAtMs: 1,
    approvedAtMs: 1,
    tokens: { operator: { token: `token-${deviceId}`, role: "operator", scopes, createdAtMs: 1 } },
  };
}

function bindSubscriptions(...subscriptions: BoundWebPushSubscription[]) {
  mocks.subscriptions.mockResolvedValue(subscriptions);
  mocks.pairings.mockReturnValue({
    pending: [],
    paired: subscriptions.map(({ deviceId }) => pairedOperator(deviceId)),
  });
}

function bindDevice(name: string) {
  const subscription = boundSubscription(`${name}-device`, `profile-${name}`);
  bindSubscriptions(subscription);
  return subscription;
}

const readOnlyPolicy = () => ({
  sessions: { others: "none" },
  agents: [],
  scopes: ["operator.read"],
});

function success(subscription: BoundWebPushSubscription) {
  return { ok: true, subscriptionId: subscription.subscriptionId, statusCode: 201 };
}

const expectSend = (expected: object) =>
  expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining(expected));

function deliveryOptions(TTL: number, topic = expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u)) {
  return { TTL, urgency: "high", timeout: 10_000, topic };
}

function notificationPayload(id: string) {
  return {
    renotify: false,
    tag: `openclaw-approval-${id}`,
    url: `approve/${encodeURIComponent(id)}`,
  };
}

function terminalPage(approvalIds: string[], throughApprovalId = approvalIds.at(-1) ?? null) {
  return { approvalIds, nextAfterApprovalId: null, throughApprovalId };
}

function createRecord(id: string, request: ExecApprovalRecord["request"] = { command: "echo ok" }) {
  return createExecApprovalRecord(request, 60_000, id);
}

async function createDelivery(getRuntimeConfig: () => OpenClawConfig = () => ({})) {
  const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
  return createApprovalWebPushDelivery({ getRuntimeConfig });
}

function boundSubscription(
  deviceId: string,
  userProfileId: string | null,
  preferences: Partial<BoundWebPushSubscription["devicePreferences"]> = {},
): BoundWebPushSubscription {
  return {
    subscriptionId: `subscription-${deviceId}-${userProfileId ?? "owner"}`,
    endpoint: `https://push.example.test/${deviceId}/${userProfileId ?? "owner"}`,
    keys: { p256dh: `p256dh-${deviceId}`, auth: `auth-${deviceId}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId,
    userProfileId,
    devicePreferences: { enabled: true, label: "", ...preferences },
  };
}

const approvalDeliveryTargets = new Map<string, Map<string, BoundWebPushSubscription>>();
type DeliveryPreparation = Parameters<
  typeof import("../infra/push-web.js").prepareWebPushApprovalDeliveries
>[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.pairings.mockReturnValue({ pending: [], paired: [] });
  mocks.subscriptions.mockResolvedValue([]);
  mocks.hasSubscriptions.mockResolvedValue(true);
  mocks.prepareSender.mockResolvedValue(mocks.send);
  mocks.send.mockResolvedValue([]);
  approvalDeliveryTargets.clear();
  mocks.prepareDeliveries.mockImplementation(
    async ({ approvalId, subscriptions }: DeliveryPreparation) => {
      approvalDeliveryTargets.set(
        approvalId,
        new Map(subscriptions.map((subscription) => [subscription.subscriptionId, subscription])),
      );
      return subscriptions.map((subscription) => subscription.subscriptionId);
    },
  );
  mocks.targets.mockImplementation(async ({ approvalId }) => [
    ...(approvalDeliveryTargets.get(approvalId)?.values() ?? []),
  ]);
  mocks.deleteTargets.mockImplementation(async ({ approvalId, subscriptionIds }) => {
    const targets = approvalDeliveryTargets.get(approvalId);
    for (const subscriptionId of subscriptionIds as string[]) {
      targets?.delete(subscriptionId);
    }
  });
  mocks.terminalIds.mockResolvedValue(terminalPage([]));
  mocks.profiles.mockResolvedValue({
    readCurrentIdentity: (profileId: string) => ({
      profileId,
      role: null,
      aliases: new Set([profileId]),
    }),
    release: () => {},
  });
  mocks.preferences.mockResolvedValue({ values: new Map(), isCurrent: () => true });
  mocks.rolePolicy.mockReturnValue(undefined);
  mocks.visible.mockImplementation(
    ({ record, client }) =>
      !record.requestedByDeviceId || record.requestedByDeviceId === client?.connect?.device?.id,
  );
  mocks.approval.mockReturnValue({
    outcome: "found",
    record: { reviewerDeviceIds: [], source: { agentId: null, sessionKey: null } },
  });
});

it.each(["identified", "private"] as const)(
  "preserves %s avatar privacy on approval request and replacement",
  async (detailLevel) => {
    const subscription = boundSubscription("avatar-device", null, { detailLevel });
    bindSubscriptions(subscription);
    mocks.send.mockResolvedValue([success(subscription)]);
    const avatar = `data:image/png;base64,${encodePngRgba(Buffer.from([255, 150, 0, 255]), 1, 1).toString("base64")}`;
    const delivery = await createDelivery(() => ({
      agents: { entries: { research: { identity: { avatar } } } },
    }));
    const record = createRecord("exec:avatar", {
      command: "echo avatar",
      agentId: "research",
    });

    expect(await delivery.handleRequested(record)).toBe(true);
    await delivery.handleResolved(record);

    expect(mocks.send).toHaveBeenCalledTimes(2);
    for (const [call] of mocks.send.mock.calls) {
      if (detailLevel === "identified") {
        expect(call.payload.icon).toMatch(/^data:image\/png;base64,/);
      } else {
        expect(call.payload).not.toHaveProperty("icon");
      }
    }
  },
);

it.each([true, false])(
  "sends only targets with committed receipts after bindings return (receipt committed: %s)",
  async (committed) => {
    const restored = boundSubscription("restored-device", null);
    const retained = boundSubscription("retained-device", null);
    bindSubscriptions(restored, retained);
    const receipts = createDeferred<string[]>();
    mocks.prepareDeliveries.mockReturnValueOnce(receipts.promise);
    mocks.send.mockImplementation(
      async ({ subscriptions }: { subscriptions: BoundWebPushSubscription[] }) =>
        subscriptions.map(success),
    );
    const record = createRecord("exec:committed-receipts", { command: "echo receipt" });
    const requested = (await createDelivery()).handleRequested(record);
    try {
      await vi.waitFor(() => expect(mocks.prepareDeliveries).toHaveBeenCalledOnce());
      expect(mocks.send).not.toHaveBeenCalled();
      receipts.resolve(committed ? [retained.subscriptionId] : []);
      await expect(requested).resolves.toBe(committed);
      if (committed) {
        expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ subscriptions: [retained] }),
        );
      } else {
        expect(mocks.send).not.toHaveBeenCalled();
      }
    } finally {
      receipts.resolve(committed ? [retained.subscriptionId] : []);
      await requested;
    }
  },
);

it("sends a generic approval link only to currently authorized visible bindings", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const record = createRecord("exec:approval.1", { command: "sensitive command" });
  record.requestedByDeviceId = "allowed-device";
  const allowed = boundSubscription("allowed-device", "profile-allowed");
  const wrongDevice = boundSubscription("wrong-device", "profile-allowed");
  const missingScope = boundSubscription("missing-scope", "profile-allowed");
  const staleScope = boundSubscription("stale-scope", "profile-allowed");
  const staleScopeDevice = pairedOperator("stale-scope");
  staleScopeDevice.approvedScopes = ["operator.read"];
  mocks.subscriptions.mockResolvedValue([allowed, wrongDevice, missingScope, staleScope]);
  mocks.pairings.mockReturnValue({
    pending: [],
    paired: [
      pairedOperator("allowed-device"),
      pairedOperator("wrong-device"),
      pairedOperator("missing-scope", ["operator.read"]),
      staleScopeDevice,
    ],
  });
  mocks.send.mockResolvedValue([success(allowed)]);

  const delivery = await createDelivery(() => ({
    gateway: {
      publicOrigin: "https://gateway.example.test",
      controlUi: { basePath: "/operator" },
    },
  }));
  const delivered = delivery.handleRequested(record);

  await expect(delivered).resolves.toBe(true);
  expect(mocks.send).toHaveBeenCalledWith({
    subscriptions: [allowed],
    payload: {
      ...notificationPayload(record.id),
      title: "OpenClaw approval requested",
      body: "Open OpenClaw to review this request.",
      url: "approve/exec%3Aapproval.1#gatewayUrl=wss%3A%2F%2Fgateway.example.test%2Foperator",
    },
    deliveryOptions: deliveryOptions(60),
  });
  expect(JSON.stringify(mocks.send.mock.calls)).not.toContain("sensitive command");
});

it("sanitizes identified approval labels without changing agent filters", async () => {
  const agentId = "agent\n\u202E";
  const record = createRecord("exec:labels", { command: "echo ok", agentId });
  const subscription = boundSubscription("browser-device", null, {
    label: "Phone\u202E",
    detailLevel: "identified",
    agentIds: [agentId],
  });
  bindSubscriptions(subscription);
  mocks.pairings.mockReturnValue({
    paired: [pairedOperator("browser-device", ["operator.admin"])],
  });
  mocks.send.mockResolvedValue([{ ok: true, subscriptionId: subscription.subscriptionId }]);
  await expect((await createDelivery()).handleRequested(record)).resolves.toBe(true);

  expectSend({
    payload: expect.objectContaining({
      title: "Phone\\u{202E} · OpenClaw approval requested",
      body: "Open OpenClaw to review an approval for agent\\u{A}\\u{202E}.",
    }),
  });
  expect(record.request.agentId).toBe(agentId);
});

it("requires a current role policy for each binding", async () => {
  const current = boundSubscription("current-device", "profile-current");
  bindSubscriptions(
    current,
    boundSubscription("missing-device", "profile-missing"),
    boundSubscription("unbound-device", null),
  );
  mocks.rolePolicy.mockImplementation((profileId: string) =>
    profileId === "profile-current"
      ? { ...readOnlyPolicy(), scopes: ["operator.approvals", "operator.read"] }
      : undefined,
  );
  mocks.send.mockResolvedValue([success(current)]);
  const delivery = await createDelivery(() => ({ gateway: { roles: { definitions: {} } } }));
  await expect(delivery.handleRequested(createRecord("exec:role-check"))).resolves.toBe(true);
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ subscriptions: [current] }),
  );
});

it.each([
  { change: "policy", phase: "transport" },
  { change: "resolved", phase: "transport" },
  { change: "expired", phase: "preferences" },
  { change: "ttl", phase: "transport" },
] as const)("rechecks $change after $phase preparation", async ({ change, phase }) => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const record = createRecord(`exec:${change}-during-preparation`);
  const current = bindDevice("current");
  if (change === "ttl") {
    mocks.send.mockResolvedValue([success(current)]);
  }
  let cfg: OpenClawConfig = {};
  const getRuntimeConfig = vi.fn(() => cfg);
  if (change === "policy") {
    mocks.rolePolicy.mockImplementation(
      (_id: string, _role: string | null, config: OpenClawConfig) =>
        config.gateway ? readOnlyPolicy() : undefined,
    );
  }
  const preparationStarted = createDeferred();
  const preparationReady = createDeferred();
  const prepare = phase === "transport" ? mocks.prepareSender : mocks.preferences;
  prepare.mockImplementationOnce(async () => {
    preparationStarted.resolve();
    await preparationReady.promise;
    return phase === "transport" ? mocks.send : { values: new Map(), isCurrent: () => true };
  });

  const delivery = (await createDelivery(getRuntimeConfig)).handleRequested(record);
  await preparationStarted.promise;
  if (change === "policy") {
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    cfg = { gateway: { roles: { definitions: {} } } };
  } else if (change === "resolved") {
    record.resolvedAtMs = Date.now();
    record.status = "denied";
  } else if (change === "expired") {
    record.expiresAtMs = Date.now() - 1;
  } else {
    vi.setSystemTime(31_000);
  }
  preparationReady.resolve();
  await expect(delivery).resolves.toBe(change === "ttl");
  if (change === "ttl") {
    expectSend({
      payload: expect.objectContaining({ url: `approve/${encodeURIComponent(record.id)}` }),
      deliveryOptions: deliveryOptions(30),
    });
  } else {
    if (change === "policy") {
      expect(getRuntimeConfig).toHaveBeenCalled();
    }
    expect(mocks.send).not.toHaveBeenCalled();
  }
});

it.each(["ambiguous", "successful"] as const)(
  "replaces %s requests, bypasses quiet hours and prunes definite failures",
  async (outcome) => {
    const record = createRecord(`exec:terminal-${outcome}`, { command: "sensitive command" });
    const retained = boundSubscription("retained-device", "profile-retained");
    const failures = [410, 503].map((code) => boundSubscription(`failed-${code}`, null));
    bindSubscriptions(retained, ...failures);
    mocks.send
      .mockResolvedValueOnce([
        outcome === "successful"
          ? success(retained)
          : { ok: false, subscriptionId: retained.subscriptionId, error: "timeout" },
        ...failures.map((subscription, index) => ({
          ok: false,
          subscriptionId: subscription.subscriptionId,
          statusCode: [410, 503][index],
        })),
      ])
      .mockResolvedValueOnce([success(retained)]);
    const delivery = await createDelivery();
    await expect(delivery.handleRequested(record)).resolves.toBe(true);
    const topic = mocks.send.mock.calls[0]?.[0]?.deliveryOptions.topic;
    expect(mocks.deleteTargets).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: record.id,
        subscriptionIds: failures.map((subscription) => subscription.subscriptionId),
      }),
    );
    retained.devicePreferences = {
      enabled: false,
      label: "",
      quietHours: { enabled: true, startMinute: 0, endMinute: 1439, timeZone: "UTC" },
    };
    await (outcome === "successful"
      ? delivery.handleExpired(record)
      : delivery.handleResolved(record));
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send).toHaveBeenNthCalledWith(2, {
      subscriptions: [retained],
      payload: {
        ...notificationPayload(record.id),
        title: "OpenClaw approval updated",
        body: "This approval is no longer pending.",
      },
      deliveryOptions: { ...deliveryOptions(300), topic },
    });
    expect(JSON.stringify(mocks.send.mock.calls[1])).not.toContain("sensitive command");
  },
);

it("drains terminal recovery beyond the first 1,024 approvals", async () => {
  const firstPage = Array.from(
    { length: 1_024 },
    (_, index) => `exec:terminal-${String(index).padStart(4, "0")}`,
  );
  const finalApprovalId = "exec:terminal-1024";
  mocks.terminalIds
    .mockResolvedValueOnce({
      approvalIds: firstPage,
      nextAfterApprovalId: firstPage.at(-1),
      throughApprovalId: finalApprovalId,
    })
    .mockResolvedValueOnce(terminalPage([finalApprovalId]));

  await (await createDelivery()).recoverTerminalDeliveries();

  expect(mocks.terminalIds).toHaveBeenNthCalledWith(1, {});
  expect(mocks.terminalIds).toHaveBeenNthCalledWith(2, {
    afterApprovalId: firstPage.at(-1),
    throughApprovalId: finalApprovalId,
  });
  expect(mocks.targets).toHaveBeenCalledTimes(1_025);
});

it.each([
  { restart: true, authority: "current" },
  { restart: true, authority: "revoked-device" },
  { restart: false, authority: "revoked-device" },
  { restart: false, authority: "tightened-policy" },
] as const)(
  "checks $authority before terminal delivery (restart=$restart)",
  async ({ restart, authority }) => {
    const record = createRecord("exec:terminal-authority", { command: "sensitive command" });
    const delivered = bindDevice("terminal");
    mocks.send.mockResolvedValueOnce([success(delivered)]);
    if (authority === "current") {
      mocks.send.mockResolvedValueOnce([success(delivered)]);
    }
    let cfg: OpenClawConfig = {};
    const delivery = await createDelivery(() => cfg);
    await expect(delivery.handleRequested(record)).resolves.toBe(true);
    if (authority === "revoked-device") {
      const active = pairedOperator(delivered.deviceId);
      mocks.pairings.mockReturnValue({
        pending: [],
        paired: [
          {
            ...active,
            tokens: { operator: { ...active.tokens.operator, revokedAtMs: Date.now() } },
          },
        ],
      });
    } else if (authority === "tightened-policy") {
      cfg = { gateway: { roles: { definitions: {} } } };
      mocks.rolePolicy.mockReturnValue(readOnlyPolicy());
    }
    if (restart) {
      mocks.terminalIds.mockResolvedValue(terminalPage([record.id]));
      await (await createDelivery(() => cfg)).recoverTerminalDeliveries();
    } else {
      await delivery.handleResolved(record);
    }
    expect(mocks.send).toHaveBeenCalledTimes(authority === "current" ? 2 : 1);
    if (authority === "current") {
      expect(mocks.send).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          subscriptions: [delivered],
          payload: expect.objectContaining({
            title: "OpenClaw approval updated",
            tag: `openclaw-approval-${record.id}`,
          }),
        }),
      );
      expect(approvalDeliveryTargets.get(record.id)?.size).toBe(0);
    }
  },
);
