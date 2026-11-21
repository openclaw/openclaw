import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { setCanonicalUserPreferences } from "../../state/user-preferences.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { setOpenClawIdMemberAccountLookup } from "../openclaw-id/tunnel-principal.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pushHandlers } from "./push.js";
import { pushSubscription } from "./push.test-support.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  resolveProfileId: vi.fn<(profileId: string) => string | undefined>((profileId) => profileId),
  findBoundWebPushSubscriptionByEndpoint:
    vi.fn<(params: { endpoint: string }) => Promise<BoundWebPushSubscription | null>>(),
  sendProfileWebPush: vi.fn(),
}));
const findBoundWebPushSubscriptionByEndpoint = mocks.findBoundWebPushSubscriptionByEndpoint;

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

// mock-isolation: Supply synthetic APNs registration and delivery outcomes without network calls.
vi.mock("../../infra/push-apns.js", async () =>
  (await import("./push.test-support.js")).mockPushApns(),
);

// mock-isolation: Use controlled subscription storage and delivery receipts for handler tests.
vi.mock("../../infra/push-web.js", async () => ({
  ...(await import("./push.test-support.js")).mockPushWeb(),
  withBoundWebPushSubscriptionByEndpoint: async <T>(
    params: { endpoint: string },
    prepare: (
      subscription: BoundWebPushSubscription | null,
    ) => { start: () => T } | undefined | Promise<{ start: () => T } | undefined>,
  ) => (await prepare(await mocks.findBoundWebPushSubscriptionByEndpoint(params)))?.start(),
}));

// mock-isolation: Recipient selection and delivery are proven against their owner in event-web-push.profile-send.test.ts.
vi.mock("../event-web-push.js", () => ({ sendProfileWebPush: mocks.sendProfileWebPush }));

vi.mock("../../state/user-preferences.js", () => ({
  getCanonicalUserPreferences: vi.fn(async () => ({ profileId: "profile-owner", entries: {} })),
  setCanonicalUserPreferences: vi.fn(async () => ({
    ok: true,
    value: { profileId: "profile-owner" },
  })),
}));

// mock-isolation: Bind synthetic push profiles without opening profile storage.
vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileSelectionAuthority: vi.fn(async (id: string) => {
    const profileId = mocks.resolveProfileId(id);
    return profileId
      ? { profileId, isCurrent: () => mocks.resolveProfileId(id) === profileId }
      : undefined;
  }),
}));
// mock-isolation: Resolve synthetic push recipients without opening a shared-state worker.
vi.mock("../../state/user-profile-list.js", () => ({
  prepareUserProfileCatalog: async () => ({
    readCurrentIdentity: (id: string) => {
      const profileId = mocks.resolveProfileId(id);
      return profileId && { profileId, openclawIdAccountIds: [`account-${profileId}`] };
    },
    release: vi.fn(),
  }),
}));

import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  shouldClearStoredApnsRegistration,
} from "../../infra/push-apns.js";
import {
  broadcastWebPush,
  clearBoundWebPushSubscription,
  registerWebPushSubscription,
  setWebPushSubscriptionPreferences,
  type BoundWebPushSubscription,
} from "../../infra/push-web.js";

type ApnsPushResult = Awaited<ReturnType<typeof sendApnsAlert>>;
type WebPushResults = Awaited<ReturnType<typeof broadcastWebPush>>;

type RespondCall = [boolean, unknown?, { code: string; message: string; details?: unknown }?];
const endpoint = "https://push.example.test/subscription";
const keys = { p256dh: "p256dh", auth: "auth" };
const directRegistration = {
  nodeId: "ios-node-1",
  transport: "direct",
  token: "abcd",
  topic: "ai.openclaw.ios",
  environment: "sandbox",
  updatedAtMs: 1,
} as const;

const relayRegistration = {
  nodeId: "ios-node-1",
  transport: "relay",
  relayHandle: "relay-handle-123",
  sendGrant: "send-grant-123",
  installationId: "install-1",
  topic: "ai.openclaw.ios",
  environment: "production",
  distribution: "official",
  updatedAtMs: 1,
  tokenDebugSuffix: "abcd1234",
} as const;

