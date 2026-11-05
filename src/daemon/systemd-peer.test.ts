import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { execFileUtf8 } from "./exec-file.js";
import { ServiceOwnershipRefusalError } from "./service-inspection-error.js";
import { nativeExit } from "./systemd-exec.test-support.js";
import { openSystemdBroker, openSystemdPrivatePeer } from "./systemd-peer-native.js";
import { admitSystemdServiceReadBinding } from "./systemd-peer.js";
import { systemdManagerVersionProbe } from "./systemd-user-bus.test-support.js";

vi.mock("./exec-file.js", () => ({ execFileUtf8: vi.fn() }));

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
const dirs = useAutoCleanupTempDirTracker(afterEach);
const env = {
  HOME: "/home/test",
  XDG_RUNTIME_DIR: "/custom/runtime",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus",
};
const admit = (selected: Parameters<typeof admitSystemdServiceReadBinding>[0] = env) =>
  admitSystemdServiceReadBinding(selected, performance.now() + 1000);
const broker = () => ({ query, close: closeBroker, verify: () => {} });
function replies(...values: (string | number)[]) {
  for (const value of values) {
    query.mockResolvedValueOnce([[value]]);
  }
}
function expectBroker(address = env.DBUS_SESSION_BUS_ADDRESS) {
  expect(openSystemdBroker).toHaveBeenCalledExactlyOnceWith(address, expect.any(Number));
}
function expectNoPeer() {
  expect(openSystemdBroker).toHaveBeenCalledOnce();
  expect(openSystemdPrivatePeer).not.toHaveBeenCalled();
  expect(closeBroker).toHaveBeenCalledOnce();
}

