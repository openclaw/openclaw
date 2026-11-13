import { beforeEach, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { CallGatewayCliOptions } from "../gateway/call.js";
import { offerTerminalPersonalSetup, continueTerminalPersonalSetup } from "./onboard-personal.js";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  identity: vi.fn(),
  save: vi.fn(),
  load: vi.fn(),
  bootstrap: vi.fn(),
  probe: vi.fn(),
  host: vi.fn(),
  select: vi.fn(),
  note: vi.fn(),
}));
// mock-isolation: Keep external Gateway transport and credential writes outside the prompt/operation boundary.
vi.mock("../gateway/call.js", () => ({ callGateway: mocks.call }));
// mock-isolation: Pin the fixture Gateway target without discovering local credentials or endpoints.
vi.mock("../gateway/client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: mocks.bootstrap,
}));
// mock-isolation: Use fixture configuration without loading user configuration or process-wide config state.
vi.mock("../config/config.js", () => ({ loadConfig: () => ({}) }));
// mock-isolation: Exercise the actual continuation while external readiness and child-process I/O stay fixed.
vi.mock("./onboard-helpers.js", () => ({ probeGatewayReachable: mocks.probe }));
// mock-isolation: Observe continuation without starting a real Gateway process.
vi.mock("./onboard-quickstart-host.js", () => ({ runQuickstartForegroundGateway: mocks.host }));
// mock-isolation: Supply deterministic choices without opening a real interactive terminal.
vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => ({ select: mocks.select, note: mocks.note }),
}));
// mock-isolation: Do not initialize the real Gateway state database in this transport fixture.
vi.mock("../cli/gateway-rpc.runtime.js", () => ({ prepareCliGatewayStateAccess: async () => {} }));
// mock-isolation: Use a synthetic interactive identity without accessing device keys.
vi.mock("../cli/interactive-device-auth.js", () => ({
  loadInteractiveOperatorDeviceIdentity: mocks.identity,
}));
// mock-isolation: Observe credential persistence without reading or modifying real device tokens.
vi.mock("../infra/device-auth-store.js", () => ({
  loadDeviceAuthTokenReadOnly: mocks.load,
  loadOriginDeviceTokenReadOnly: mocks.load,
  storeDeviceAuthToken: mocks.save,
  storeOriginDeviceToken: mocks.save,
}));

const roles = {
  default: "writer",
  definitions: {
    writer: {
      scopes: ["operator.read", "operator.write"],
      agents: ["*"],
      sessions: { others: "none" },
    },
  },
};
const prompter = () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  select: vi.fn(),
  multiselect: vi.fn(),
  text: vi.fn(async () => "Alex"),
  confirm: vi.fn(),
  progress: vi.fn(),
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.bootstrap
    .mockReset()
    .mockResolvedValue({ url: "wss://selected.example", deviceAuthScope: "selected", auth: {} });
  mocks.probe.mockReset().mockResolvedValue({ ok: true });
  mocks.host.mockReset().mockImplementation(async (options) => await options.onReady());
  mocks.select.mockReset().mockResolvedValue("skip");
  mocks.identity.mockResolvedValue({ deviceId: "interactive-device" });
  mocks.save.mockResolvedValue({ token: "synthetic-replacement" });
  mocks.load.mockReset().mockResolvedValue(null);
  mocks.call.mockImplementation(async (options: CallGatewayCliOptions) => {
    if (options.method === "users.list") {
      return { profiles: [{ id: "existing-person", displayName: "Alex", mergedInto: null }] };
    }
    if (options.method === "config.get") {
      return { valid: true, config: { gateway: { roles } } };
    }
    if (options.method === "users.self") {
      // Real transport invokes hello before the synchronous dispatch guard.
      options.onHelloOk?.({
        type: "hello-ok",
        protocol: 1,
        server: { version: "test", connId: "fresh-connection" },
        features: { methods: [], events: [] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        auth: {
          role: "operator",
          scopes: options.useStoredDeviceAuth
            ? ["operator.read", "operator.write"]
            : ["operator.admin"],
          method: options.useStoredDeviceAuth ? "device-token" : "token",
        },
        policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
      });
      options.assertDispatchCurrent?.();
      return {
        profile: {
          id: options.useStoredDeviceAuth ? "person" : GATEWAY_OWNER_PROFILE_ID,
          displayName: "Alex",
        },
      };
    }
    return {
      deviceId: "interactive-device",
      profileId: "person",
      operatorToken: {
        token: "synthetic-replacement",
        scopes: ["operator.read", "operator.write"],
      },
    };
  });
});