function apnsResult(overrides: Partial<ApnsPushResult>): ApnsPushResult {
  return {
    ok: true,
    status: 200,
    tokenSuffix: "1234abcd",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
    transport: "direct",
    ...overrides,
  };
}

type PushOptions = Parameters<(typeof pushHandlers)["push.test"]>[0];

async function request(
  method: keyof typeof pushHandlers,
  params: Record<string, unknown>,
  context: Partial<PushOptions["context"]>,
  client: PushOptions["client"] = null,
) {
  const respond = vi.fn();
  await pushHandlers[method]({
    params,
    respond,
    context: createDirectChatContext(context),
    client,
    req: { type: "req", id: "req-1", method },
    isWebchatConnect: () => false,
  });
  return respond;
}

function apnsRequest(params: Record<string, unknown> = { nodeId: "ios-node-1" }) {
  return request("push.test", params, {
    getRuntimeConfig: () => mocks.getRuntimeConfig(),
  });
}

function webClient(options: { deviceId?: string; userProfileId?: string }) {
  return {
    connect: {
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      device: options.deviceId === undefined ? undefined : { id: options.deviceId },
    },
    ...(options.userProfileId
      ? { authenticatedUserProfile: { profileId: options.userProfileId } }
      : {}),
  } as never;
}

function subscribe(
  options: {
    deviceId?: string;
    userProfileId?: string;
    config?: Record<string, unknown>;
  } = {},
) {
  return request(
    "push.web.subscribe",
    { endpoint, keys },
    { getRuntimeConfig: () => options.config ?? {} },
    webClient({ ...options, deviceId: options.deviceId || undefined }),
  );
}

function boundRequest(
  method: "push.web.preferences.get" | "push.web.preferences.set" | "push.web.unsubscribe",
  params: Record<string, unknown> = {},
  options: { deviceId?: string; userProfileId?: string } = {},
) {
  return request(
    method,
    { endpoint, ...params },
    { broadcastToConnIds: vi.fn() },
    webClient({ ...options, deviceId: options.deviceId ?? "browser-device" }),
  );
}

function expectErrorResponse(respond: ReturnType<typeof vi.fn>, expectedMessagePart?: string) {
  expect(firstRespondCall(respond)).toMatchObject([
    false,
    undefined,
    expectedMessagePart
      ? { code: ErrorCodes.INVALID_REQUEST, message: expect.stringContaining(expectedMessagePart) }
      : { code: ErrorCodes.FORBIDDEN },
  ]);
}

function firstRespondCall(respond: ReturnType<typeof vi.fn>): RespondCall | undefined {
  return respond.mock.calls[0] as RespondCall | undefined;
}

function expectSuccess(respond: ReturnType<typeof vi.fn>, result: unknown) {
  expect(firstRespondCall(respond)).toEqual([true, result, undefined]);
}

function boundSubscription(userProfileId: string | null = null): BoundWebPushSubscription {
  return {
    ...pushSubscription(endpoint, keys, "subscription-1"),
    deviceId: "browser-device",
    userProfileId,
    devicePreferences: { enabled: true, label: "" },
  };
}