beforeEach(() => {
  vi.resetAllMocks();
  mockProcessPlatform("linux");
  vi.spyOn(process, "geteuid").mockReturnValue(1000);
  vi.stubEnv("SUDO_USER", undefined);
  vi.mocked(execFileUtf8).mockImplementation(async (command, args, options) => {
    await systemdManagerVersionProbe(command, args);
    const stale = options?.env?.DBUS_SESSION_BUS_ADDRESS === "unix:path=/tmp/dbus-stale";
    return nativeExit(
      stale ? "" : 's "252.39"',
      stale ? "No manager on this broker" : "",
      stale ? 1 : 0,
    );
  });
  query.mockImplementation(async (args) => [
    [args[4] === "GetNameOwner" ? ":1.0" : args[4] === "GetConnectionUnixUser" ? 1000 : 1234],
  ]);
  vi.mocked(openSystemdBroker).mockResolvedValue(broker());
  vi.mocked(openSystemdPrivatePeer).mockResolvedValue({ ...broker(), close: closePeer });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("pins the broker despite ambient selector changes", async () => {
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", env.DBUS_SESSION_BUS_ADDRESS);
  vi.stubEnv("XDG_RUNTIME_DIR", env.XDG_RUNTIME_DIR);
  vi.mocked(openSystemdBroker).mockImplementation(async () => {
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/other/bus");
    vi.stubEnv("XDG_RUNTIME_DIR", "/other/runtime");
    return broker();
  });
  const binding = await admit({ HOME: env.HOME });
  expect(binding).toBeDefined();
  expectBroker();
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

it("preserves unsettled transport probe cleanup instead of admitting a fallback", async () => {
  const failure = new CommandProcessCleanupError();
  vi.mocked(execFileUtf8).mockRejectedValueOnce(failure);
  await expect(
    admit({ ...env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/unsettled-bus" }),
  ).rejects.toBe(failure);
  expect(openSystemdBroker).not.toHaveBeenCalled();
  expect(openSystemdPrivatePeer).not.toHaveBeenCalled();
});

it("replaces stale shell addresses with the runtime bus", async () => {
  const runtime = dirs.make("openclaw-broker-route-,");
  await fs.writeFile(path.join(runtime, "bus"), "");
  const binding = await admit({
    ...env,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-stale",
  });
  expectBroker(`unix:path=${path.posix.join(runtime, "bus").replaceAll(",", "%2C")}`);
  expect(binding).toBeDefined();
  await binding?.close();
});

it("preserves a working custom broker when an unrelated runtime socket exists", async () => {
  const runtime = dirs.make("openclaw-custom-broker-");
  await fs.writeFile(path.join(runtime, "bus"), "");
  const binding = await admitSystemdServiceReadBinding(
    { ...env, XDG_RUNTIME_DIR: runtime },
    performance.now() + 1000,
  );
  expect(openSystemdBroker).toHaveBeenCalledExactlyOnceWith(
    env.DBUS_SESSION_BUS_ADDRESS,
    expect.any(Number),
  );
  expect(binding).toBeDefined();
  await binding?.close();
});

it("refuses broker loss between credential observations without reconnecting", async () => {
  query
    .mockResolvedValueOnce([[":1.0"]])
    .mockRejectedValueOnce(new Error("original broker disconnected"));
  expect(await admit()).toBeUndefined();
  expect(openSystemdBroker).toHaveBeenCalledOnce();
  expectNoPeer();
});

it.each([
  { changed: "account", values: [":1.0", 2001] },
  { changed: "process", values: [":1.0", 1000, 1234, ":1.0", 4321] },
  { changed: "manager", values: [":1.0", 1000, 1234, ":1.1"] },
  { changed: "native peer", values: [] },
])("preserves $changed refusal without fallback", async ({ changed, values }) => {
  replies(...values);
  if (changed === "native peer") {
    vi.mocked(openSystemdPrivatePeer).mockRejectedValueOnce(
      new ServiceOwnershipRefusalError("systemd-manager-changed"),
    );
  }
  await expect(admit()).rejects.toMatchObject({ reason: "systemd-manager-changed" });
  if (changed === "manager") {
    expect(closePeer).toHaveBeenCalledOnce();
  }
  expect(openSystemdBroker).toHaveBeenCalledOnce();
  expect(closeBroker).toHaveBeenCalledOnce();
});

it.each([null, -1, 0xffffffff, 1000.5, "1000"])(
  "keeps malformed manager UID %j diagnostic",
  async (uid) => {
    query.mockResolvedValueOnce([[":1.0"]]).mockResolvedValueOnce([[uid]]);
    expect(await admitSystemdServiceReadBinding(env, performance.now() + 1000)).toBeUndefined();
    expect(openSystemdPrivatePeer).not.toHaveBeenCalled();
    expect(closeBroker).toHaveBeenCalledOnce();
  },
);

it.each([
  "unixexec:path=/usr/bin/helper",
  "tcp:host=example.invalid,port=1234",
  "x-machine-unix:machine=container",
  "unix:path=/custom/bus;unixexec:path=/usr/bin/helper",
  "unix:path=/custom/bus;tcp:host=example.invalid,port=1234",
  "unix:path=/custom/bus,abstract=other",
])("leaves unsupported transport %s unopened", async (address) => {
  expect(await admit({ ...env, DBUS_SESSION_BUS_ADDRESS: address })).toBeUndefined();
  expect(openSystemdBroker).not.toHaveBeenCalled();
  expect(openSystemdPrivatePeer).not.toHaveBeenCalled();
});

it("preserves a custom abstract local Unix route", async () => {
  const address = "unix:abstract=/tmp/custom%2Cbus,guid=0123456789abcdef0123456789abcdef";
  const binding = await admit({ ...env, DBUS_SESSION_BUS_ADDRESS: address });
  expect(binding).toBeDefined();
  expect(openSystemdBroker).toHaveBeenCalledWith(address, expect.any(Number));
  await binding?.close();
});

it("admits the selected runtime bus after a stale nonlocal address", async () => {
  const runtime = dirs.make("openclaw-nonlocal-fallback-");
  await fs.writeFile(path.join(runtime, "bus"), "");
  vi.mocked(execFileUtf8).mockResolvedValueOnce(
    nativeExit("", "Failed to connect to bus: Connection refused", 1),
  );
  const binding = await admitSystemdServiceReadBinding(
    {
      ...env,
      XDG_RUNTIME_DIR: runtime,
      DBUS_SESSION_BUS_ADDRESS: "tcp:host=example.invalid,port=1234",
    },
    performance.now() + 1000,
  );
  expect(binding).toBeDefined();
  expect(openSystemdBroker).toHaveBeenCalledExactlyOnceWith(
    `unix:path=${runtime}/bus`,
    expect.any(Number),
  );
  expect(execFileUtf8).toHaveBeenCalledTimes(2);
  await binding?.close();
});
