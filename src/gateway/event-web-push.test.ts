import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { retainPreparedSessionSharingFacts } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { retainSessionEntryWorkerPublication } from "../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import { readImageMetadataFromHeader } from "../media/image-ops.js";
import { encodePngRgba } from "../media/png-encode.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { HumanMentionWebPush } from "./event-web-push.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";

const mocks = vi.hoisted(() => ({
  pairing: vi.fn(),
  preparePairing: vi.fn(),
  profiles: vi.fn(),
  sessions: vi.fn(),
  subscriptions: vi.fn(),
  hasSubscriptions: vi.fn(),
  sender: vi.fn(),
  send: vi.fn(),
  identity: vi.fn(),
  preferences: vi.fn(),
  rolePolicy: vi.fn(),
  canReceive: vi.fn(),
  mentionCurrent: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/web-push" ? { ...logger, warn: mocks.warn } : logger;
    },
  };
});

vi.mock("../infra/device-pairing-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-worker.js")>()),
  withCurrentDevicePairingSnapshot: (async (_stateDir, prepare, preparePublication) => {
    await mocks.preparePairing();
    const paired = mocks.pairing().paired;
    if (preparePublication) {
      await preparePublication();
    }
    return prepare(paired)?.start();
  }) satisfies typeof import("../infra/device-pairing-worker.js").withCurrentDevicePairingSnapshot,
}));

// mock-isolation: Control subscription snapshots and send settlement without network delivery.
vi.mock("../infra/push-web.js", () => ({
  withBoundWebPushSubscriptions: (async (stateDir, prepare) => {
    try {
      return await (await prepare(await mocks.subscriptions(stateDir), () => {}))?.start();
    } finally {
      authorityCompleted.resolve();
    }
  }) satisfies typeof import("../infra/push-web.js").withBoundWebPushSubscriptions,
  hasBoundWebPushSubscriptions: mocks.hasSubscriptions,
  prepareWebPushNotificationSender: mocks.sender,
}));

vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  prepareUserProfileCatalog: mocks.profiles,
}));

vi.mock("./session-sharing-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing-preparation.js")>()),
  prepareSessionMutationFacts: mocks.sessions,
}));

vi.mock("../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-preferences.js")>()),
  getUserPreferenceValues: mocks.preferences,
}));

vi.mock("./operator-role-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operator-role-policy.js")>()),
  resolveOperatorRolePolicyForAssignment: mocks.rolePolicy,
}));

vi.mock("./session-sharing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing.js")>()),
  canReceiveSessionEvent: mocks.canReceive,
}));

const { createEventWebPushDelivery } = await import("./event-web-push.js");
let authorityCompleted = createDeferred();

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

function humanMention(overrides: Partial<HumanMentionWebPush> = {}): HumanMentionWebPush {
  return {
    id: "mention-1",
    recipientProfileId: "bob",
    sessionKey: "agent:research:thread.1",
    agentId: "research",
    prepare: async () => {},
    isCurrent: mocks.mentionCurrent,
    ...overrides,
  };
}

function pairedOperator(deviceId: string, scopes = ["operator.read"], revokedAtMs?: number) {
  const operator = { role: "operator", scopes, revokedAtMs };
  return { deviceId, roles: ["operator"], approvedScopes: scopes, tokens: { operator } };
}

function createDelivery(params: Partial<Parameters<typeof createEventWebPushDelivery>[0]> = {}) {
  return createEventWebPushDelivery({ getRuntimeConfig: () => ({}), ...params });
}

