import { ProcSafeError } from "@openclaw/proc-safe/errors";
import { SystemdBus } from "@openclaw/proc-safe/systemd";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  withServiceInspectionBudget,
  runServiceInspectionGuard,
} from "./service-inspection-budget.js";
import { ServiceOwnershipRefusalError } from "./service-inspection-error.js";
import {
  GatewayServiceAuthorityError,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";
import {
  openSystemdBroker,
  openSystemdPrivatePeer,
  openSystemdUserManager,
} from "./systemd-peer-native.js";

const { kernel, resetKernel } = vi.hoisted(() => {
  const defaults = () => ({
    uid: 1000,
    pid: 1234,
    startTime: 100,
    alive: true,
    closes: 0,
    calls: 0,
  });
  const state: {
    uid: number;
    pid: number;
    startTime: number | null;
    alive: boolean;
    closes: number;
    calls: number;
    onCall?: () => void;
  } = defaults();
  return {
    kernel: state,
    resetKernel: () => {
      Object.assign(state, defaults(), { onCall: undefined });
    },
  };
});
vi.mock("../shared/pid-alive.js", () => ({
  getProcessStartTime: () => kernel.startTime,
  isPidAlive: () => kernel.alive,
}));
vi.mock("@openclaw/proc-safe/systemd", async () => {
  const { ProcSafeError: PackageError } = await import("@openclaw/proc-safe/errors");
  const connect = () => ({
    close: async () => {
      kernel.closes++;
    },
    call: async () => {
      kernel.calls++;
      kernel.onCall?.();
      return [];
    },
  });
  const connectPrivatePeer = async () => ({
    ...connect(),
    peer: Object.freeze({ pid: kernel.pid, uid: kernel.uid }),
  });
  return {
    SystemdBus: {
      connectPrivatePeer,
      connectBroker: async () => connect(),
      connectUserManager: async () => {
        const expectedUid = process.geteuid?.();
        if (kernel.uid !== expectedUid) {
          kernel.closes++;
          throw new PackageError("access-denied", "user manager peer has a different UID", {
            details: { reason: "peer-uid-mismatch", expectedUid, actualUid: kernel.uid },
          });
        }
        return connectPrivatePeer();
      },
    },
  };
});

beforeEach(resetKernel);
afterEach(() => vi.restoreAllMocks());

const expected = { uid: 1000, pid: 1234, startTime: 100 };
const address = "unix:path=/synthetic-systemd-peer/private";
const deadline = () => performance.now() + 1000;
const openBroker = () => openSystemdBroker(address, deadline());
type Peer = Awaited<ReturnType<typeof openBroker>>;
async function usingPeer(work: (peer: Peer) => Promise<void>, open = openBroker) {
  const peer = await open();
  try {
    await work(peer);
  } finally {
    await peer.close();
  }
}
function requireCurrent(current: () => boolean, failure: Error) {
  return () => {
    if (!current()) {
      throw failure;
    }
  };
}
const query = (peer: Peer, guard?: () => void, effect?: () => void) =>
  peer.query(resetFailed, [], deadline(), guard, effect);
function mockClock() {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return (elapsed: number) => {
    now += elapsed;
  };
}

it.each([
  { name: "UID", change: { uid: 2001 }, ownership: true },
  { name: "PID", change: { pid: 4321 }, ownership: true },
  { name: "process generation", change: { startTime: 200 }, ownership: true },
  { name: "unreadable process", change: { startTime: null }, ownership: false },
  { name: "unavailable process", change: { alive: false }, ownership: false },
  { name: "initial account", change: { uid: 2001 }, ownership: true, initial: true },
])("distinguishes ownership from unavailability: $name", async ({ change, ownership, initial }) => {
  Object.assign(kernel, change);
  if (initial) {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(process, "geteuid").mockReturnValue(1000);
  }
  const operation = initial
    ? openSystemdUserManager(address, deadline())
    : openSystemdPrivatePeer(address, expected, deadline());
  if (ownership) {
    await expect(operation).rejects.toMatchObject({ reason: "systemd-manager-changed" });
  } else {
    const failure = await operation.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ServiceOwnershipRefusalError);
  }
  expect(kernel.closes).toBe(1);
});

