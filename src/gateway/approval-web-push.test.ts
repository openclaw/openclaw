import { beforeEach, expect, it, vi, type TestContext } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import { encodePngRgba } from "../media/png-encode.js";
import { createTestApprovalManager } from "./exec-approval-manager.test-support.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.types.js";

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

function unregisteredRecord(id: string, request: ExecApprovalRecord["request"]) {
  const createdAtMs = Date.now();
  return { id, request, createdAtMs, expiresAtMs: createdAtMs + 60_000 };
}

function createRecord(context: TestContext, id: string, command = "echo ok") {
  return createTestApprovalManager<{ command: string }>(context).create({ command }, 60_000, id);
}

async function createDelivery(getRuntimeConfig: () => OpenClawConfig = () => ({})) {
  const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
  return createApprovalWebPushDelivery({ getRuntimeConfig });
}

function boundSubscription(
  deviceId: string,
  userProfileId: string | null,
): BoundWebPushSubscription {
  return {
    subscriptionId: `subscription-${deviceId}-${userProfileId ?? "owner"}`,
    endpoint: `https://push.example.test/${deviceId}/${userProfileId ?? "owner"}`,
    keys: { p256dh: `p256dh-${deviceId}`, auth: `auth-${deviceId}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId,
    userProfileId,
    devicePreferences: { enabled: true, label: "" },
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
    const subscription = boundSubscription("avatar-device", null);
    subscription.devicePreferences.detailLevel = detailLevel;
    bindSubscriptions(subscription);
    mocks.send.mockResolvedValue([success(subscription)]);
    const avatar = `data:image/png;base64,${encodePngRgba(Buffer.from([255, 150, 0, 255]), 1, 1).toString("base64")}`;
    const delivery = await createDelivery(() => ({
      agents: { entries: { research: { identity: { avatar } } } },
    }));
    const record = unregisteredRecord("exec:avatar", {
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
    const record = unregisteredRecord("exec:committed-receipts", { command: "echo receipt" });
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

it("sends a generic approval link only to currently authorized visible bindings", async (testContext) => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const record = createRecord(testContext, "exec:approval.1", "sensitive command");
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

it("sanitizes identified approval labels without changing agent filters", async (testContext) => {
  const agentId = "agent\n\u202E";
  const record = createTestApprovalManager(testContext).create(
    { command: "echo ok", agentId },
    60_000,
  );
  const subscription = boundSubscription("browser-device", null);
  subscription.devicePreferences = {
    enabled: true,
    label: "Phone\u202E",
    detailLevel: "identified",
    agentIds: [agentId],
  };
  mocks.subscriptions.mockResolvedValue([subscription]);
  mocks.pairings.mockReturnValue({
    paired: [pairedOperator("browser-device", ["operator.admin"])],
  });
  mocks.send.mockResolvedValue([{ ok: true, subscriptionId: subscription.subscriptionId }]);
  await expect((await createDelivery()).handleRequested(record)).resolves.toBe(true);

  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        title: "Phone\\u{202E} · OpenClaw approval requested",
        body: "Open OpenClaw to review an approval for agent\\u{A}\\u{202E}.",
      }),
    }),
  );
  expect(record.request.agentId).toBe(agentId);
});

it("rechecks the profile role and excludes unbound role-based subscriptions", async (testContext) => {
  const record = createRecord(testContext, "exec:role-check");
  const current = boundSubscription("current-device", "profile-current");
  const downgraded = boundSubscription("downgraded-device", "profile-downgraded");
  const missingPolicy = boundSubscription("missing-policy-device", "profile-missing");
  const unboundProfile = boundSubscription("unbound-profile-device", null);
  bindSubscriptions(current, downgraded, missingPolicy, unboundProfile);
  mocks.rolePolicy.mockImplementation((profileId: string) =>
    profileId === "profile-missing"
      ? undefined
      : {
          ...readOnlyPolicy(),
          scopes:
            profileId === "profile-current"
              ? ["operator.approvals", "operator.read"]
              : ["operator.read"],
        },
  );
  mocks.visible.mockImplementation(
    ({ client }) =>
      client?.authenticatedUserProfile?.profileId === "profile-current" ||
      client?.authenticatedUserProfile?.profileId === "profile-missing",
  );
  mocks.send.mockResolvedValue([success(current)]);

  const delivery = await createDelivery(() => ({ gateway: { roles: { definitions: {} } } }));
  await expect(delivery.handleRequested(record)).resolves.toBe(true);

  expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ subscriptions: [current] }));
});

it("reads runtime role policy after transport preparation", async (testContext) => {
  const record = createRecord(testContext, "exec:config-race");
  bindDevice("current");
  const preparation = createDeferred<typeof mocks.send>();
  mocks.prepareSender.mockReturnValue(preparation.promise);
  const tightenedConfig = { gateway: { roles: { definitions: {} } } };
  let runtimeConfig: typeof tightenedConfig | Record<string, never> = {};
  const getRuntimeConfig = vi.fn(() => runtimeConfig);
  mocks.rolePolicy.mockImplementation(
    (
      _profileId: string,
      _role: string | null,
      cfg: typeof tightenedConfig | Record<string, never>,
    ) => ("gateway" in cfg ? readOnlyPolicy() : undefined),
  );
  const delivery = await createDelivery(getRuntimeConfig);

  const requested = delivery.handleRequested(record);
  expect(getRuntimeConfig).not.toHaveBeenCalled();
  runtimeConfig = tightenedConfig;
  preparation.resolve(mocks.send);

  await expect(requested).resolves.toBe(false);
  expect(getRuntimeConfig).toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it.for([
  { terminalState: "resolved", phase: "transport" },
  { terminalState: "expired", phase: "preferences" },
] as const)(
  "does not send after the approval becomes $terminalState during $phase preparation",
  async ({ terminalState, phase }, testContext) => {
    const record = createRecord(testContext, `exec:${terminalState}-during-preparation`);
    bindDevice("current");
    const preparationStarted = createDeferred();
    const preparationReady = createDeferred();
    const prepare = phase === "transport" ? mocks.prepareSender : mocks.preferences;
    prepare.mockImplementationOnce(async () => {
      preparationStarted.resolve();
      await preparationReady.promise;
      return phase === "transport" ? mocks.send : { values: new Map(), isCurrent: () => true };
    });

    const delivery = (await createDelivery()).handleRequested(record);
    await preparationStarted.promise;
    if (terminalState === "resolved") {
      record.resolvedAtMs = Date.now();
      record.status = "denied";
    } else {
      record.expiresAtMs = Date.now() - 1;
    }
    preparationReady.resolve();

    await expect(delivery).resolves.toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  },
);

it("recomputes the remaining TTL after transport preparation", async (testContext) => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const record = createRecord(testContext, "exec:ttl-after-preparation");
  const current = bindDevice("current");
  mocks.send.mockResolvedValue([success(current)]);
  const preparation = createDeferred<typeof mocks.send>();
  mocks.prepareSender.mockReturnValueOnce(preparation.promise);

  const delivery = (await createDelivery()).handleRequested(record);
  await vi.waitFor(() => expect(mocks.prepareSender).toHaveBeenCalledOnce());
  vi.setSystemTime(31_000);
  preparation.resolve(mocks.send);

  await expect(delivery).resolves.toBe(true);
  expect(mocks.send).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        url: "approve/exec%3Attl-after-preparation",
      }),
      deliveryOptions: deliveryOptions(30),
    }),
  );
});

it("retains ambiguous request targets for terminal replacement and prunes definite failures", async (testContext) => {
  const record = createRecord(testContext, "exec:ambiguous-request");
  const ambiguous = boundSubscription("ambiguous-device", "profile-ambiguous");
  const gone = boundSubscription("gone-device", "profile-gone");
  const rejected = boundSubscription("rejected-device", "profile-rejected");
  bindSubscriptions(ambiguous, gone, rejected);
  mocks.send
    .mockResolvedValueOnce([
      { ok: false, subscriptionId: ambiguous.subscriptionId, error: "timeout" },
      { ok: false, subscriptionId: gone.subscriptionId, statusCode: 410, error: "gone" },
      { ok: false, subscriptionId: rejected.subscriptionId, statusCode: 503, error: "busy" },
    ])
    .mockResolvedValueOnce([success(ambiguous)]);

  const delivery = await createDelivery();

  await expect(delivery.handleRequested(record)).resolves.toBe(true);
  await delivery.handleResolved({ id: record.id });

  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(mocks.send.mock.calls[1]?.[0]).toMatchObject({
    subscriptions: [ambiguous],
    payload: { title: "OpenClaw approval updated" },
  });
  expect(mocks.deleteTargets).toHaveBeenCalledWith(
    expect.objectContaining({
      approvalId: record.id,
      subscriptionIds: [gone.subscriptionId, rejected.subscriptionId],
    }),
  );
});

it("replaces successful request alerts after the approval becomes expired", async (testContext) => {
  const record = createRecord(testContext, "exec:terminal-expired", "sensitive command");
  const delivered = boundSubscription("delivered-device", "profile-delivered");
  const failed = boundSubscription("failed-device", "profile-failed");
  bindSubscriptions(delivered, failed);
  mocks.send
    .mockResolvedValueOnce([
      success(delivered),
      { ok: false, subscriptionId: failed.subscriptionId, statusCode: 410 },
    ])
    .mockResolvedValueOnce([success(delivered)]);

  const delivery = await createDelivery();
  await expect(delivery.handleRequested(record)).resolves.toBe(true);
  const requestOptions = mocks.send.mock.calls[0]?.[0]?.deliveryOptions;

  delivered.devicePreferences = {
    enabled: false,
    label: "",
    quietHours: {
      enabled: true,
      startMinute: 0,
      endMinute: 1439,
      timeZone: "UTC",
    },
  };

  await delivery.handleExpired({ id: record.id });

  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(mocks.send).toHaveBeenNthCalledWith(2, {
    subscriptions: [delivered],
    payload: {
      ...notificationPayload(record.id),
      title: "OpenClaw approval updated",
      body: "This approval is no longer pending.",
    },
    deliveryOptions: { ...deliveryOptions(300), topic: requestOptions?.topic },
  });
  expect(JSON.stringify(mocks.send.mock.calls[1])).not.toContain("sensitive command");
});

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

it("recovers a terminal replacement from durable targets after process restart", async (testContext) => {
  const record = createRecord(testContext, "exec:restart-terminal", "sensitive command");
  const delivered = bindDevice("delivered");
  mocks.send
    .mockResolvedValueOnce([success(delivered)])
    .mockResolvedValueOnce([success(delivered)]);

  const firstProcess = await createDelivery();
  await expect(firstProcess.handleRequested(record)).resolves.toBe(true);

  mocks.terminalIds.mockResolvedValue(terminalPage([record.id]));
  const restartedProcess = await createDelivery();
  await restartedProcess.recoverTerminalDeliveries();

  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(mocks.send).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      subscriptions: [delivered],
      payload: expect.objectContaining({
        title: "OpenClaw approval updated",
        tag: "openclaw-approval-" + record.id,
      }),
    }),
  );
  expect(approvalDeliveryTargets.get(record.id)?.size).toBe(0);
});

it.for(["same-process", "restart"] as const)(
  "does not send a terminal approval link after device authority is revoked in %s delivery",
  async (mode, testContext) => {
    const record = createRecord(testContext, `exec:revoked-terminal-${mode}`, "sensitive command");
    const delivered = boundSubscription("revoked-device", "profile-revoked");
    const active = pairedOperator("revoked-device");
    const revoked = {
      ...active,
      tokens: { operator: { ...active.tokens.operator, revokedAtMs: Date.now() } },
    };
    mocks.subscriptions.mockResolvedValue([delivered]);
    mocks.pairings.mockReturnValue({ pending: [], paired: [active] });
    mocks.send.mockResolvedValueOnce([success(delivered)]);

    const firstProcess = await createDelivery();
    await expect(firstProcess.handleRequested(record)).resolves.toBe(true);
    mocks.pairings.mockReturnValue({ pending: [], paired: [revoked] });

    if (mode === "restart") {
      mocks.terminalIds.mockResolvedValue(terminalPage([record.id]));
      const restartedProcess = await createDelivery();
      await restartedProcess.recoverTerminalDeliveries();
    } else {
      await firstProcess.handleResolved({ id: record.id });
    }

    expect(mocks.pairings).toHaveBeenCalledTimes(3);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  },
);

it("does not send a terminal approval link after profile policy is tightened", async (testContext) => {
  const record = createRecord(testContext, "exec:tightened-terminal-policy", "sensitive command");
  const delivered = bindDevice("policy");
  mocks.send.mockResolvedValueOnce([success(delivered)]);
  const tightenedConfig = { gateway: { roles: { definitions: {} } } };
  const getRuntimeConfig = vi.fn().mockReturnValue({});

  const delivery = await createDelivery(getRuntimeConfig);
  await expect(delivery.handleRequested(record)).resolves.toBe(true);
  getRuntimeConfig.mockReturnValue(tightenedConfig);
  mocks.rolePolicy.mockReturnValue(readOnlyPolicy());
  await delivery.handleResolved({ id: record.id });

  expect(mocks.rolePolicy).toHaveBeenLastCalledWith("profile-policy", null, tightenedConfig, null);
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