describe("push.test handler", () => {
  beforeEach(() => {
    mocks.getRuntimeConfig.mockClear();
    vi.mocked(loadApnsRegistration).mockClear();
    vi.mocked(normalizeApnsEnvironment).mockClear();
    vi.mocked(resolveApnsAuthConfigFromEnv).mockClear();
    vi.mocked(resolveApnsRelayConfigFromEnv).mockClear();
    vi.mocked(sendApnsAlert).mockClear();
    vi.mocked(clearApnsRegistrationIfCurrent).mockClear();
    mocks.getRuntimeConfig.mockReturnValue({});
    vi.mocked(loadApnsRegistration).mockResolvedValue(directRegistration);
    vi.mocked(resolveApnsAuthConfigFromEnv).mockResolvedValue({
      ok: true,
      value: {
        teamId: "TEAM123",
        keyId: "KEY123",
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", // pragma: allowlist secret
      },
    });
    vi.mocked(normalizeApnsEnvironment).mockReturnValue(null);
    vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(false);
  });

  it("rejects invalid params", async () => {
    const respond = await apnsRequest({ title: "hello" });
    expectErrorResponse(respond, "invalid push.test params");
  });

  it("returns invalid request when node has no APNs registration", async () => {
    vi.mocked(loadApnsRegistration).mockResolvedValue(null);
    const respond = await apnsRequest();
    expectErrorResponse(respond, "has no APNs registration");
  });

  it("sends push test through relay registrations", async () => {
    const relay = () => ({ baseUrl: "https://relay.example.com", timeoutMs: 1000 });
    const push = { apns: { relay: relay() } };
    mocks.getRuntimeConfig.mockReturnValue({ gateway: { push } });
    vi.mocked(loadApnsRegistration).mockResolvedValue(relayRegistration);
    vi.mocked(resolveApnsRelayConfigFromEnv).mockReturnValue({
      ok: true,
      value: relay(),
    });
    vi.mocked(sendApnsAlert).mockResolvedValue(
      apnsResult({
        tokenSuffix: "abcd1234",
        environment: "production",
        transport: "relay",
      }),
    );

    const respond = await apnsRequest({ nodeId: "ios-node-1", title: "Wake", body: "Ping" });

    expect(resolveApnsAuthConfigFromEnv).not.toHaveBeenCalled();
    expect(resolveApnsRelayConfigFromEnv).toHaveBeenCalledTimes(1);
    expect(resolveApnsRelayConfigFromEnv).toHaveBeenCalledWith(
      process.env,
      { push: { apns: { relay: relay() } } },
      { registrationRelayOrigin: undefined },
    );
    expect(sendApnsAlert).toHaveBeenCalledTimes(1);
    expect(firstRespondCall(respond)).toMatchObject([
      true,
      { ok: true, status: 200, transport: "relay" },
      undefined,
    ]);
  });

  it.each([null, "production"] as const)(
    "clears invalid tokens only without override %s",
    async (environment) => {
      vi.mocked(normalizeApnsEnvironment).mockReturnValue(environment);
      const result = apnsResult({
        ok: false,
        status: 400,
        reason: "BadDeviceToken",
        environment: environment ?? "sandbox",
      });
      vi.mocked(sendApnsAlert).mockResolvedValue(result);
      vi.mocked(shouldClearStoredApnsRegistration).mockReturnValue(environment === null);
      await apnsRequest({ nodeId: "ios-node-1", ...(environment ? { environment } : {}) });
      if (environment) {
        expect(shouldClearStoredApnsRegistration).toHaveBeenCalledWith({
          registration: directRegistration,
          result,
          overrideEnvironment: environment,
        });
        expect(clearApnsRegistrationIfCurrent).not.toHaveBeenCalled();
      } else {
        expect(clearApnsRegistrationIfCurrent).toHaveBeenCalledWith({
          nodeId: "ios-node-1",
          registration: directRegistration,
        });
      }
    },
  );
});

describe("push.web.test handler", () => {
  beforeEach(() => {
    vi.mocked(broadcastWebPush).mockReset();
  });

  it.each([false, true])("returns delivery results with success=%s", async (success) => {
    const results: WebPushResults = [
      success
        ? { ok: true, subscriptionId: "active-subscription", statusCode: 201 }
        : {
            ok: false,
            subscriptionId: "rejected-subscription",
            statusCode: 503,
            error: "Service Unavailable",
          },
      { ok: false, subscriptionId: "expired-subscription", statusCode: 410, error: "Gone" },
    ];
    vi.mocked(broadcastWebPush).mockResolvedValue(results);
    const respond = await request("push.web.test", {}, {});
    expect(respond).toHaveBeenCalledTimes(1);
    expect(firstRespondCall(respond)).toEqual(
      success
        ? [true, { results }, undefined]
        : [
            false,
            undefined,
            expect.objectContaining({ code: ErrorCodes.UNAVAILABLE, details: { results } }),
          ],
    );
  });

  it("returns invalid request when no subscriptions are registered", async () => {
    vi.mocked(broadcastWebPush).mockResolvedValue([]);

    const respond = await request("push.web.test", {}, {});
    expectErrorResponse(respond, "no web push subscriptions registered");
  });
});