it("preserves transport access refusal", async () => {
  const failure = new ProcSafeError("access-denied", "socket access denied");
  vi.spyOn(SystemdBus, "connectUserManager").mockRejectedValueOnce(failure);
  await expect(openSystemdUserManager(address, deadline())).rejects.toBe(failure);
});

it("distinguishes replaced peers from closed connections", async () => {
  const peer = await openSystemdPrivatePeer(address, expected, deadline());
  kernel.startTime = 200;
  expect(() => peer.verify()).toThrow(ServiceOwnershipRefusalError);
  await peer.close();
  expect(() => peer.verify()).toThrow("peer inspection is unavailable");
  expect(kernel.closes).toBe(1);
});

it("checks update authority before opening transport", async () => {
  const denied = new Error("original update grant retired");
  const isAuthorityRevocation = (error: unknown) =>
    error instanceof GatewayServiceAuthorityError && error.cause === denied;
  let active = true;
  let transportFailure: unknown;
  await expect(
    withGatewayServiceUpdateAuthority(
      requireCurrent(() => active, denied),
      async () => {
        active = false;
        transportFailure = await openSystemdBroker(
          "unix:path=/nonexistent-openclaw-test/bus",
          performance.now() + 100,
        ).catch((error: unknown) => error);
      },
    ),
  ).rejects.toSatisfy(isAuthorityRevocation);
  expect(transportFailure).toSatisfy(isAuthorityRevocation);
});

const resetFailed = [
  "call",
  ":1.42",
  "/org/freedesktop/systemd1",
  "org.freedesktop.systemd1.Manager",
  "ResetFailedUnit",
  "s",
  "fixture.service",
];

it.each(["queued", "dispatched"])("checks effect custody only before dispatch: %s", (phase) =>
  usingPeer(async (peer) => {
    let current = true;
    if (phase === "dispatched") {
      kernel.onCall = () => {
        current = false;
      };
    }
    const failure = new Error("effect custody expired");
    const guard = vi.fn(requireCurrent(() => current, failure));
    const work = query(peer, () => {}, guard);
    if (phase === "queued") {
      current = false;
      await expect(work).rejects.toBe(failure);
    } else {
      await expect(work).resolves.toEqual([]);
      expect(guard).toHaveBeenCalledOnce();
    }
    expect(kernel.calls).toBe(phase === "queued" ? 0 : 1);
  }),
);

it.each(["healthy", "slow-io", "revoked"] as const)(
  "separates caller guards from manager I/O: %s",
  async (mode) => {
    const advance = mockClock();
    // Admission's clock must not be retained by later reads on this connection.
    await usingPeer(
      (peer) =>
        withServiceInspectionBudget(async (clock) => {
          const guard = () => {
            advance(2_000);
            if (mode === "revoked") {
              throw new Error("original guard retired");
            }
          };
          kernel.onCall = () => {
            advance(mode === "slow-io" ? 101 : 1);
          };
          const work = peer.query(resetFailed, [], clock.now() + 100, guard);
          if (mode === "healthy") {
            await expect(work).resolves.toEqual([]);
            expect(clock.now()).toBe(1);
          } else {
            await expect(work).rejects.toThrow(
              mode === "revoked" ? "original guard retired" : "deadline expired",
            );
          }
          expect(kernel.calls).toBe(mode === "revoked" ? 0 : 1);
        }),
      () => withServiceInspectionBudget((clock) => openSystemdBroker(address, clock.now() + 100)),
    );
    expect(kernel.closes).toBe(1);
  },
);

it("keeps mutation wall deadlines across synchronous guards", async () => {
  const advance = mockClock();
  await withServiceInspectionBudget(async (clock) => {
    let dispatched = false;
    kernel.onCall = () => {
      dispatched = true;
    };
    await usingPeer(
      async (peer) => {
        const guard = () => runServiceInspectionGuard(() => advance(dispatched ? 101 : 2_000));
        await expect(
          peer.query(resetFailed, [], clock.now() + 100, guard, undefined, 100),
        ).rejects.toThrow("deadline expired");
        expect(kernel.calls).toBe(1);
        expect(clock.now()).toBe(0);
      },
      () => openSystemdBroker(address, clock.now() + 100),
    );
  });
});
