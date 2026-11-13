import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDevicesCli } from "./devices-cli.js";
import { parseCliProfileArgs } from "./profile.js";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  bootstrap: vi.fn(),
  identity: vi.fn(),
  store: vi.fn(),
  originStore: vi.fn(),
  log: vi.fn(),
  writeJson: vi.fn(),
}));
// mock-isolation: Use fixture configuration without loading user configuration or process-wide config state.
vi.mock("../config/config.js", () => ({ loadConfig: () => ({}) }));
// mock-isolation: Keep Gateway network transport outside this CLI enrollment fixture.
vi.mock("../gateway/call.js", () => ({ callGateway: mocks.call }));
// mock-isolation: Pin the fixture Gateway target without discovering local credentials or endpoints.
vi.mock("../gateway/client-bootstrap.js", () => ({
  resolveGatewayClientBootstrap: mocks.bootstrap,
}));
// mock-isolation: Use synthetic device identity without creating keys on disk.
vi.mock("../infra/device-identity-async.js", () => ({
  loadOrCreateDeviceIdentityAsync: mocks.identity,
}));
// mock-isolation: Observe credential persistence without reading or modifying real device tokens.
vi.mock("../infra/device-auth-store.js", () => ({
  loadDeviceAuthTokenReadOnly: vi.fn(async () => null),
  loadOriginDeviceTokenReadOnly: vi.fn(async () => null),
  storeDeviceAuthToken: mocks.store,
  storeOriginDeviceToken: mocks.originStore,
}));
// mock-isolation: Capture CLI output without writing to process stdout or exiting.
vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: mocks.log, writeJson: mocks.writeJson },
}));
// mock-isolation: Do not initialize the real Gateway state database in this transport fixture.
vi.mock("./gateway-rpc.runtime.js", () => ({ prepareCliGatewayStateAccess: async () => {} }));

const enrollmentId = "8fb6249a-11ba-4e13-9a15-14bfb8b7571e";
const token = { token: "synthetic-enrollment-token", scopes: ["operator.read"] };
async function run(...args: string[]) {
  const program = new Command().exitOverride();
  registerDevicesCli(program);
  const parsed = parseCliProfileArgs(["node", "openclaw", "devices", "enroll", ...args]);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  expect(parsed.profile).toBeNull();
  await program.parseAsync(parsed.argv);
}

describe("explicit CLI operator enrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.identity.mockResolvedValue({ deviceId: "this-cli", publicKey: "synthetic-key" });
    mocks.bootstrap.mockResolvedValue({
      url: "wss://gateway.example",
      deviceAuthScope: "wss://gateway.example",
    });
    mocks.call.mockImplementation(async (options) => {
      if (options.method === "users.self") {
        options.onHelloOk({ auth: { method: "device-token" } });
        options.assertDispatchCurrent();
        return { profile: { id: "person" } };
      }
      return { deviceId: "this-cli", profileId: "person", operatorToken: token };
    });
    mocks.store.mockResolvedValue(token);
    mocks.originStore.mockResolvedValue(token);
  });

  it("pins the target, explicitly supplies device identity and saves only the self token in its target scope", async () => {
    await run("--name", "Alex", "--enrollment-id", enrollmentId, "--json");
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "device.profile.enroll",
        expectUrl: "wss://gateway.example",
        deviceIdentity: expect.objectContaining({ deviceId: "this-cli" }),
        clientName: "cli",
        mode: "cli",
        params: { name: "Alex", enrollmentId },
      }),
    );
    expect(mocks.identity).toHaveBeenCalledWith({ identityKey: "interactive-operator" });
    expect(mocks.originStore).toHaveBeenCalledWith({
      deviceId: "this-cli",
      role: "operator",
      ...token,
      gatewayScope: "wss://gateway.example",
    });
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.writeJson).toHaveBeenCalledWith({ deviceId: "this-cli", profileId: "person" });
    expect(mocks.log).not.toHaveBeenCalled();
    expect(JSON.stringify([mocks.log.mock.calls, mocks.writeJson.mock.calls])).not.toContain(
      token.token,
    );
  });

  it("selects an existing person for another device without creating a CLI identity or accepting its credential", async () => {
    mocks.call.mockResolvedValue({ deviceId: "another-device", profileId: "existing-person" });
    await run("--device", "another-device", "--person", "existing-person");
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { deviceId: "another-device", profileId: "existing-person" },
      }),
    );
    expect(mocks.originStore).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("refuses competing person selections before any enrollment effect", async () => {
    await expect(run("--person", "existing-person", "--name", "Another")).rejects.toThrow(
      "Choose --person",
    );
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it("retains the enrollment ID after an uncertain response without replaying", async () => {
    mocks.call.mockRejectedValue(new Error("connection lost"));
    await expect(run("--name", "Alex", "--enrollment-id", enrollmentId)).rejects.toThrow(
      enrollmentId,
    );
    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(mocks.originStore).not.toHaveBeenCalled();
  });
});
