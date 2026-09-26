import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import { createTestApprovalManager } from "./exec-approval-manager.test-support.js";
import type { ExecApprovalRecord } from "./exec-approval-manager.types.js";

const listDevicePairingMock = vi.fn();
const listBoundWebPushSubscriptionsMock = vi.fn();
const hasBoundWebPushSubscriptionsMock = vi.fn();
const prepareWebPushNotificationSenderMock = vi.fn();
const preparedWebPushSendMock = vi.fn();
const prepareWebPushApprovalDeliveriesMock = vi.fn();
const listWebPushApprovalDeliveryTargetsMock = vi.fn();
const deleteWebPushApprovalDeliveryTargetsMock = vi.fn();
const listTerminalWebPushApprovalDeliveryIdsMock = vi.fn();
const getUserPreferenceValuesMock = vi.fn();
const prepareUserProfileCatalogMock = vi.fn();
const resolveOperatorRolePolicyForAssignmentMock = vi.fn();
const isApprovalRecordVisibleToClientMock = vi.fn();
const getOperatorApprovalDetailedMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/device-pairing.js")>(
    "../infra/device-pairing.js",
  );
  return actual;
});

vi.mock("../infra/device-pairing-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-worker.js")>()),
  withCurrentDevicePairingSnapshot: async <T>(
    _stateDir: string | undefined,
    prepare: (
      paired: import("../infra/device-pairing.types.js").PairedDevice[],
    ) => { start: () => T } | undefined,
  ) => prepare(listDevicePairingMock().paired)?.start(),
}));

vi.mock("../infra/push-web.js", () => ({
  deleteWebPushApprovalDeliveryTargets: deleteWebPushApprovalDeliveryTargetsMock,
  withBoundWebPushSubscriptions: async <T>(
    stateDir: string | undefined,
    prepare: (
      subscriptions: BoundWebPushSubscription[],
      assertCurrent: () => void,
    ) => { start: () => T } | undefined | Promise<{ start: () => T } | undefined>,
  ) => (await prepare(await listBoundWebPushSubscriptionsMock(stateDir), () => {}))?.start(),
  hasBoundWebPushSubscriptions: hasBoundWebPushSubscriptionsMock,
  listTerminalWebPushApprovalDeliveryIds: listTerminalWebPushApprovalDeliveryIdsMock,
  listWebPushApprovalDeliveryTargets: listWebPushApprovalDeliveryTargetsMock,
  prepareWebPushApprovalDeliveries: prepareWebPushApprovalDeliveriesMock,
  prepareWebPushNotificationSender: prepareWebPushNotificationSenderMock,
}));

vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  prepareUserProfileCatalog: prepareUserProfileCatalogMock,
}));

vi.mock("../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-preferences.js")>()),
  getUserPreferenceValues: getUserPreferenceValuesMock,
}));

vi.mock("./session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: async () => ({
    readCurrent: () => ({ target: null, membership: new Set<string>() }),
    release: () => {},
  }),
}));

vi.mock("./operator-role-policy.js", async () => {
  const actual = await vi.importActual<typeof import("./operator-role-policy.js")>(
    "./operator-role-policy.js",
  );
  return {
    ...actual,
    resolveOperatorRolePolicyForAssignment: resolveOperatorRolePolicyForAssignmentMock,
  };
});

vi.mock("./server-methods/approval-record-lookup.js", () => ({
  canAccessApprovalSession: () => true,
  isApprovalRecordVisibleToClient: isApprovalRecordVisibleToClientMock,
}));

vi.mock("./operator-approval-store.js", async () => {
  const actual = await vi.importActual<typeof import("./operator-approval-store.js")>(
    "./operator-approval-store.js",
  );
  return { ...actual, getOperatorApprovalDetailed: getOperatorApprovalDetailedMock };
});

