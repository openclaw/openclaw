import assert from "node:assert/strict";
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
  withGatewayServiceUpdateAuthority as withAuthority,
} from "./service-update-authority.js";
import * as native from "./systemd-peer-native.js";

const initial = vi.hoisted(() => ({
  uid: 1000,
  pid: 1234,
  startTime: 100,
  alive: true,
  closes: 0,
  calls: 0,
}));
const kernel: Omit<typeof initial, "startTime"> & {
  startTime: number | null;
  onCall?: () => void;
} = { ...initial };
vi.mock("../shared/pid-alive.js", () => ({
  getProcessStartTime: () => kernel.startTime,
  isPidAlive: () => kernel.alive,
}));
vi.mock("@openclaw/proc-safe/systemd", async () => {
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
      connectUserManager: async () => connectPrivatePeer(),
    },
  };
});

beforeEach(() => {
  Object.assign(kernel, initial, { onCall: undefined });
});
afterEach(() => vi.restoreAllMocks());

const expected = { uid: 1000, pid: 1234, startTime: 100 };
const address = "unix:path=/synthetic-systemd-peer/private";
const deadline = () => performance.now() + 1000;
const openBroker = () => native.openSystemdBroker(address, deadline());
type Peer = Awaited<ReturnType<typeof openBroker>>;
async function usingPeer(work: (peer: Peer) => Promise<void>, open = openBroker) {
  const peer = await open();
  try {
    await work(peer);
  } finally {
    await peer.close();
  }
}
it.each([
  { name: "UID", change: { uid: 2001 }, ownership: true },
  { name: "PID", change: { pid: 4321 }, ownership: true },
  { name: "unreadable process", change: { startTime: null }, ownership: false },
  { name: "unavailable process", change: { alive: false }, ownership: false },
])("distinguishes ownership from unavailability: $name", async ({ change, ownership }) => {
  Object.assign(kernel, change);
  const operation = native.openSystemdPrivatePeer(address, expected, deadline());
  if (ownership) {
    await expect(operation).rejects.toMatchObject({ reason: "systemd-manager-changed" });
  } else {
    const failure = await operation.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ServiceOwnershipRefusalError);
  }
  expect(kernel.closes).toBe(1);
});

it.each([undefined, "peer-uid-mismatch"])(
  "translates only peer UID refusal: %s",
  async (reason) => {
    const failure = new ProcSafeError("access-denied", "socket access denied", {
      details: { reason },
    });
    vi.spyOn(SystemdBus, "connectUserManager").mockRejectedValueOnce(failure);
    const opening = native.openSystemdUserManager(address, deadline());
    if (reason) {
      await expect(opening).rejects.toMatchObject({ reason: "systemd-manager-changed" });
    } else {
      await expect(opening).rejects.toBe(failure);
    }
  },
);

it("distinguishes replaced peers from closed connections", async () => {
  const peer = await native.openSystemdPrivatePeer(address, expected, deadline());
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
  const work = withAuthority(
    () => assert(active, denied),
    async () => {
      active = false;
      await expect(openBroker()).rejects.toSatisfy(isAuthorityRevocation);
    },
  );
  await expect(work).rejects.toSatisfy(isAuthorityRevocation);
});

const resetFailed = ["call", ":1.42", "/unit", "org.test", "ResetFailedUnit", "s", "fixture"];

it.each(["queued", "dispatched"])("checks effect custody only before dispatch: %s", (phase) =>
  usingPeer(async (peer) => {
    let current = true;
    if (phase === "dispatched") {
      kernel.onCall = () => {
        current = false;
      };
    }
    const failure = new Error("effect custody expired");
    const guard = vi.fn(() => assert(current, failure));
    const work = peer.query(resetFailed, [], deadline(), () => {}, guard);
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

it.each(["healthy", "slow-io", "revoked", "mutation"] as const)(
  "separates caller guards from native deadlines: %s",
  async (mode) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const advance = (elapsed: number) => {
      now += elapsed;
    };
    const mutation = mode === "mutation";
    const mutationTimeout = mutation ? 100 : undefined;
    const inspect = async (peer: Peer, clock: { now(): number }) => {
      const guard = () => {
        if (mutation) {
          runServiceInspectionGuard(() => advance(kernel.calls ? 101 : 2_000));
        } else {
          advance(2_000);
        }
        if (mode === "revoked") {
          throw new Error("original guard retired");
        }
      };
      kernel.onCall = () => {
        if (!mutation) {
          advance(mode === "slow-io" ? 101 : 1);
        }
      };
      const until = clock.now() + 100;
      const work = peer.query(resetFailed, [], until, guard, undefined, mutationTimeout);
      if (mode === "healthy") {
        await expect(work).resolves.toEqual([]);
        expect(clock.now()).toBe(1);
      } else {
        await expect(work).rejects.toThrow(
          mode === "revoked" ? "original guard retired" : "deadline expired",
        );
        if (mutation) {
          expect(clock.now()).toBe(0);
        }
      }
      expect(kernel.calls).toBe(mode === "revoked" ? 0 : 1);
    };
    const open = () =>
      withServiceInspectionBudget((clock) => native.openSystemdBroker(address, clock.now() + 100));
    const run = () =>
      usingPeer((peer) => withServiceInspectionBudget((clock) => inspect(peer, clock)), open);
    if (mutation) {
      await withServiceInspectionBudget(run);
    } else {
      // Reads use their own clock, not the admission clock retained by a long-lived connection.
      await run();
    }
    expect(kernel.closes).toBe(1);
  },
);
