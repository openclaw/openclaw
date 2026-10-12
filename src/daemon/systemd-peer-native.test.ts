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

const kernel = vi.hoisted(() => {
  const state: {
    uid: number;
    pid: number;
    startTime: number | null;
    alive: boolean;
    closes: number;
    calls: number;
    onCall?: () => void;
  } = {
    uid: 1000,
    pid: 1234,
    startTime: 100,
    alive: true,
    closes: 0,
    calls: 0,
  };
  return state;
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

beforeEach(() => {
  Object.assign(kernel, {
    uid: 1000,
    pid: 1234,
    startTime: 100,
    alive: true,
    closes: 0,
    calls: 0,
    onCall: undefined,
  });
});
afterEach(() => vi.restoreAllMocks());

const expected = { uid: 1000, pid: 1234, startTime: 100 };
const address = "unix:path=/synthetic-systemd-peer/private";

it.each([
  { name: "UID", change: { uid: 2001 }, ownership: true, initial: false },
  { name: "PID", change: { pid: 4321 }, ownership: true, initial: false },
  { name: "process generation", change: { startTime: 200 }, ownership: true, initial: false },
  { name: "unreadable process", change: { startTime: null }, ownership: false, initial: false },
  { name: "unavailable process", change: { alive: false }, ownership: false, initial: false },
  { name: "initial account", change: { uid: 2001 }, ownership: true, initial: true },
])(
  "distinguishes observed ownership refusals from unavailable peers: $name",
  async ({ change, ownership, initial }) => {
    Object.assign(kernel, change);
    if (initial) {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(process, "geteuid").mockReturnValue(1000);
    }
    const operation = initial
      ? openSystemdUserManager(address, performance.now() + 1000)
      : openSystemdPrivatePeer(address, expected, performance.now() + 1000);
    if (ownership) {
      await expect(operation).rejects.toMatchObject({ reason: "systemd-manager-changed" });
    } else {
      const failure = await operation.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(ServiceOwnershipRefusalError);
    }
    expect(kernel.closes).toBe(1);
  },
);

it("preserves transport access refusal without claiming a different manager owner", async () => {
  const failure = new ProcSafeError("access-denied", "socket access denied");
  vi.spyOn(SystemdBus, "connectUserManager").mockRejectedValueOnce(failure);
  await expect(openSystemdUserManager(address, performance.now() + 1000)).rejects.toBe(failure);
});

it("revalidates a retained peer without misclassifying a closed connection", async () => {
  const peer = await openSystemdPrivatePeer(address, expected, performance.now() + 1000);
  kernel.startTime = 200;
  expect(() => peer.verify()).toThrow(ServiceOwnershipRefusalError);
  await peer.close();
  expect(() => peer.verify()).toThrow("peer inspection is unavailable");
  expect(kernel.closes).toBe(1);
});

it("checks inherited update authority before loading or opening a native transport", async () => {
  const denied = new Error("original update grant retired");
  const isAuthorityRevocation = (error: unknown) =>
    error instanceof GatewayServiceAuthorityError && error.cause === denied;
  let active = true;
  let transportFailure: unknown;
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (!active) {
          throw denied;
        }
      },
      async () => {
        active = false;
        try {
          await openSystemdBroker(
            "unix:path=/nonexistent-openclaw-test/bus",
            performance.now() + 100,
          );
        } catch (error) {
          transportFailure = error;
        }
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

it("checks effect custody inside the consumer queue immediately before dispatch", async () => {
  const peer = await openSystemdBroker(address, performance.now() + 1000);
  let current = true;
  const failure = new Error("effect custody expired while queued");
  try {
    const queued = peer.query(
      resetFailed,
      [],
      performance.now() + 1000,
      () => {},
      () => {
        if (!current) {
          throw failure;
        }
      },
    );
    current = false;
    await expect(queued).rejects.toBe(failure);
    expect(kernel.calls).toBe(0);
  } finally {
    await peer.close();
  }
});

it("does not require effect custody after the native call intentionally ends it", async () => {
  const peer = await openSystemdBroker(address, performance.now() + 1000);
  let current = true;
  kernel.onCall = () => {
    current = false;
  };
  const guard = vi.fn(() => {
    if (!current) {
      throw new Error("effect already happened");
    }
  });
  try {
    await expect(
      peer.query(resetFailed, [], performance.now() + 1000, () => {}, guard),
    ).resolves.toEqual([]);
    expect(guard).toHaveBeenCalledOnce();
    expect(kernel.calls).toBe(1);
  } finally {
    await peer.close();
  }
});

it.each(["healthy", "slow-io", "revoked"] as const)(
  "retained native queries separate caller guards from manager I/O: %s",
  async (mode) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // Admission's clock must not be retained by later reads on this connection.
    const peer = await withServiceInspectionBudget((budget) =>
      openSystemdBroker(address, budget.now() + 100),
    );
    try {
      await withServiceInspectionBudget(async (budget) => {
        const guard = () => {
          now += 2_000;
          if (mode === "revoked") {
            throw new Error("original guard retired");
          }
        };
        kernel.onCall = () => {
          now += mode === "slow-io" ? 101 : 1;
        };
        const work = peer.query(resetFailed, [], budget.now() + 100, guard);
        if (mode === "healthy") {
          await expect(work).resolves.toEqual([]);
          expect(budget.now()).toBe(1);
        } else {
          await expect(work).rejects.toThrow(
            mode === "revoked" ? "original guard retired" : "deadline expired",
          );
        }
        expect(kernel.calls).toBe(mode === "revoked" ? 0 : 1);
      });
    } finally {
      await peer.close();
    }
    expect(kernel.closes).toBe(1);
  },
);

it("keeps the dispatched mutation wall deadline despite later synchronous guards", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  await withServiceInspectionBudget(async (budget) => {
    const peer = await openSystemdBroker(address, budget.now() + 100);
    let dispatched = false;
    kernel.onCall = () => {
      dispatched = true;
    };
    try {
      await expect(
        peer.query(
          resetFailed,
          [],
          budget.now() + 100,
          () => {
            runServiceInspectionGuard(() => {
              now += dispatched ? 101 : 2_000;
            });
          },
          undefined,
          100,
        ),
      ).rejects.toThrow("deadline expired");
      expect(kernel.calls).toBe(1);
      expect(budget.now()).toBe(0);
    } finally {
      await peer.close();
    }
  });
});