function pairedOperator(deviceId: string, scopes: string[]) {
  return {
    deviceId,
    publicKey: `public-${deviceId}`,
    role: "operator",
    roles: ["operator"],
    approvedScopes: scopes,
    createdAtMs: 1,
    approvedAtMs: 1,
    tokens: {
      operator: {
        token: `token-${deviceId}`,
        role: "operator",
        scopes,
        createdAtMs: 1,
      },
    },
  };
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

describe("approval Web Push delivery", () => {
  const approvalDeliveryTargets = new Map<
    string,
    Map<string, ReturnType<typeof boundSubscription>>
  >();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    listDevicePairingMock.mockReturnValue({ pending: [], paired: [] });
    listBoundWebPushSubscriptionsMock.mockResolvedValue([]);
    hasBoundWebPushSubscriptionsMock.mockResolvedValue(true);
    prepareWebPushNotificationSenderMock.mockResolvedValue(preparedWebPushSendMock);
    preparedWebPushSendMock.mockResolvedValue([]);
    approvalDeliveryTargets.clear();
    prepareWebPushApprovalDeliveriesMock.mockImplementation(
      async ({ approvalId, subscriptions }) => {
        approvalDeliveryTargets.set(
          approvalId,
          new Map(
            (subscriptions as ReturnType<typeof boundSubscription>[]).map((subscription) => [
              subscription.subscriptionId,
              subscription,
            ]),
          ),
        );
        return (subscriptions as BoundWebPushSubscription[]).map(
          (subscription) => subscription.subscriptionId,
        );
      },
    );
    listWebPushApprovalDeliveryTargetsMock.mockImplementation(async ({ approvalId }) => [
      ...(approvalDeliveryTargets.get(approvalId)?.values() ?? []),
    ]);
    deleteWebPushApprovalDeliveryTargetsMock.mockImplementation(
      async ({ approvalId, subscriptionIds }) => {
        const targets = approvalDeliveryTargets.get(approvalId);
        for (const subscriptionId of subscriptionIds as string[]) {
          targets?.delete(subscriptionId);
        }
      },
    );
    listTerminalWebPushApprovalDeliveryIdsMock.mockResolvedValue({
      approvalIds: [],
      nextAfterApprovalId: null,
      throughApprovalId: null,
    });
    prepareUserProfileCatalogMock.mockResolvedValue({
      readCurrentIdentity: (profileId: string) => ({
        profileId,
        role: null,
        aliases: new Set([profileId]),
      }),
      release: () => {},
    });
    getUserPreferenceValuesMock.mockResolvedValue({ values: new Map(), isCurrent: () => true });
    resolveOperatorRolePolicyForAssignmentMock.mockReturnValue(undefined);
    isApprovalRecordVisibleToClientMock.mockImplementation(
      ({ record, client }) =>
        !record.requestedByDeviceId || record.requestedByDeviceId === client?.connect?.device?.id,
    );
    getOperatorApprovalDetailedMock.mockReturnValue({
      outcome: "found",
      record: {
        reviewerDeviceIds: [],
        source: { agentId: null, sessionKey: null },
      },
    });
  });

  it.each([true, false])(
    "sends only targets with committed receipts after bindings return (receipt committed: %s)",
    async (committed) => {
      const restored = boundSubscription("restored-device", null);
      const retained = boundSubscription("retained-device", null);
      listBoundWebPushSubscriptionsMock.mockResolvedValue([restored, retained]);
      listDevicePairingMock.mockReturnValue({
        paired: [
          pairedOperator("restored-device", ["operator.approvals", "operator.read"]),
          pairedOperator("retained-device", ["operator.approvals", "operator.read"]),
        ],
      });
      const receipts = createDeferred<string[]>();
      prepareWebPushApprovalDeliveriesMock.mockReturnValueOnce(receipts.promise);
      preparedWebPushSendMock.mockImplementation(
        async ({ subscriptions }: { subscriptions: BoundWebPushSubscription[] }) =>
          subscriptions.map(({ subscriptionId }) => ({
            ok: true,
            subscriptionId,
            statusCode: 201,
          })),
      );
      const now = Date.now();
      const record: ExecApprovalRecord = {
        id: "exec:committed-receipts",
        request: { command: "echo receipt" },
        createdAtMs: now,
        expiresAtMs: now + 60_000,
      };
      const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
      const requested = createApprovalWebPushDelivery({
        getRuntimeConfig: () => ({}),
      }).handleRequested(record);
      try {
        await vi.waitFor(() => expect(prepareWebPushApprovalDeliveriesMock).toHaveBeenCalledOnce());
        expect(preparedWebPushSendMock).not.toHaveBeenCalled();
        receipts.resolve(committed ? [retained.subscriptionId] : []);
        await expect(requested).resolves.toBe(committed);
        if (committed) {
          expect(preparedWebPushSendMock).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ subscriptions: [retained] }),
          );
        } else {
          expect(preparedWebPushSendMock).not.toHaveBeenCalled();
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
    const manager = createTestApprovalManager(testContext);
    const record = manager.create({ command: "sensitive command" }, 60_000, "exec:approval.1");
    record.requestedByDeviceId = "allowed-device";
    const allowed = boundSubscription("allowed-device", "profile-allowed");
    const wrongDevice = boundSubscription("wrong-device", "profile-allowed");
    const missingScope = boundSubscription("missing-scope", "profile-allowed");
    const staleScope = boundSubscription("stale-scope", "profile-allowed");
    const staleScopeDevice = pairedOperator("stale-scope", ["operator.approvals", "operator.read"]);
    staleScopeDevice.approvedScopes = ["operator.read"];
    listBoundWebPushSubscriptionsMock.mockResolvedValue([
      allowed,
      wrongDevice,
      missingScope,
      staleScope,
    ]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [
        pairedOperator("allowed-device", ["operator.approvals", "operator.read"]),
        pairedOperator("wrong-device", ["operator.approvals", "operator.read"]),
        pairedOperator("missing-scope", ["operator.read"]),
        staleScopeDevice,
      ],
    });
    preparedWebPushSendMock.mockResolvedValue([
      { ok: true, subscriptionId: allowed.subscriptionId, statusCode: 201 },
    ]);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({
      getRuntimeConfig: () => ({
        gateway: {
          publicOrigin: "https://gateway.example.test",
          controlUi: { basePath: "/operator" },
        },
      }),
    });
    const delivered = delivery.handleRequested(record);

    await expect(delivered).resolves.toBe(true);
    expect(preparedWebPushSendMock).toHaveBeenCalledWith({
      subscriptions: [allowed],
      payload: {
        title: "OpenClaw approval requested",
        body: "Open OpenClaw to review this request.",
        renotify: false,
        tag: "openclaw-approval-exec:approval.1",
        url: "approve/exec%3Aapproval.1#gatewayUrl=wss%3A%2F%2Fgateway.example.test%2Foperator",
      },
      deliveryOptions: {
        TTL: 60,
        urgency: "high",
        timeout: 10_000,
        topic: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u),
      },
    });
    expect(JSON.stringify(preparedWebPushSendMock.mock.calls)).not.toContain("sensitive command");
  });

  it.for([
    { detailLevel: "identified" as const, agentId: "agent\n\u202E", label: "agent\\u{A}\\u{202E}" },
    { detailLevel: "detailed" as const, agentId: "🦞".repeat(50), label: "🦞".repeat(40) },
  ])(
    "bounds and sanitizes $detailLevel approval labels without changing agent filters",
    async ({ detailLevel, agentId, label }, testContext) => {
      const record = createTestApprovalManager(testContext).create(
        { command: "echo ok", agentId },
        60_000,
      );
      const subscription = boundSubscription("browser-device", null);
      subscription.devicePreferences = {
        enabled: true,
        label: "Phone\u202E",
        detailLevel,
        agentIds: [agentId],
      };
      listBoundWebPushSubscriptionsMock.mockResolvedValue([subscription]);
      listDevicePairingMock.mockReturnValue({
        paired: [pairedOperator("browser-device", ["operator.admin"])],
      });
      preparedWebPushSendMock.mockResolvedValue([
        { ok: true, subscriptionId: subscription.subscriptionId },
      ]);
      const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");

      await expect(
        createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleRequested(record),
      ).resolves.toBe(true);

      expect(preparedWebPushSendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            title: "Phone\\u{202E} · OpenClaw approval requested",
            body: `Open OpenClaw to review an approval for ${label}.`,
          }),
        }),
      );
      expect(record.request.agentId).toBe(agentId);
    },
  );

  it("rechecks the profile role and excludes unbound role-based subscriptions", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create({ command: "echo ok" }, 60_000, "exec:role-check");
    const current = boundSubscription("current-device", "profile-current");
    const downgraded = boundSubscription("downgraded-device", "profile-downgraded");
    const missingPolicy = boundSubscription("missing-policy-device", "profile-missing");
    const unboundProfile = boundSubscription("unbound-profile-device", null);
    listBoundWebPushSubscriptionsMock.mockResolvedValue([
      current,
      downgraded,
      missingPolicy,
      unboundProfile,
    ]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [
        pairedOperator("current-device", ["operator.approvals", "operator.read"]),
        pairedOperator("downgraded-device", ["operator.approvals", "operator.read"]),
        pairedOperator("missing-policy-device", ["operator.approvals", "operator.read"]),
        pairedOperator("unbound-profile-device", ["operator.approvals", "operator.read"]),
      ],
    });
    resolveOperatorRolePolicyForAssignmentMock.mockImplementation((profileId: string) =>
      profileId === "profile-missing"
        ? undefined
        : {
            sessions: { others: "none" },
            agents: [],
            scopes:
              profileId === "profile-current"
                ? ["operator.approvals", "operator.read"]
                : ["operator.read"],
          },
    );
    isApprovalRecordVisibleToClientMock.mockImplementation(
      ({ client }) =>
        client?.authenticatedUserProfile?.profileId === "profile-current" ||
        client?.authenticatedUserProfile?.profileId === "profile-missing",
    );
    preparedWebPushSendMock.mockResolvedValue([
      { ok: true, subscriptionId: current.subscriptionId, statusCode: 201 },
    ]);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({
      getRuntimeConfig: () => ({
        gateway: {
          roles: {
            definitions: {},
          },
        },
      }),
    });
    await expect(delivery.handleRequested(record)).resolves.toBe(true);

    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptions: [current] }),
    );
  });

  it.for([
    {
      label: "device admin and granular profile",
      tokenScopes: ["operator.admin"],
      profileScopes: ["operator.read", "operator.approvals"],
    },
    {
      label: "granular device and profile admin",
      tokenScopes: ["operator.read", "operator.approvals"],
      profileScopes: ["operator.admin"],
    },
  ])("honors implied scopes across $label", async ({ tokenScopes, profileScopes }, testContext) => {
    const record = createTestApprovalManager(testContext).create(
      { command: "echo ok" },
      60_000,
      "exec:implied-role-scopes",
    );
    const current = boundSubscription("current-device", "profile-current");
    listBoundWebPushSubscriptionsMock.mockResolvedValue([current]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("current-device", tokenScopes)],
    });
    resolveOperatorRolePolicyForAssignmentMock.mockReturnValue({
      sessions: { others: "none" },
      agents: [],
      scopes: profileScopes,
    });
    isApprovalRecordVisibleToClientMock.mockReturnValue(true);
    preparedWebPushSendMock.mockResolvedValue([
      { ok: true, subscriptionId: current.subscriptionId, statusCode: 201 },
    ]);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({
      getRuntimeConfig: () => ({ gateway: { roles: { definitions: {} } } }),
    });

    await expect(delivery.handleRequested(record)).resolves.toBe(true);
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptions: [current] }),
    );
  });

  it("prepares the transport before rereading current approval authority", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create({ command: "echo ok" }, 60_000, "exec:authority-race");
    const current = boundSubscription("current-device", "profile-current");
    listBoundWebPushSubscriptionsMock.mockResolvedValue([current]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("current-device", ["operator.approvals", "operator.read"])],
    });
    preparedWebPushSendMock.mockResolvedValue([
      { ok: true, subscriptionId: current.subscriptionId, statusCode: 201 },
    ]);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
    await expect(delivery.handleRequested(record)).resolves.toBe(true);

    expect(prepareWebPushNotificationSenderMock).toHaveBeenCalledOnce();
    expect(
      expectDefined(
        prepareWebPushNotificationSenderMock.mock.invocationCallOrder[0],
        "transport preparation call order",
      ),
    ).toBeLessThan(
      expectDefined(listDevicePairingMock.mock.invocationCallOrder[0], "pairing read call order"),
    );
    expect(listBoundWebPushSubscriptionsMock).toHaveBeenCalledTimes(2);
    expect(
      expectDefined(
        prepareWebPushNotificationSenderMock.mock.invocationCallOrder[0],
        "transport preparation call order",
      ),
    ).toBeLessThan(
      expectDefined(
        listBoundWebPushSubscriptionsMock.mock.invocationCallOrder[0],
        "subscription read call order",
      ),
    );
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptions: [current] }),
    );
  });

  it("reads runtime role policy after transport preparation", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create({ command: "echo ok" }, 60_000, "exec:config-race");
    const current = boundSubscription("current-device", "profile-current");
    const preparation = createDeferred<typeof preparedWebPushSendMock>();
    prepareWebPushNotificationSenderMock.mockReturnValue(preparation.promise);
    listBoundWebPushSubscriptionsMock.mockResolvedValue([current]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("current-device", ["operator.approvals", "operator.read"])],
    });
    const tightenedConfig = { gateway: { roles: { definitions: {} } } };
    let runtimeConfig: typeof tightenedConfig | Record<string, never> = {};
    const getRuntimeConfig = vi.fn(() => runtimeConfig);
    resolveOperatorRolePolicyForAssignmentMock.mockImplementation(
      (
        _profileId: string,
        _role: string | null,
        cfg: typeof tightenedConfig | Record<string, never>,
      ) =>
        "gateway" in cfg
          ? { sessions: { others: "none" }, agents: [], scopes: ["operator.read"] }
          : undefined,
    );
    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({ getRuntimeConfig });

    const requested = delivery.handleRequested(record);
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    runtimeConfig = tightenedConfig;
    preparation.resolve(preparedWebPushSendMock);

    await expect(requested).resolves.toBe(false);
    expect(getRuntimeConfig).toHaveBeenCalled();
    expect(preparedWebPushSendMock).not.toHaveBeenCalled();
  });

  it.for([
    { terminalState: "resolved", phase: "transport" },
    { terminalState: "expired", phase: "transport" },
    { terminalState: "resolved", phase: "preferences" },
    { terminalState: "expired", phase: "preferences" },
  ] as const)(
    "does not send after the approval becomes $terminalState during $phase preparation",
    async ({ terminalState, phase }, testContext) => {
      const manager = createTestApprovalManager(testContext);
      const record = manager.create(
        { command: "echo ok" },
        60_000,
        `exec:${terminalState}-during-preparation`,
      );
      const current = boundSubscription("current-device", "profile-current");
      listBoundWebPushSubscriptionsMock.mockResolvedValue([current]);
      listDevicePairingMock.mockReturnValue({
        pending: [],
        paired: [pairedOperator("current-device", ["operator.approvals", "operator.read"])],
      });
      const preparationStarted = createDeferred();
      const preparationReady = createDeferred();
      const waitForPreparation = async () => {
        preparationStarted.resolve();
        await preparationReady.promise;
      };
      if (phase === "transport") {
        prepareWebPushNotificationSenderMock.mockImplementationOnce(async () => {
          await waitForPreparation();
          return preparedWebPushSendMock;
        });
      } else {
        getUserPreferenceValuesMock.mockImplementationOnce(async () => {
          await waitForPreparation();
          return { values: new Map(), isCurrent: () => true };
        });
      }

      const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
      const webPushDelivery = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
      const delivery = webPushDelivery.handleRequested(record);
      await preparationStarted.promise;
      if (terminalState === "resolved") {
        record.resolvedAtMs = Date.now();
        record.status = "denied";
      } else {
        record.expiresAtMs = Date.now() - 1;
      }
      preparationReady.resolve();

      await expect(delivery).resolves.toBe(false);
      expect(preparedWebPushSendMock).not.toHaveBeenCalled();
    },
  );

  it("recomputes the remaining TTL after transport preparation", async (testContext) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const manager = createTestApprovalManager(testContext);
    const record = manager.create({ command: "echo ok" }, 60_000, "exec:ttl-after-preparation");
    const current = boundSubscription("current-device", "profile-current");
    listBoundWebPushSubscriptionsMock.mockResolvedValue([current]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("current-device", ["operator.approvals", "operator.read"])],
    });
    preparedWebPushSendMock.mockResolvedValue([
      { ok: true, subscriptionId: current.subscriptionId, statusCode: 201 },
    ]);
    let finishPreparation: ((sender: typeof preparedWebPushSendMock) => void) | undefined;
    prepareWebPushNotificationSenderMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finishPreparation = resolve;
      }),
    );

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const webPushDelivery = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
    const delivery = webPushDelivery.handleRequested(record);
    await vi.waitFor(() => expect(prepareWebPushNotificationSenderMock).toHaveBeenCalledOnce());
    vi.setSystemTime(31_000);
    expectDefined(finishPreparation, "transport preparation resolver")(preparedWebPushSendMock);

    await expect(delivery).resolves.toBe(true);
    expect(preparedWebPushSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          url: "approve/exec%3Attl-after-preparation",
        }),
        deliveryOptions: {
          TTL: 30,
          urgency: "high",
          timeout: 10_000,
          topic: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u),
        },
      }),
    );
  });

  it("retains ambiguous request targets for terminal replacement and prunes definite failures", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create({ command: "echo ok" }, 60_000, "exec:ambiguous-request");
    const ambiguous = boundSubscription("ambiguous-device", "profile-ambiguous");
    const gone = boundSubscription("gone-device", "profile-gone");
    const rejected = boundSubscription("rejected-device", "profile-rejected");
    listBoundWebPushSubscriptionsMock.mockResolvedValue([ambiguous, gone, rejected]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [
        pairedOperator("ambiguous-device", ["operator.approvals", "operator.read"]),
        pairedOperator("gone-device", ["operator.approvals", "operator.read"]),
        pairedOperator("rejected-device", ["operator.approvals", "operator.read"]),
      ],
    });
    preparedWebPushSendMock
      .mockResolvedValueOnce([
        { ok: false, subscriptionId: ambiguous.subscriptionId, error: "timeout" },
        { ok: false, subscriptionId: gone.subscriptionId, statusCode: 410, error: "gone" },
        { ok: false, subscriptionId: rejected.subscriptionId, statusCode: 503, error: "busy" },
      ])
      .mockResolvedValueOnce([
        { ok: true, subscriptionId: ambiguous.subscriptionId, statusCode: 201 },
      ]);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });

    await expect(delivery.handleRequested(record)).resolves.toBe(true);
    await delivery.handleResolved({ id: record.id });

    expect(preparedWebPushSendMock).toHaveBeenCalledTimes(2);
    expect(preparedWebPushSendMock.mock.calls[1]?.[0]).toMatchObject({
      subscriptions: [ambiguous],
      payload: { title: "OpenClaw approval updated" },
    });
    expect(deleteWebPushApprovalDeliveryTargetsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: record.id,
        subscriptionIds: [gone.subscriptionId, rejected.subscriptionId],
      }),
    );
  });

  it.for(["resolved", "expired"] as const)(
    "replaces successful request alerts after the approval becomes %s",
    async (terminalState, testContext) => {
      const manager = createTestApprovalManager(testContext);
      const record = manager.create(
        { command: "sensitive command" },
        60_000,
        `exec:terminal-${terminalState}`,
      );
      const delivered = boundSubscription("delivered-device", "profile-delivered");
      const failed = boundSubscription("failed-device", "profile-failed");
      listBoundWebPushSubscriptionsMock.mockResolvedValue([delivered, failed]);
      listDevicePairingMock.mockReturnValue({
        pending: [],
        paired: [
          pairedOperator("delivered-device", ["operator.approvals", "operator.read"]),
          pairedOperator("failed-device", ["operator.approvals", "operator.read"]),
        ],
      });
      preparedWebPushSendMock
        .mockResolvedValueOnce([
          { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
          { ok: false, subscriptionId: failed.subscriptionId, statusCode: 410 },
        ])
        .mockResolvedValueOnce([
          { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
        ]);

      const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
      const delivery = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
      await expect(delivery.handleRequested(record)).resolves.toBe(true);
      const requestOptions = preparedWebPushSendMock.mock.calls[0]?.[0]?.deliveryOptions;

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

      if (terminalState === "resolved") {
        await delivery.handleResolved({ id: record.id });
      } else {
        await delivery.handleExpired({ id: record.id });
      }

      expect(preparedWebPushSendMock).toHaveBeenCalledTimes(2);
      expect(preparedWebPushSendMock).toHaveBeenNthCalledWith(2, {
        subscriptions: [delivered],
        payload: {
          title: "OpenClaw approval updated",
          body: "This approval is no longer pending.",
          renotify: false,
          tag: `openclaw-approval-${record.id}`,
          url: `approve/${encodeURIComponent(record.id)}`,
        },
        deliveryOptions: {
          TTL: 300,
          urgency: "high",
          timeout: 10_000,
          topic: requestOptions?.topic,
        },
      });
      expect(JSON.stringify(preparedWebPushSendMock.mock.calls[1])).not.toContain(
        "sensitive command",
      );
    },
  );

  it("drains terminal recovery beyond the first 1,024 approvals", async () => {
    const firstPage = Array.from(
      { length: 1_024 },
      (_, index) => `exec:terminal-${String(index).padStart(4, "0")}`,
    );
    const finalApprovalId = "exec:terminal-1024";
    listTerminalWebPushApprovalDeliveryIdsMock
      .mockResolvedValueOnce({
        approvalIds: firstPage,
        nextAfterApprovalId: firstPage.at(-1),
        throughApprovalId: finalApprovalId,
      })
      .mockResolvedValueOnce({
        approvalIds: [finalApprovalId],
        nextAfterApprovalId: null,
        throughApprovalId: finalApprovalId,
      });

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    await createApprovalWebPushDelivery({
      getRuntimeConfig: () => ({}),
    }).recoverTerminalDeliveries();

    expect(listTerminalWebPushApprovalDeliveryIdsMock).toHaveBeenNthCalledWith(1, {});
    expect(listTerminalWebPushApprovalDeliveryIdsMock).toHaveBeenNthCalledWith(2, {
      afterApprovalId: firstPage.at(-1),
      throughApprovalId: finalApprovalId,
    });
    expect(listWebPushApprovalDeliveryTargetsMock).toHaveBeenCalledTimes(1_025);
  });

  it("recovers a terminal replacement from durable targets after process restart", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create(
      { command: "sensitive command" },
      60_000,
      "exec:restart-terminal",
    );
    const delivered = boundSubscription("delivered-device", "profile-delivered");
    listBoundWebPushSubscriptionsMock.mockResolvedValue([delivered]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("delivered-device", ["operator.approvals", "operator.read"])],
    });
    preparedWebPushSendMock
      .mockResolvedValueOnce([
        { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
      ])
      .mockResolvedValueOnce([
        { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
      ]);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const firstProcess = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
    await expect(firstProcess.handleRequested(record)).resolves.toBe(true);

    listTerminalWebPushApprovalDeliveryIdsMock.mockResolvedValue({
      approvalIds: [record.id],
      nextAfterApprovalId: null,
      throughApprovalId: record.id,
    });
    const restartedProcess = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
    await restartedProcess.recoverTerminalDeliveries();

    expect(preparedWebPushSendMock).toHaveBeenCalledTimes(2);
    expect(preparedWebPushSendMock).toHaveBeenNthCalledWith(
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
    "does not send a terminal approval link to a rebound subscription after %s resolution",
    async (mode, testContext) => {
      const manager = createTestApprovalManager(testContext);
      const record = manager.create(
        { command: "sensitive command" },
        60_000,
        `exec:rebound-terminal-${mode}`,
      );
      const original = boundSubscription("original-device", "profile-original");
      listBoundWebPushSubscriptionsMock.mockResolvedValue([original]);
      listDevicePairingMock.mockReturnValue({
        pending: [],
        paired: [pairedOperator("original-device", ["operator.approvals", "operator.read"])],
      });
      preparedWebPushSendMock.mockResolvedValueOnce([
        { ok: true, subscriptionId: original.subscriptionId, statusCode: 201 },
      ]);

      const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
      const firstProcess = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
      await expect(firstProcess.handleRequested(record)).resolves.toBe(true);

      // The durable store retains the original binding but the mutable
      // subscription row now belongs to someone else, so it returns no target.
      listWebPushApprovalDeliveryTargetsMock.mockResolvedValue([]);
      if (mode === "restart") {
        listTerminalWebPushApprovalDeliveryIdsMock.mockResolvedValue({
          approvalIds: [record.id],
          nextAfterApprovalId: null,
          throughApprovalId: record.id,
        });
        const restartedProcess = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
        await restartedProcess.recoverTerminalDeliveries();
      } else {
        await firstProcess.handleResolved({ id: record.id });
      }

      expect(preparedWebPushSendMock).toHaveBeenCalledTimes(1);
    },
  );

  it.for(["same-process", "restart"] as const)(
    "does not send a terminal approval link after device authority is revoked in %s delivery",
    async (mode, testContext) => {
      const manager = createTestApprovalManager(testContext);
      const record = manager.create(
        { command: "sensitive command" },
        60_000,
        `exec:revoked-terminal-${mode}`,
      );
      const delivered = boundSubscription("revoked-device", "profile-revoked");
      const active = pairedOperator("revoked-device", ["operator.approvals", "operator.read"]);
      const revoked = {
        ...active,
        tokens: {
          operator: { ...active.tokens.operator, revokedAtMs: Date.now() },
        },
      };
      listBoundWebPushSubscriptionsMock.mockResolvedValue([delivered]);
      listDevicePairingMock.mockReturnValue({ pending: [], paired: [active] });
      preparedWebPushSendMock.mockResolvedValueOnce([
        { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
      ]);

      const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
      const firstProcess = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
      await expect(firstProcess.handleRequested(record)).resolves.toBe(true);
      listDevicePairingMock.mockReturnValue({ pending: [], paired: [revoked] });

      if (mode === "restart") {
        listTerminalWebPushApprovalDeliveryIdsMock.mockResolvedValue({
          approvalIds: [record.id],
          nextAfterApprovalId: null,
          throughApprovalId: record.id,
        });
        const restartedProcess = createApprovalWebPushDelivery({ getRuntimeConfig: () => ({}) });
        await restartedProcess.recoverTerminalDeliveries();
      } else {
        await firstProcess.handleResolved({ id: record.id });
      }

      expect(listDevicePairingMock).toHaveBeenCalledTimes(3);
      expect(preparedWebPushSendMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not send a terminal approval link after profile policy is tightened", async (testContext) => {
    const manager = createTestApprovalManager(testContext);
    const record = manager.create(
      { command: "sensitive command" },
      60_000,
      "exec:tightened-terminal-policy",
    );
    const delivered = boundSubscription("policy-device", "profile-policy");
    listBoundWebPushSubscriptionsMock.mockResolvedValue([delivered]);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("policy-device", ["operator.approvals", "operator.read"])],
    });
    resolveOperatorRolePolicyForAssignmentMock.mockReturnValue(undefined);
    preparedWebPushSendMock.mockResolvedValueOnce([
      { ok: true, subscriptionId: delivered.subscriptionId, statusCode: 201 },
    ]);
    const initialConfig = {};
    const tightenedConfig = { gateway: { roles: { definitions: {} } } };
    const getRuntimeConfig = vi.fn().mockReturnValue(initialConfig);

    const { createApprovalWebPushDelivery } = await import("./approval-web-push.js");
    const delivery = createApprovalWebPushDelivery({ getRuntimeConfig });
    await expect(delivery.handleRequested(record)).resolves.toBe(true);
    getRuntimeConfig.mockReturnValue(tightenedConfig);
    resolveOperatorRolePolicyForAssignmentMock.mockReturnValue({
      sessions: { others: "none" },
      agents: [],
      scopes: ["operator.read"],
    });
    await delivery.handleResolved({ id: record.id });

    expect(resolveOperatorRolePolicyForAssignmentMock).toHaveBeenLastCalledWith(
      "profile-policy",
      null,
      tightenedConfig,
    );
    expect(preparedWebPushSendMock).toHaveBeenCalledTimes(1);
  });
});
