import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { openSystemdBroker, openSystemdPrivatePeer } from "./systemd-peer-native.js";
import { admitSystemdServiceReadBinding } from "./systemd-peer.js";

vi.mock("../shared/pid-alive.js", () => ({
  getProcessStartTime: () => 100,
  isPidAlive: () => true,
}));
vi.mock("./systemd-service-files.js", () => ({
  resolveSystemdServiceName: () => "openclaw-gateway-test",
}));
vi.mock("./systemd-peer-native.js", () => ({
  openSystemdBroker: vi.fn(),
  openSystemdPrivatePeer: vi.fn(),
}));
const query = vi.fn<Awaited<ReturnType<typeof openSystemdBroker>>["query"]>();
const closeBroker = vi.fn(async () => {});
const closePeer = vi.fn(async () => {});
const env = {
  HOME: "/home/test",
  XDG_RUNTIME_DIR: "/custom/runtime",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus",
};

beforeEach(() => {
  vi.resetAllMocks();
  mockProcessPlatform("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(1000);
  vi.stubEnv("SUDO_USER", undefined);
  query.mockImplementation(async (args) => [
    [args[4] === "GetNameOwner" ? ":1.0" : args[4] === "GetConnectionUnixUser" ? 1000 : 1234],
  ]);
  vi.mocked(openSystemdBroker).mockResolvedValue({ query, close: closeBroker, verify: () => {} });
  vi.mocked(openSystemdPrivatePeer).mockResolvedValue({
    query,
    close: closePeer,
    verify: () => {},
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("keeps one captured broker connection despite ambient selector changes", async () => {
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", env.DBUS_SESSION_BUS_ADDRESS);
  vi.stubEnv("XDG_RUNTIME_DIR", env.XDG_RUNTIME_DIR);
  vi.mocked(openSystemdBroker).mockImplementation(async () => {
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/other/bus");
    vi.stubEnv("XDG_RUNTIME_DIR", "/other/runtime");
    return { query, close: closeBroker, verify: () => {} };
  });
  const binding = await admitSystemdServiceReadBinding(
    { HOME: env.HOME },
    performance.now() + 1000,
  );
  expect(binding).toBeDefined();
  expect(openSystemdBroker).toHaveBeenCalledExactlyOnceWith(
    env.DBUS_SESSION_BUS_ADDRESS,
    expect.any(Number),
  );
  expect(openSystemdPrivatePeer).toHaveBeenCalledWith(
    "unix:path=/custom/runtime/systemd/private",
    { uid: 1000, pid: 1234, startTime: 100 },
    expect.any(Number),
  );
  expect(closeBroker).toHaveBeenCalledOnce();
  expect(closePeer).not.toHaveBeenCalled();
  await binding?.close();
});

it("does not admit another route when the authored broker is unavailable", async () => {
  vi.mocked(openSystemdBroker).mockRejectedValue(new Error("broker unavailable"));
  expect(await admitSystemdServiceReadBinding(env, performance.now() + 1000)).toBeUndefined();
  expect(openSystemdBroker).toHaveBeenCalledOnce();
  expect(openSystemdPrivatePeer).not.toHaveBeenCalled();
});

it("refuses broker loss between credential observations without reconnecting", async () => {
  query
    .mockResolvedValueOnce([[":1.0"]])
    .mockRejectedValueOnce(new Error("original broker disconnected"));
  expect(await admitSystemdServiceReadBinding(env, performance.now() + 1000)).toBeUndefined();
  expect(openSystemdBroker).toHaveBeenCalledOnce();
  expect(openSystemdPrivatePeer).not.toHaveBeenCalled();
  expect(closeBroker).toHaveBeenCalledOnce();
});

it("disposes the peer if the original manager changes before admission completes", async () => {
  query
    .mockResolvedValueOnce([[":1.0"]])
    .mockResolvedValueOnce([[1000]])
    .mockResolvedValueOnce([[1234]])
    .mockResolvedValueOnce([[":1.1"]]);
  expect(await admitSystemdServiceReadBinding(env, performance.now() + 1000)).toBeUndefined();
  expect(closePeer).toHaveBeenCalledOnce();
  expect(closeBroker).toHaveBeenCalledOnce();
});

it.each([
  "unixexec:path=/usr/bin/helper",
  "tcp:host=example.invalid,port=1234",
  "x-machine-unix:machine=container",
  "unix:path=/custom/bus;unixexec:path=/usr/bin/helper",
  "unix:path=/custom/bus;tcp:host=example.invalid,port=1234",
  "unix:path=/custom/bus,abstract=other",
])(
  "leaves unsupported transport %s to the existing adapter without opening it",
  async (address) => {
    expect(
      await admitSystemdServiceReadBinding(
        { ...env, DBUS_SESSION_BUS_ADDRESS: address },
        performance.now() + 1000,
      ),
    ).toBeUndefined();
    expect(openSystemdBroker).not.toHaveBeenCalled();
    expect(openSystemdPrivatePeer).not.toHaveBeenCalled();
  },
);

it("preserves a custom abstract local Unix route", async () => {
  const address = "unix:abstract=/tmp/custom%2Cbus,guid=0123456789abcdef0123456789abcdef";
  const binding = await admitSystemdServiceReadBinding(
    { ...env, DBUS_SESSION_BUS_ADDRESS: address },
    performance.now() + 1000,
  );
  expect(binding).toBeDefined();
  expect(openSystemdBroker).toHaveBeenCalledWith(address, expect.any(Number));
  await binding?.close();
});
