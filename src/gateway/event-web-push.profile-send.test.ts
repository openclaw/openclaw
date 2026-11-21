import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";

const mocks = vi.hoisted(() => ({
  pairing: vi.fn(),
  profiles: vi.fn(),
  subscriptions: vi.fn(),
  hasSubscriptions: vi.fn(),
  sender: vi.fn(),
  send: vi.fn(),
  identity: vi.fn(),
  preferences: vi.fn(),
  prepareAttempts: 1,
}));

vi.mock("../infra/device-pairing-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-worker.js")>()),
  withCurrentDevicePairingSnapshot: (async (_stateDir, prepare, preparePublication) => {
    if (preparePublication) {
      await preparePublication();
    }
    // Simulates an owner that discards earlier preparations for a fresher snapshot.
    for (let attempt = 1; attempt < mocks.prepareAttempts; attempt += 1) {
      prepare(mocks.pairing());
    }
    return prepare(mocks.pairing())?.start();
  }) satisfies typeof import("../infra/device-pairing-worker.js").withCurrentDevicePairingSnapshot,
}));

// mock-isolation: Control subscription snapshots and send results without network delivery.
vi.mock("../infra/push-web.js", () => ({
  withBoundWebPushSubscriptions: (async (stateDir, prepare) =>
    await (
      await prepare(await mocks.subscriptions(stateDir), () => {})
    )?.start()) satisfies typeof import("../infra/push-web.js").withBoundWebPushSubscriptions,
  hasBoundWebPushSubscriptions: mocks.hasSubscriptions,
  prepareWebPushNotificationSender: mocks.sender,
}));

vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  prepareUserProfileCatalog: mocks.profiles,
}));

vi.mock("../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-preferences.js")>()),
  getUserPreferenceValues: mocks.preferences,
}));

const { sendProfileWebPush } = await import("./event-web-push.js");

function makeSubscription(
  id: string,
  profileId: string | null = null,
  preferences: Partial<BoundWebPushSubscription["devicePreferences"]> = {},
): BoundWebPushSubscription {
  return {
    subscriptionId: `subscription-${id}`,
    endpoint: `https://push.example.test/${id}`,
    keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId: id,
    userProfileId: profileId,
    devicePreferences: {
      enabled: true,
      label: "",
      detailLevel: "identified",
      categories: {
        agentFinished: true,
        agentQuestion: true,
        humanMentioned: true,
        scheduledTaskFailed: true,
      },
      ...preferences,
    },
  };
}

function pairedOperator(deviceId: string, scopes = ["operator.read"], revokedAtMs?: number) {
  const operator = { role: "operator", scopes, revokedAtMs };
  return { deviceId, roles: ["operator"], approvedScopes: scopes, tokens: { operator } };
}

const gatewayConfig = (): OpenClawConfig => ({
  gateway: { publicOrigin: "https://gateway.example.test", controlUi: { basePath: "/operator" } },
});

function profileIdentity(profileId: string, aliases = [profileId]) {
  return { profileId, role: null, aliases: new Set(aliases) };
}

const setSubscriptions = (...subscriptions: BoundWebPushSubscription[]) =>
  mocks.subscriptions.mockResolvedValue(subscriptions);
const setPaired = (...paired: ReturnType<typeof pairedOperator>[]) =>
  mocks.pairing.mockReturnValue(paired);

function setRecipients(...subscriptions: BoundWebPushSubscription[]) {
  setSubscriptions(...subscriptions);
  setPaired(...subscriptions.map(({ deviceId }) => pairedOperator(deviceId)));
}

const expectSend = (expected: object) =>
  expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining(expected));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepareAttempts = 1;
  mocks.hasSubscriptions.mockResolvedValue(true);
  mocks.sender.mockResolvedValue(mocks.send);
  mocks.profiles.mockResolvedValue({ readCurrentIdentity: mocks.identity, release: () => {} });
  mocks.identity.mockImplementation(profileIdentity);
  mocks.preferences.mockResolvedValue({ values: new Map(), isCurrent: () => true });
});