it("Not now leaves identity, profile and credential owners untouched", async () => {
  const p = prompter();
  p.select.mockResolvedValue("skip");
  await expect(offerTerminalPersonalSetup(p)).resolves.toBeNull();
  expect(p.select).toHaveBeenCalledWith(
    expect.objectContaining({
      options: [
        expect.objectContaining({ label: "Set up" }),
        expect.objectContaining({ label: "Not now" }),
      ],
    }),
  );
  expect(mocks.identity).not.toHaveBeenCalled();
  expect(mocks.call).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it("creates one email-less intent, previews the selected Gateway's current role and confirms fresh token admission", async () => {
  const p = prompter();
  p.select.mockResolvedValueOnce("setup").mockResolvedValue("new");
  await expect(offerTerminalPersonalSetup(p, { token: "synthetic-shared" })).resolves.toEqual({
    deviceId: "interactive-device",
    profileId: "person",
    gatewayUrl: "wss://selected.example",
  });
  const requests = mocks.call.mock.calls.map(([request]) => request);
  expect(requests.map((request) => request.method)).toEqual([
    "users.self",
    "users.list",
    "config.get",
    "device.profile.enroll",
    "users.self",
  ]);
  expect(requests[3].params).toEqual({
    name: "Alex",
    enrollmentId: expect.stringMatching(/^[a-f0-9-]{36}$/),
  });
  expect(requests[4]).toMatchObject({
    expectUrl: "wss://selected.example",
    useStoredDeviceAuth: true,
    deviceIdentity: { deviceId: "interactive-device" },
  });
  expect(requests[4].token).toBeUndefined();
  expect(requests[4].password).toBeUndefined();
  expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.call.mock.invocationCallOrder[4]!,
  );
  expect(p.note).toHaveBeenCalledWith(expect.stringContaining("writer"), "Personal access preview");
  expect(JSON.stringify(p.note.mock.calls)).not.toContain("synthetic-replacement");
});

it.each([
  "denied role",
  "lost response",
  "revoked credential",
  "mismatched person",
  "credential write",
])("does not claim success or fall back after %s", async (failure) => {
  const p = prompter();
  p.select.mockResolvedValueOnce("setup").mockResolvedValue("new");
  if (failure === "credential write") {
    mocks.save.mockRejectedValueOnce(new Error("store unavailable"));
  }
  const normal = mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation(async (options: CallGatewayCliOptions) => {
    if (options.method === "config.get" && failure === "denied role") {
      return { valid: true, config: { gateway: { roles: { ...roles, default: undefined } } } };
    }
    if (options.method === "device.profile.enroll" && failure === "lost response") {
      throw new Error("connection lost");
    }
    if (
      options.method === "users.self" &&
      options.useStoredDeviceAuth &&
      failure === "revoked credential"
    ) {
      throw new Error("revoked");
    }
    const result = await normal(options);
    return options.method === "users.self" &&
      options.useStoredDeviceAuth &&
      failure === "mismatched person"
      ? { profile: { id: "another" } }
      : result;
  });
  await expect(offerTerminalPersonalSetup(p)).rejects.toThrow();
  expect(p.note.mock.calls.some(([, title]) => title === "Personal setup complete")).toBe(false);
  const calls = mocks.call.mock.calls.map(([request]) => request);
  expect(calls.filter((request) => request.method === "device.profile.enroll")).toHaveLength(
    failure === "denied role" ? 0 : 1,
  );
  if (failure === "lost response") {
    expect(mocks.save).not.toHaveBeenCalled();
  }
});

it("waits for the existing owned startup, pins its target, then lets Not now continue without identity writes", async () => {
  mocks.probe.mockResolvedValueOnce({ ok: false });
  const continued = vi.fn(async () => {});
  await continueTerminalPersonalSetup(
    { status: "skipped", reason: "systemd-unavailable" },
    { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    continued,
  );
  expect(mocks.host).toHaveBeenCalledWith(
    expect.objectContaining({ expectUrl: "wss://selected.example" }),
  );
  expect(mocks.select.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.probe.mock.invocationCallOrder[1]!,
  );
  expect(continued).toHaveBeenCalledExactlyOnceWith(false);
  expect(mocks.identity).not.toHaveBeenCalled();
  expect(mocks.call).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it.each(["target changed", "external supervisor"])(
  "does not offer personal setup or switch owners after %s",
  async (failure) => {
    mocks.probe.mockResolvedValueOnce({ ok: false });
    if (failure === "target changed") {
      mocks.bootstrap
        .mockResolvedValueOnce({ url: "wss://selected.example", auth: {} })
        .mockResolvedValueOnce({ url: "wss://another.example", auth: {} });
    }
    const continued = vi.fn();
    await expect(
      continueTerminalPersonalSetup(
        { status: "skipped", reason: failure === "external supervisor" ? "external" : "explicit" },
        { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        continued,
      ),
    ).rejects.toThrow();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(continued).not.toHaveBeenCalled();
    if (failure === "external supervisor") {
      expect(mocks.host).not.toHaveBeenCalled();
    }
  },
);

it("offers canonical existing people without requiring a raw profile ID", async () => {
  const p = prompter();
  p.select.mockResolvedValueOnce("setup").mockResolvedValueOnce("person:existing-person");
  const normal = mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation(async (options: CallGatewayCliOptions) => {
    const result = await normal(options);
    if (options.method === "device.profile.enroll") {
      return { ...result, profileId: "existing-person" };
    }
    if (options.method === "users.self" && options.useStoredDeviceAuth) {
      return { profile: { id: "existing-person" } };
    }
    return result;
  });
  await expect(offerTerminalPersonalSetup(p)).resolves.toMatchObject({
    profileId: "existing-person",
  });
  expect(mocks.call).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "device.profile.enroll",
      params: { profileId: "existing-person" },
    }),
  );
  expect(p.text).not.toHaveBeenCalled();
});

it("keeps a confirmed non-admin self without a directory, mutation, new UUID or credential write", async () => {
  mocks.load.mockResolvedValue({ token: "stored-personal" });
  const p = prompter();
  p.select.mockResolvedValueOnce("setup");
  await expect(offerTerminalPersonalSetup(p)).resolves.toMatchObject({ profileId: "person" });
  expect(mocks.call.mock.calls.map(([request]) => request.method)).toEqual([
    "users.self",
    "users.self",
  ]);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(p.text).not.toHaveBeenCalled();
});

it("reuses the same new-person intent after an uncertain mutation instead of generating another UUID", async () => {
  const normal = mocks.call.getMockImplementation()!;
  mocks.call.mockImplementation(async (options: CallGatewayCliOptions) => {
    if (options.method === "device.profile.enroll") {
      throw new Error("uncertain mutation response");
    }
    return await normal(options);
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = prompter();
    p.select.mockResolvedValueOnce("setup").mockResolvedValue("new");
    await expect(offerTerminalPersonalSetup(p)).rejects.toThrow(
      "openclaw devices enroll --enrollment-id",
    );
  }
  const intents = mocks.call.mock.calls
    .filter(([request]) => request.method === "device.profile.enroll")
    .map(([request]) => request.params.enrollmentId);
  expect(intents).toHaveLength(2);
  expect(intents[0]).toBe(intents[1]);
});
