import { beforeEach, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pushHandlers } from "./push.js";
import { pushClient, pushSubscription } from "./push.test-support.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  resolveProfileId: vi.fn<(profileId: string) => string | undefined>((profileId) => profileId),
  findBoundWebPushSubscriptionByEndpoint:
    vi.fn<(params: { endpoint: string }) => Promise<BoundWebPushSubscription | null>>(),
}));
const findBoundWebPushSubscriptionByEndpoint = mocks.findBoundWebPushSubscriptionByEndpoint;

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../../infra/push-apns.js", async () =>
  (await import("./push.test-support.js")).mockPushApns(),
);

vi.mock("../../infra/push-web.js", async () => ({
  ...(await import("./push.test-support.js")).mockPushWeb(),
  withBoundWebPushSubscriptionByEndpoint: async <T>(
    params: { endpoint: string },
    prepare: (
      subscription: BoundWebPushSubscription | null,
    ) => { start: () => T } | undefined | Promise<{ start: () => T } | undefined>,
  ) => (await prepare(await mocks.findBoundWebPushSubscriptionByEndpoint(params)))?.start(),
}));

vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileSelectionAuthority: vi.fn(async (id: string) => {
    const profileId = mocks.resolveProfileId(id);
    return profileId
      ? { profileId, isCurrent: () => mocks.resolveProfileId(id) === profileId }
      : undefined;
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
  const client = pushClient(
    options.userProfileId ?? "",
    "push",
    new AbortController().signal,
    options.deviceId ?? "",
    ["operator.read", "operator.write"],
  );
  if (!options.userProfileId) {
    delete client.authenticatedUserProfile;
  }
  return client;
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
  expect(respond.mock.calls[0]).toMatchObject([
    false,
    undefined,
    expectedMessagePart
      ? { code: ErrorCodes.INVALID_REQUEST, message: expect.stringContaining(expectedMessagePart) }
      : { code: ErrorCodes.FORBIDDEN },
  ]);
}

function boundSubscription(userProfileId: string | null = null): BoundWebPushSubscription {
  return {
    ...pushSubscription(endpoint, keys, "subscription-1"),
    deviceId: "browser-device",
    userProfileId,
    devicePreferences: { enabled: true, label: "" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
  vi.mocked(broadcastWebPush).mockReset();
  mocks.resolveProfileId.mockImplementation((profileId) => profileId);
  findBoundWebPushSubscriptionByEndpoint.mockReset().mockResolvedValue(boundSubscription());
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
  expect(resolveApnsRelayConfigFromEnv).toHaveBeenCalledWith(
    process.env,
    { push: { apns: { relay: relay() } } },
    { registrationRelayOrigin: undefined },
  );
  expect(respond.mock.calls[0]).toMatchObject([
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
  expect(respond.mock.calls[0]).toEqual(
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
it.each([
  { options: {}, error: "paired browser device identity required" },
  {
    options: { deviceId: "browser-device", config: { gateway: { roles: { definitions: {} } } } },
    error: "authenticated user profile",
  },
])("rejects subscriptions missing $error", async ({ options, error }) => {
  const respond = await subscribe(options);
  expectErrorResponse(respond, error);
  expect(registerWebPushSubscription).not.toHaveBeenCalled();
});
it.each(["push.web.preferences.get", "push.web.preferences.set", "push.web.unsubscribe"] as const)(
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

it("rejects unsubscribe without a device identity", async () => {
  const respond = await boundRequest("push.web.unsubscribe", {}, { deviceId: "" });
  expectErrorResponse(respond);
  expect(clearBoundWebPushSubscription).not.toHaveBeenCalled();
});

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

  expect(respond.mock.calls[0]).toMatchObject([
    false,
    undefined,
    { code: ErrorCodes.INVALID_REQUEST, message: "invalid notification quiet-hours time zone" },
  ]);
});