describe("push.web.send handler", () => {
  const agentsConfig = { agents: { entries: { main: {}, research: {} } } };
  const roles = {
    definitions: { member: { scopes: ["operator.write"], sessions: { others: "none" } } },
  };
  const rolesConfig = { ...agentsConfig, gateway: { roles: { ...roles, default: "member" } } };
  const catalogConfig = { ...agentsConfig, gateway: { openclawId: { enabled: true }, roles } };
  const counts = { sent: 1, failed: 0, skipped: 0, pruned: 0 };
  const notify = { profileId: "bob", category: "agent-finished" };
  type SendOptions = {
    config?: object;
    userProfileId?: string;
    scopes?: string[];
    principal?: "member" | "owner";
    linkedMember?: boolean;
  };
  const peerKey = `iroh:${"c".repeat(64)}`;
  const sendAs = (params: Record<string, unknown>, options: SendOptions = {}) => {
    setOpenClawIdMemberAccountLookup(options.linkedMember ? () => true : undefined);
    return request(
      "push.web.send",
      params,
      { getRuntimeConfig: () => (options.config ?? agentsConfig) as never },
      {
        connect: { role: "operator", scopes: options.scopes ?? ["operator.write"] },
        ...(options.userProfileId
          ? { authenticatedUserProfile: { profileId: options.userProfileId } }
          : {}),
        ...(options.principal === "member"
          ? { internal: { openclawIdPrincipal: { kind: "member", peerKey, accountId: "a" } } }
          : options.principal === "owner"
            ? { internal: { openclawIdPrincipal: { kind: "owner", peerKey } } }
            : {}),
      } as never,
    );
  };

  beforeEach(() => {
    mocks.sendProfileWebPush.mockReset();
    mocks.sendProfileWebPush.mockResolvedValue(counts);
    mocks.resolveProfileId.mockImplementation((profileId) =>
      profileId === "alice-old" ? "alice" : profileId === "ghost" ? undefined : profileId,
    );
  });
  afterEach(() => setOpenClawIdMemberAccountLookup(undefined));

  it("requires operator.write", () => {
    for (const [scope, allowed] of [
      ["operator.read", false],
      ["operator.write", true],
    ] as const) {
      expect(authorizeOperatorScopesForMethod("push.web.send", [scope]).allowed).toBe(allowed);
    }
  });

  it.each<[string, Record<string, unknown>, string?]>([
    ["missing profile", { profileId: undefined }],
    ["missing category", { category: undefined }],
    ["approval category", { category: "approval-requested" }],
    ["human-mention category", { category: "human-mentioned" }],
    ["unknown category", { category: "marketing" }],
    ["oversized title", { title: "t".repeat(81) }],
    ["oversized body", { body: "b".repeat(241) }],
    ["invalid tag", { tag: "has space" }],
    ["invalid TTL", { ttlSeconds: 86_401 }],
    ["unknown field", { icon: "x" }],
    ...[
      "https://x.test",
      "//x.test",
      "chat?token=x",
      "chat?gatewayUrl=wss://evil.test",
      "chat#token=x",
      "a/../evil",
      "a/%2e%2E/x",
      "a//b",
      "a/%zz",
      "a/%",
    ].map((path): [string, Record<string, unknown>, string] => [
      `path ${path}`,
      { path },
      "at /path: must be a relative Control UI path without query, fragment, empty or dot segments",
    ]),
  ])("rejects %s before delivery", async (_name, overrides, message) => {
    const respond = await sendAs({ ...notify, ...overrides });
    expectErrorResponse(respond, message ?? "invalid push.web.send params");
    expect(mocks.sendProfileWebPush).not.toHaveBeenCalled();
  });

  it("rejects an agent that is not configured", async () => {
    const respond = await sendAs({ ...notify, agentId: "ghost" });
    expectErrorResponse(respond, 'agent "ghost" not found');
    expect(mocks.sendProfileWebPush).not.toHaveBeenCalled();
  });

  it("returns delivery counts with the normalized agent id", async () => {
    const params = {
      ...notify,
      category: "agent-question",
      tag: "ticket-42",
      path: "chat/research/thread%2E1",
      title: "Ticket assigned",
      body: "Review ticket 42",
      agentId: "Research",
      urgency: "high",
      ttlSeconds: 60,
    };
    expectSuccess(await sendAs(params), counts);
    expect(mocks.sendProfileWebPush).toHaveBeenCalledWith(expect.any(Function), {
      ...params,
      agentId: "research",
    });
  });

  const roleCaller = { config: rolesConfig, userProfileId: "alice" };
  const idCaller = { config: catalogConfig, userProfileId: "alice" };
  const idMember = { ...idCaller, principal: "member" } as const;
  it.each<[string, SendOptions, string, boolean]>([
    ["no roles, another profile", {}, "bob", true],
    ["roles, own profile", roleCaller, "alice", true],
    ["roles, own merged alias", roleCaller, "alice-old", true],
    ["roles, another profile", roleCaller, "bob", false],
    ["roles, unknown profile", roleCaller, "ghost", false],
    ["roles, no caller profile", { config: rolesConfig }, "alice", false],
    ["roles, admin", { ...roleCaller, scopes: ["operator.admin"] }, "bob", true],
    ["catalog, local caller", idCaller, "bob", true],
    ["catalog, ID member", idMember, "bob", false],
    ["catalog, ID member, own profile", idMember, "alice", true],
    ["catalog, ID-linked member", { ...idCaller, linkedMember: true }, "bob", false],
    ["catalog, ID member, no profile", { ...idMember, userProfileId: undefined }, "bob", false],
    ["catalog, ID owner", { ...idCaller, principal: "owner" }, "bob", true],
  ])("authorizes the recipient: %s", async (_name, options, profileId, allowed) => {
    const respond = await sendAs({ ...notify, profileId }, options);
    if (allowed) {
      expectSuccess(respond, counts);
    } else {
      expect(firstRespondCall(respond)).toMatchObject([
        false,
        undefined,
        { code: ErrorCodes.FORBIDDEN, message: expect.stringContaining("operator.admin") },
      ]);
    }
    expect(mocks.sendProfileWebPush).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it("reports transport preparation failures as unavailable", async () => {
    mocks.sendProfileWebPush.mockRejectedValue(new Error("invalid VAPID key"));
    expect(firstRespondCall(await sendAs(notify))).toMatchObject([
      false,
      undefined,
      { code: ErrorCodes.UNAVAILABLE },
    ]);
  });
});

describe("push.web.subscribe handler", () => {
  beforeEach(() => {
    vi.mocked(registerWebPushSubscription)
      .mockReset()
      .mockResolvedValue(pushSubscription(endpoint, keys, "subscription-1"));
  });

  it("binds the subscription to the authenticated browser device and profile", async () => {
    const respond = await subscribe({
      deviceId: "browser-device",
      userProfileId: "profile-1",
    });

    expect(registerWebPushSubscription).toHaveBeenCalledWith({
      endpoint,
      keys: { p256dh: "p256dh", auth: "auth" },
      binding: { deviceId: "browser-device", userProfileId: "profile-1" },
      guard: expect.objectContaining({ assertCurrent: expect.any(Function) }),
    });
    expectSuccess(respond, { subscriptionId: "subscription-1" });
  });

  it.each([
    { options: {}, error: "paired browser device identity required" },
    {
      options: {
        deviceId: "browser-device",
        config: {
          gateway: {
            roles: {
              default: "guest",
              definitions: {
                guest: { sessions: { others: "none" as const }, agents: [], scopes: [] },
              },
            },
          },
        },
      },
      error: "authenticated user profile",
    },
  ])("rejects subscriptions missing $error", async ({ options, error }) => {
    const respond = await subscribe(options);
    expectErrorResponse(respond, error);
    expect(registerWebPushSubscription).not.toHaveBeenCalled();
  });
});

describe("bound Web Push handlers", () => {
  beforeEach(() => {
    vi.mocked(setCanonicalUserPreferences).mockClear();
    mocks.resolveProfileId.mockImplementation((profileId) => profileId);
    vi.mocked(clearBoundWebPushSubscription).mockReset().mockResolvedValue(true);
    vi.mocked(findBoundWebPushSubscriptionByEndpoint)
      .mockReset()
      .mockResolvedValue(boundSubscription());
    vi.mocked(setWebPushSubscriptionPreferences).mockReset().mockResolvedValue(true);
  });

  it.each([
    "push.web.preferences.get",
    "push.web.preferences.set",
    "push.web.unsubscribe",
  ] as const)(
    "%s rejects a deleted profile instead of treating it as profileless",
    async (method) => {
      vi.mocked(findBoundWebPushSubscriptionByEndpoint).mockResolvedValue(
        boundSubscription("deleted-profile"),
      );
      mocks.resolveProfileId.mockReturnValue(undefined);
      const respond = await boundRequest(
        method,
        method === "push.web.preferences.set"
          ? { scope: "device", preferences: { enabled: true, label: "" } }
          : {},
      );
      expectErrorResponse(respond);
    },
  );

  it.each([{ deviceId: "other-device" }, { deviceId: "" }, { userProfileId: "other-profile" }])(
    "rejects unsubscribe from a different owner: %j",
    async (options) => {
      const respond = await boundRequest("push.web.unsubscribe", {}, options);

      expectErrorResponse(respond);
      expect(clearBoundWebPushSubscription).not.toHaveBeenCalled();
    },
  );

  it("updates device preferences only while the subscription binding matches", async () => {
    const preferences = { enabled: false, label: "phone", categories: { humanMentioned: true } };
    const respond = await boundRequest("push.web.preferences.set", {
      scope: "device",
      preferences,
    });

    expect(setWebPushSubscriptionPreferences).toHaveBeenCalledWith({
      endpoint,
      preferences,
      expectedDeviceId: "browser-device",
      expectedUserProfileId: null,
      guard: expect.objectContaining({ assertCurrent: expect.any(Function) }),
    });
    expectSuccess(respond, { scope: "device", preferences });
  });

  it.each([undefined, true])(
    "saves human mention preference %s, defaulting older client payloads to off",
    async (humanMentioned) => {
      vi.mocked(findBoundWebPushSubscriptionByEndpoint).mockResolvedValue(
        boundSubscription("profile-owner"),
      );
      const preferences = {
        categories: {
          approvalRequested: true,
          agentFinished: false,
          agentQuestion: false,
          scheduledTaskFailed: false,
          ...(humanMentioned === undefined ? {} : { humanMentioned }),
        },
        detailLevel: "private",
        quietHours: { enabled: false, startMinute: 1320, endMinute: 420, timeZone: "UTC" },
        agentIds: [],
      };
      const respond = await boundRequest(
        "push.web.preferences.set",
        {
          scope: "user",
          preferences,
        },
        { userProfileId: "profile-owner" },
      );

      const normalized = {
        ...preferences,
        categories: { ...preferences.categories, humanMentioned: humanMentioned ?? false },
      };
      expect(setCanonicalUserPreferences).toHaveBeenCalledWith(
        "profile-owner",
        { "notifications.web.v1": normalized },
        { assertCurrent: expect.any(Function) },
      );
      expectSuccess(respond, { scope: "user", preferences: normalized });
    },
  );

  it("fails closed when the subscription binding changes during the update", async () => {
    vi.mocked(setWebPushSubscriptionPreferences).mockResolvedValue(false);
    const respond = await boundRequest("push.web.preferences.set", {
      scope: "device",
      preferences: { enabled: true, label: "" },
    });

    expectErrorResponse(respond);
  });

  it("rejects an invalid quiet-hours time zone", async () => {
    const respond = await boundRequest("push.web.preferences.set", {
      scope: "device",
      preferences: {
        enabled: true,
        label: "phone",
        quietHours: {
          enabled: true,
          startMinute: 1320,
          endMinute: 420,
          timeZone: "Not/A_Time_Zone",
        },
      },
    });

    expect(firstRespondCall(respond)).toMatchObject([
      false,
      undefined,
      { code: ErrorCodes.INVALID_REQUEST, message: "invalid notification quiet-hours time zone" },
    ]);
  });
});