describe("profile-targeted send", () => {
  const sendToBob = (params: Partial<Parameters<typeof sendProfileWebPush>[1]> = {}) =>
    sendProfileWebPush(gatewayConfig, {
      profileId: "bob",
      category: "agent-finished",
      ...params,
    });
  const okResults = () =>
    mocks.send.mockImplementation(
      async ({ subscriptions }: { subscriptions: BoundWebPushSubscription[] }) =>
        subscriptions.map((subscription) => ({
          ok: true,
          subscriptionId: subscription.subscriptionId,
          statusCode: 201,
        })),
    );

  beforeEach(() => {
    okResults();
  });

  it("sends only to the recipient's canonical subscriptions, including merged profiles", async () => {
    const bob = makeSubscription("bob-browser", "bob");
    const mergedBob = makeSubscription("bob-phone", "bob-old");
    setRecipients(
      makeSubscription("alice-browser", "alice"),
      bob,
      mergedBob,
      makeSubscription("anonymous-browser"),
    );
    mocks.identity.mockImplementation((id: string) =>
      profileIdentity(id === "bob-old" ? "bob" : id, [id]),
    );

    await expect(
      sendProfileWebPush(gatewayConfig, { profileId: "bob-old", category: "agent-finished" }),
    ).resolves.toEqual({
      sent: 2,
      failed: 0,
      skipped: 0,
      pruned: 0,
    });
    expect(mocks.send).toHaveBeenCalledOnce();
    expectSend({ subscriptions: [bob, mergedBob] });
  });

  it("does not send to a recipient's revoked browser", async () => {
    const active = makeSubscription("bob-browser", "bob");
    const revoked = makeSubscription("bob-revoked", "bob");
    setSubscriptions(active, revoked);
    setPaired(pairedOperator(active.deviceId), pairedOperator(revoked.deviceId, undefined, 1));

    await expect(sendToBob()).resolves.toMatchObject({ sent: 1 });
    expectSend({ subscriptions: [active] });
  });

  it.each([1, 2])(
    "counts category, mute, quiet-hours and agent-filter suppression as skipped once (%i preparations)",
    async (attempts) => {
      mocks.prepareAttempts = attempts;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.UTC(2026, 10, 21, 12, 0));
      try {
        const delivered = makeSubscription("bob-delivered", "bob");
        setRecipients(
          delivered,
          makeSubscription("bob-category-off", "bob", {
            categories: { agentFinished: false },
          }),
          makeSubscription("bob-muted", "bob", { enabled: false }),
          makeSubscription("bob-quiet", "bob", {
            quietHours: {
              enabled: true,
              startMinute: 11 * 60,
              endMinute: 13 * 60,
              timeZone: "UTC",
            },
          }),
          makeSubscription("bob-other-agent", "bob", { agentIds: ["ops"] }),
        );

        await expect(sendToBob({ agentId: "research" })).resolves.toEqual({
          sent: 1,
          failed: 0,
          skipped: 4,
          pruned: 0,
        });
        expect(mocks.send).toHaveBeenCalledOnce();
        expectSend({ subscriptions: [delivered] });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps caller text off Private lock screens", async () => {
    const identified = makeSubscription("bob-identified", "bob", { label: "Desk" });
    const privateTarget = makeSubscription("bob-private", "bob", { detailLevel: "private" });
    setRecipients(identified, privateTarget);

    const question = {
      category: "agent-question",
      title: "Ticket\nassigned",
      body: "Review\u0007\r\n ticket 42\u202E",
      tag: "ticket-42",
      path: "chat/research/thread%2E1",
      urgency: "high",
      ttlSeconds: 60,
    } as const;
    // agent-question also requires the questions scope on the paired device. Devices the
    // authority drops this way are not the recipient's to count: every counter stays zero.
    await expect(sendToBob(question)).resolves.toEqual({
      sent: 0,
      failed: 0,
      skipped: 0,
      pruned: 0,
    });
    expect(mocks.send).not.toHaveBeenCalled();

    setPaired(
      pairedOperator(identified.deviceId, ["operator.read", "operator.questions"]),
      pairedOperator(privateTarget.deviceId, ["operator.read", "operator.questions"]),
    );
    await sendToBob(question);
    const calls = mocks.send.mock.calls.map(([call]) => call);
    const url = "chat/research/thread%2E1#gatewayUrl=wss%3A%2F%2Fgateway.example.test%2Foperator";
    const message = (subscription: BoundWebPushSubscription, title: string, body: string) => ({
      subscriptions: [subscription],
      payload: { title, body, tag: "openclaw-send-ticket-42", renotify: false, url },
      deliveryOptions: { TTL: 60, urgency: "high", topic: expect.any(String) },
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        message(identified, "Desk · Ticket assigned", "Review ticket 42\\u{202E}"),
        message(privateTarget, "OpenClaw needs an answer", "An agent has a question for you."),
      ]),
    );
  });

  it("reports expired endpoints as failed and pruned", async () => {
    const live = makeSubscription("bob-live", "bob");
    const gone = makeSubscription("bob-gone", "bob");
    const broken = makeSubscription("bob-broken", "bob");
    setRecipients(live, gone, broken);
    mocks.send.mockImplementation(
      async ({ subscriptions }: { subscriptions: BoundWebPushSubscription[] }) =>
        subscriptions.map((subscription) => ({
          ok: subscription === live,
          subscriptionId: subscription.subscriptionId,
          statusCode:
            { [live.subscriptionId]: 201, [gone.subscriptionId]: 410 }[
              subscription.subscriptionId
            ] ?? 503,
        })),
    );

    await expect(sendToBob()).resolves.toEqual({ sent: 1, failed: 2, skipped: 0, pruned: 1 });
  });

  it("returns zero counts without subscriptions or a known recipient", async () => {
    const zero = { sent: 0, failed: 0, skipped: 0, pruned: 0 };
    mocks.hasSubscriptions.mockResolvedValue(false);
    await expect(sendToBob()).resolves.toEqual(zero);
    expect(mocks.sender).not.toHaveBeenCalled();

    mocks.hasSubscriptions.mockResolvedValue(true);
    setRecipients(makeSubscription("alice-browser", "alice"));
    mocks.identity.mockImplementation((id: string) =>
      id === "bob" ? undefined : profileIdentity(id),
    );
    await expect(sendToBob()).resolves.toEqual(zero);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