function finishAgent(delivery = createDelivery(), data: object = {}, opts?: GatewayBroadcastOpts) {
  delivery.handleEvent("chat", { state: "final", runId: "run-1", ...data }, opts);
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
  mocks.pairing.mockReturnValue({ paired });

function setRecipients(...subscriptions: BoundWebPushSubscription[]) {
  setSubscriptions(...subscriptions);
  setPaired(...subscriptions.map(({ deviceId }) => pairedOperator(deviceId)));
}

const researchContext = { agentId: "research", sessionKeys: ["agent:research:thread.1"] };

function prepareSender() {
  const preparation = createDeferred<typeof mocks.send>();
  mocks.sender.mockReturnValue(preparation.promise);
  return preparation;
}

const expectSend = (expected: object) =>
  expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining(expected));
async function expectPayload(payload: object) {
  await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
  expectSend({ payload: expect.objectContaining(payload) });
}

describe("event Web Push classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSubscriptions(makeSubscription("browser-device"));
    mocks.hasSubscriptions.mockResolvedValue(true);
    setPaired(pairedOperator("browser-device"));
    mocks.sender.mockResolvedValue(mocks.send);
    mocks.send.mockResolvedValue([]);
    mocks.preparePairing.mockResolvedValue(undefined);
    authorityCompleted = createDeferred();
    mocks.profiles.mockResolvedValue({
      readCurrentIdentity: mocks.identity,
      release: () => {},
    });
    mocks.sessions.mockResolvedValue({
      prepareRead: () => undefined,
      readCurrent: () => ({ target: null, membership: new Set<string>() }),
      release: () => {},
    });
    mocks.identity.mockImplementation(profileIdentity);
    mocks.preferences.mockResolvedValue({ values: new Map(), isCurrent: () => true });
    mocks.rolePolicy.mockReturnValue(undefined);
    mocks.canReceive.mockReturnValue(true);
    mocks.mentionCurrent.mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  it("includes the selected avatar only for identified agent notifications", async () => {
    const identified = makeSubscription("identified");
    const privateTarget = makeSubscription("private", null, { detailLevel: "private" });
    setRecipients(identified, privateTarget);
    const pixels = Buffer.alloc(64 * 64 * 4, Buffer.from([255, 150, 0, 255]));
    const avatar = `data:image/png;base64,${encodePngRgba(pixels, 64, 64).toString("base64")}`;
    const cfg: OpenClawConfig = { agents: { entries: { research: { identity: { avatar } } } } };

    finishAgent(
      createDelivery({ getRuntimeConfig: () => cfg }),
      { runId: "avatar-run" },
      researchContext,
    );

    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    const identifiedPayload = mocks.send.mock.calls.find(
      ([call]) => call.subscriptions[0] === identified,
    )?.[0].payload;
    const privatePayload = mocks.send.mock.calls.find(
      ([call]) => call.subscriptions[0] === privateTarget,
    )?.[0].payload;
    expect(identifiedPayload.icon).toMatch(/^data:image\/png;base64,/);
    expect(identifiedPayload.icon.length).toBeLessThanOrEqual(2_400);
    expect(
      readImageMetadataFromHeader(Buffer.from(identifiedPayload.icon.split(",")[1], "base64")),
    ).toEqual({ width: 32, height: 32 });
    expect(privatePayload).not.toHaveProperty("icon");
  });

  it("drops a prepared avatar when identity changes during recipient preparation", async () => {
    const avatar = `data:image/png;base64,${encodePngRgba(Buffer.from([255, 150, 0, 255]), 1, 1).toString("base64")}`;
    const identity = { avatar };
    const cfg: OpenClawConfig = { agents: { entries: { research: { identity } } } };
    mocks.preparePairing.mockImplementationOnce(async () => {
      identity.avatar = "🌱";
    });

    finishAgent(
      createDelivery({ getRuntimeConfig: () => cfg }),
      { runId: "changed-avatar-run" },
      researchContext,
    );

    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send.mock.calls[0]?.[0].payload).not.toHaveProperty("icon");
  });

  it("waits for final completion after a parent yields to its children", async () => {
    const delivery = createDelivery();
    delivery.handleEvent("chat", { state: "delta", runId: "run-1" });
    delivery.handleEvent("chat", { state: "final", runId: "run-1", yielded: true });
    await Promise.resolve();
    expect(mocks.send).not.toHaveBeenCalled();
    finishAgent(delivery, { sessionKey: "agent:research:thread.1" });
    await expectPayload({ tag: "openclaw-agent-finished-run-1", url: "sessions" });
  });

  it.each([false, true])("joins session publication (unknown: %s)", async (unknown) => {
    const sessionKey = "agent:main:publication";
    const databaseIdentity = "synthetic-web-push-publication";
    const retained = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${databaseIdentity}`,
      sessionKey,
      entry: { sessionId: "publication-session", updatedAt: 1 },
      membership: new Set<string>(),
    });
    const publication = retainSessionEntryWorkerPublication({
      agentId: "main",
      storePath: "/synthetic/web-push/sessions",
      databaseIdentity,
    });
    const pairingEntered = createDeferred();
    const publicationJoined = createDeferred();
    mocks.sessions.mockResolvedValue({
      prepareRead: () => {
        const pending = retained.prepareRead();
        publicationJoined.resolve();
        return pending;
      },
      readCurrent: () => {
        const current = retained.readCurrent();
        if (!current) {
          throw new Error("session publication unavailable");
        }
        return { target: null, membership: current.membership };
      },
      release: retained.release,
    });
    mocks.preparePairing.mockImplementationOnce(async () => {
      publication.begin([sessionKey], []);
      pairingEntered.resolve();
    });
    finishAgent(undefined, { runId: "publication-run" }, { sessionKeys: [sessionKey] });
    try {
      await pairingEntered.promise;
      await Promise.race([publicationJoined.promise, authorityCompleted.promise]);
      expect(mocks.warn).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
      publication.settle(undefined, unknown);
      await authorityCompleted.promise;
      if (unknown) {
        await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalled());
        expect(mocks.send).not.toHaveBeenCalled();
      } else {
        expect(mocks.send).toHaveBeenCalledOnce();
        expect(mocks.warn).not.toHaveBeenCalled();
      }
    } finally {
      publication.settle(undefined, false);
      retained.release();
    }
  });

  it.each([
    ["question.requested", { id: "question:1" }, "ask/question%3A1"],
    [
      "chat",
      { state: "final", runId: "run-1", sessionKey: "agent:research:thread.1" },
      "chat/research/thread%2E1",
    ],
    [
      "cron",
      { action: "finished", jobId: "nightly", status: "error", runAtMs: 1234 },
      "automations?job=nightly&run=cron%3Anightly%3A1234",
    ],
  ] as const)("routes %s to its originating Gateway", async (event, payload, path) => {
    setPaired(pairedOperator("browser-device", ["operator.read", "operator.questions"]));
    const delivery = createDelivery({ getRuntimeConfig: gatewayConfig });
    delivery.handleEvent(event, payload, researchContext);
    await expectPayload({
      url: `${path}#gatewayUrl=wss%3A%2F%2Fgateway.example.test%2Foperator`,
    });
  });

  it("does not treat injected transcript updates as agent completion", async () => {
    finishAgent(undefined, {
      runId: "inject-message-1",
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "gateway-injected",
        content: [{ type: "text", text: "Injected transcript update" }],
      },
    });
    await Promise.resolve();
    expect(mocks.sender).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("honors implied question scopes without notifying read-only devices", async () => {
    const admin = makeSubscription("admin");
    const reviewer = makeSubscription("reviewer");
    setSubscriptions(admin, reviewer, makeSubscription("reader"));
    setPaired(
      pairedOperator("admin", ["operator.admin"]),
      pairedOperator("reviewer", ["operator.read", "operator.questions"]),
      pairedOperator("reader", ["operator.read"]),
    );
    createDelivery().handleEvent("question.requested", { id: "question\n1" });
    await expectPayload({ tag: "openclaw-question-question\\u{A}1" });
    expectSend({ subscriptions: [admin, reviewer] });
  });

  it("escapes display labels but preserves the raw agent filter", async () => {
    const agentId = "agent\n\u202E";
    const subscription = makeSubscription("browser-device", null, { agentIds: [agentId] });
    setSubscriptions(subscription);
    finishAgent(undefined, { agentId });
    await expectPayload({ body: "agent\\u{A}\\u{202E}: An agent completed its response." });
  });

  it("sends only failed cron terminal events", async () => {
    const delivery = createDelivery();
    delivery.handleEvent("cron", { action: "finished", jobId: "cron-1", status: "ok" });
    expect(mocks.send).not.toHaveBeenCalled();
    delivery.handleEvent("cron", {
      action: "finished",
      jobId: "cron-1",
      status: "error",
      job: { name: "Nightly\u2028run" },
    });
    await expectPayload({ body: "Nightly\\u{2028}run needs attention." });
  });

  it("rereads subscriptions after transport preparation before sending", async () => {
    const stale = makeSubscription("stale-device");
    const preparation = prepareSender();
    setRecipients(stale);
    const getRuntimeConfig = vi.fn(() => ({}));
    const delivery = createDelivery({ getRuntimeConfig });
    finishAgent(delivery);
    await vi.waitFor(() => expect(mocks.sender).toHaveBeenCalledOnce());
    expect(getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.subscriptions).not.toHaveBeenCalled();
    setSubscriptions();
    preparation.resolve(mocks.send);
    await authorityCompleted.promise;
    expect(mocks.subscriptions).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("skips transport preparation when no subscriptions exist", async () => {
    setSubscriptions();
    mocks.hasSubscriptions.mockResolvedValue(false);
    finishAgent();
    await vi.waitFor(() => expect(mocks.hasSubscriptions).toHaveBeenCalledOnce());
    expect(mocks.sender).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([false, true])("rechecks device authority after reads (revoked: %s)", async (revoked) => {
    const subscriptions = createDeferred<BoundWebPushSubscription[]>();
    mocks.subscriptions.mockReturnValueOnce(subscriptions.promise);
    const order: string[] = [];
    let currentDevices = [pairedOperator("browser-device")];
    mocks.pairing.mockImplementation(() => {
      order.push("authority");
      queueMicrotask(() => order.push("next-microtask"));
      return { pending: [], paired: currentDevices };
    });
    mocks.send.mockImplementation(async () => {
      order.push("send");
      return [];
    });
    finishAgent();
    await vi.waitFor(() => expect(mocks.subscriptions).toHaveBeenCalledOnce());
    expect(mocks.pairing).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    if (revoked) {
      currentDevices = [];
    }
    subscriptions.resolve([makeSubscription("browser-device")]);
    await vi.waitFor(() => expect(mocks.pairing).toHaveBeenCalledOnce());
    if (revoked) {
      expect(mocks.send).not.toHaveBeenCalled();
      expect(order).toEqual(["authority", "next-microtask"]);
    } else {
      expect(mocks.send).toHaveBeenCalledOnce();
      expect(order).toEqual(["authority", "send", "next-microtask"]);
    }
  });

  it.each(["preferences changed", "profile merged"] as const)(
    "refreshes recipient preferences after pairing: %s",
    async (change) => {
      const pairingStarted = createDeferred();
      const pairingReady = createDeferred();
      let profileId = "bob";
      let revision = 0;
      setSubscriptions(makeSubscription("browser-device", "bob"));
      mocks.identity.mockImplementation(() => profileIdentity(profileId, ["bob", profileId]));
      mocks.preferences.mockImplementation(async (profileIds: string[]) => {
        const preparedRevision = revision;
        return {
          values: new Map(profileIds.map((id) => [id, revision ? { agentIds: ["other"] } : {}])),
          isCurrent: () => change === "profile merged" || preparedRevision === revision,
        };
      });
      mocks.preparePairing.mockImplementationOnce(async () => {
        pairingStarted.resolve();
        await pairingReady.promise;
      });
      finishAgent(undefined, { runId: "preference-race" }, { agentId: "research" });
      await pairingStarted.promise;
      expect(mocks.send).not.toHaveBeenCalled();
      if (change === "profile merged") {
        profileId = "alice";
      }
      revision += 1;
      pairingReady.resolve();
      await authorityCompleted.promise;
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.preferences).toHaveBeenCalledTimes(2);
      expect(mocks.preferences).toHaveBeenLastCalledWith(
        [profileId],
        "notifications.web.v1",
        expect.anything(),
      );
    },
  );

  describe("human mention delivery", () => {
    beforeEach(() => {
      setSubscriptions(makeSubscription("browser-device", "bob"));
    });

    it("targets the recipient's canonical subscriptions, not other readers of the session", async () => {
      const bob = makeSubscription("bob-browser", "bob");
      const mergedBob = makeSubscription("bob-phone", "bob-old");
      const subscriptions = [
        makeSubscription("alice-browser", "alice"),
        bob,
        mergedBob,
        makeSubscription("carol-browser", "carol"),
        makeSubscription("anonymous-browser"),
      ];
      setRecipients(...subscriptions);
      mocks.identity.mockImplementation((id: string) =>
        profileIdentity(id === "bob-old" ? "bob" : id, [id]),
      );
      const delivery = createDelivery();
      delivery.handleEvent("mentions.changed", humanMention());
      expect(mocks.sender).not.toHaveBeenCalled();
      delivery.deliverMention(humanMention({ recipientProfileId: "bob-old" }));
      await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      expectSend({
        subscriptions: [bob, mergedBob],
        payload: expect.objectContaining({ url: "chat/research/thread%2E1" }),
      });
    });

    it("records one safe default-logger warning for partial delivery failures across copy groups", async () => {
      const browser = makeSubscription("bob-browser", "bob");
      const phone = makeSubscription("bob-phone", "bob", { detailLevel: "private" });
      setRecipients(browser, phone);
      mocks.send.mockImplementation(
        async ({ subscriptions }: { subscriptions: BoundWebPushSubscription[] }) =>
          subscriptions.map((subscription) => ({
            ok: subscription.subscriptionId === browser.subscriptionId,
            subscriptionId: subscription.subscriptionId,
            error: "private transport endpoint details",
          })),
      );
      createDelivery().deliverMention(humanMention());
      await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledOnce());
      expect(mocks.warn).toHaveBeenCalledWith("event Web Push delivery failed", {
        category: "human-mentioned",
        attempted: 2,
        failed: 1,
      });
      expect(mocks.send).toHaveBeenCalledTimes(2);
    });

    it("records the raw cause and stage of an agent-finished preparation failure", async () => {
      const failure = new TypeError("synthetic invalid VAPID key", {
        cause: new Error("invalid key length"),
      });
      mocks.sender.mockRejectedValueOnce(failure);
      finishAgent(createDelivery({ log: { warn: mocks.warn } }), { runId: "failure-run" });
      await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledOnce());
      expect(mocks.warn).toHaveBeenCalledWith("event Web Push delivery could not complete", {
        category: "agent-finished",
        stage: "sender",
        error: "synthetic invalid VAPID key | invalid key length",
        errorName: "TypeError",
        errorCode: undefined,
        stack: failure.stack,
        retry: false,
      });
    });

    it.each([
      "eligible admin",
      "device downgrade",
      "profile downgrade",
      "missing role policy",
      "generic event",
    ] as const)(
      "fences draft-session visibility without main-thread SQLite: %s",
      async (scenario) => {
        const [profiles, preferences, sessions, roles, sharing] = await Promise.all([
          vi.importActual<typeof import("../state/user-profile-list.js")>(
            "../state/user-profile-list.js",
          ),
          vi.importActual<typeof import("../state/user-preferences.js")>(
            "../state/user-preferences.js",
          ),
          vi.importActual<typeof import("./session-sharing-preparation.js")>(
            "./session-sharing-preparation.js",
          ),
          vi.importActual<typeof import("./operator-role-policy.js")>("./operator-role-policy.js"),
          vi.importActual<typeof import("./session-sharing.js")>("./session-sharing.js"),
        ]);
        mocks.profiles.mockImplementation(profiles.prepareUserProfileCatalog);
        mocks.preferences.mockImplementation(preferences.getUserPreferenceValues);
        mocks.sessions.mockImplementation(sessions.prepareSessionMutationFacts);
        mocks.rolePolicy.mockImplementation(roles.resolveOperatorRolePolicyForAssignment);
        mocks.canReceive.mockImplementation(sharing.canReceiveSessionEvent);
        await withOpenClawTestState({ scenario: "minimal" }, async () => {
          const owner = ensureProfileForEmail("draft-owner@example.test");
          const recipient = ensureProfileForEmail("draft-admin@example.test");
          setUserProfileRole(recipient.id, "admin");
          let cfg: OpenClawConfig = {
            gateway: {
              roles: {
                default: "reader",
                definitions: {
                  admin: { scopes: ["operator.admin"], sessions: { others: "write" }, agents: "*" },
                  reader: { scopes: ["operator.read"], sessions: { others: "view" }, agents: "*" },
                },
              },
            },
          };
          setRuntimeConfigSnapshot(cfg);
          const sessionKey = "agent:main:foreign-draft";
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            {
              sessionId: "foreign-draft",
              updatedAt: 1,
              visibility: "draft",
              createdActor: { type: "human", source: "profile", id: owner.id },
            },
          );
          if (scenario === "eligible admin") {
            // Cold-store preparation must use the persisted rows after native and worker handles close.
            await closeOpenClawAgentDatabasesAsync();
            await closeOpenClawStateDatabaseAsync();
          }
          const subscription = makeSubscription("admin-browser", recipient.id);
          setSubscriptions(subscription);
          setPaired(pairedOperator("admin-browser", ["operator.admin"]));
          const preparation = prepareSender();
          const getRuntimeConfig = vi.fn(() => cfg);
          const delivery = createDelivery({ getRuntimeConfig });
          if (scenario === "generic event") {
            finishAgent(
              delivery,
              { runId: "draft-run", agentId: "main" },
              {
                sessionKeys: [sessionKey],
                agentId: "main",
              },
            );
          } else {
            delivery.deliverMention(
              humanMention({ recipientProfileId: recipient.id, sessionKey, agentId: "main" }),
            );
          }
          expect(getRuntimeConfig).not.toHaveBeenCalled();
          if (scenario === "device downgrade") {
            setPaired(pairedOperator("admin-browser"));
          } else if (scenario === "profile downgrade") {
            setUserProfileRole(recipient.id, "reader");
            invalidateOperatorRolePolicy(recipient.id);
          } else if (scenario === "missing role policy") {
            cfg = {};
          }
          const { StatementSync } = requireNodeSqlite();
          const statements = (["get", "all", "run", "iterate"] as const).map((method) =>
            vi.spyOn(StatementSync.prototype, method),
          );
          try {
            preparation.resolve(mocks.send);
            await authorityCompleted.promise;
            expect(statements.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);
            expect(mocks.canReceive).toHaveBeenCalledOnce();
            if (scenario === "eligible admin") {
              expectSend({ subscriptions: [subscription] });
            } else {
              expect(mocks.send).not.toHaveBeenCalled();
            }
          } finally {
            for (const spy of statements) {
              spy.mockRestore();
            }
          }
        });
      },
    );

    it.each(["private", "identified"] as const)(
      "keeps %s mention copy label-only and PWA-routed",
      async (detailLevel) => {
        const subscription = makeSubscription("browser-device", "bob", { detailLevel });
        setSubscriptions(subscription);
        createDelivery({ getRuntimeConfig: gatewayConfig }).deliverMention(
          humanMention({ senderLabel: "Al\nice", sessionTitle: "Review\u202E" }),
        );
        await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
        expectSend({
          payload: {
            title: "OpenClaw mention",
            body:
              detailLevel === "private"
                ? "Someone mentioned you in a conversation."
                : "Al\\u{A}ice mentioned you in Review\\u{202E}.",
            tag: expect.stringMatching(/^openclaw-mention-[\w-]{43}$/u),
            renotify: false,
            url: "chat/research/thread%2E1#gatewayUrl=wss%3A%2F%2Fgateway.example.test%2Foperator",
          },
        });
      },
    );

    it.each([
      ["token revocation", () => setPaired(pairedOperator("browser-device", undefined, 1))],
      ["profile role downgrade", () => mocks.rolePolicy.mockReturnValue({ scopes: [] })],
      ["profile removal", () => mocks.identity.mockReturnValue(undefined)],
      [
        "browser account switch",
        () => setSubscriptions(makeSubscription("browser-device", "carol")),
      ],
      ["mention expiry or dismissal", () => mocks.mentionCurrent.mockReturnValue(false)],
    ] as const)("rechecks %s after sender preparation", async (_name, revoke) => {
      const preparation = prepareSender();
      const getRuntimeConfig = vi.fn(() => ({}));
      createDelivery({ getRuntimeConfig }).deliverMention(humanMention());
      await vi.waitFor(() => expect(mocks.sender).toHaveBeenCalledOnce());
      expect(getRuntimeConfig).not.toHaveBeenCalled();
      revoke();
      preparation.resolve(mocks.send);
      await authorityCompleted.promise;
      expect(mocks.send).not.toHaveBeenCalled();
    });

    it.each([
      { name: "disabled category", preferences: { categories: { humanMentioned: false } } },
      { name: "disabled browser", preferences: { enabled: false } },
      { name: "agent filter", preferences: { agentIds: ["other"] } },
      {
        name: "quiet hours",
        preferences: {
          quietHours: { enabled: true, startMinute: 0, endMinute: 1439, timeZone: "UTC" },
        },
      },
    ])("suppresses $name despite owner eligibility", async ({ preferences }) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-01T12:00:00Z"));
      const preparation = prepareSender();
      createDelivery().deliverMention(humanMention());
      setSubscriptions(makeSubscription("browser-device", "bob", preferences));
      preparation.resolve(mocks.send);
      await authorityCompleted.promise;
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.mentionCurrent).toHaveReturnedWith(true);
    });

    it("refreshes the mention after awaited pairing preparation before its final send fence", async () => {
      let durable = true;
      let prepared = true;
      mocks.preparePairing.mockImplementationOnce(async () => {
        durable = false;
      });
      const prepare = vi.fn(async () => {
        prepared = durable;
      });
      mocks.mentionCurrent.mockImplementation(() => prepared);
      createDelivery().deliverMention(humanMention({ prepare }));
      await authorityCompleted.promise;
      expect(prepare).toHaveBeenCalledOnce();
      expect(mocks.mentionCurrent).toHaveBeenCalledOnce();
      expect(mocks.send).not.toHaveBeenCalled();
    });

    it("runs the mention's final owner fence without yielding before network I/O", async () => {
      const order: string[] = [];
      mocks.mentionCurrent.mockImplementation(() => {
        order.push("current");
        queueMicrotask(() => order.push("next-microtask"));
        return true;
      });
      mocks.send.mockImplementation(async () => {
        order.push("send");
        return [];
      });
      createDelivery().deliverMention(humanMention());
      await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
      expect(order).toEqual(["current", "send", "next-microtask"]);
    });
  });
});
