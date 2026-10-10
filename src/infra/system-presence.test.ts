import { randomUUID } from "node:crypto";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitPresence,
  listSystemPresence,
  touchPresence,
  updateSystemPresence,
  upsertPresence,
} from "./system-presence.js";

function useFakePerformanceClock() {
  vi.useFakeTimers();
  vi.spyOn(os, "uptime").mockReturnValue(0);
}

function useFakeSuspendClock() {
  const clock = { monotonic: performance.now(), uptime: os.uptime() };
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => clock.monotonic);
  vi.spyOn(os, "uptime").mockImplementation(() => clock.uptime);
  return clock;
}

describe("system-presence", () => {
  afterEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    listSystemPresence();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a replacement connection private until its own delivery commits", () => {
    const key = randomUUID();
    upsertPresence(key, { connectionId: "first", reason: "connect" }, { pending: true });
    upsertPresence(key, { connectionId: "replacement", reason: "connect" }, { pending: true });
    touchPresence(key);
    upsertPresence(key, { host: "updated host" });
    updateSystemPresence({ instanceId: key, text: "updated beacon" });

    commitPresence(key, "first");
    expect(listSystemPresence().some((entry) => entry.connectionId === "replacement")).toBe(false);
    expect(
      listSystemPresence({ includeConnectionId: "first" }).some(
        (entry) => entry.connectionId === "replacement",
      ),
    ).toBe(false);
    expect(listSystemPresence({ includeConnectionId: "replacement" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connectionId: "replacement", host: "updated host" }),
      ]),
    );

    commitPresence(key, "replacement");
    expect(listSystemPresence()).toEqual(
      expect.arrayContaining([expect.objectContaining({ connectionId: "replacement" })]),
    );
  });

  it("merges roles and scopes for the same device", () => {
    const deviceId = randomUUID();

    upsertPresence(deviceId, {
      deviceId,
      host: "openclaw",
      roles: ["operator"],
      scopes: ["operator.admin"],
      reason: "connect",
    });

    upsertPresence(deviceId, {
      deviceId,
      roles: ["node"],
      scopes: ["system.run"],
      reason: "connect",
    });

    const entry = listSystemPresence().find((e) => e.deviceId === deviceId);
    expect(entry?.roles).toEqual(["operator", "node"]);
    expect(entry?.scopes).toEqual(["operator.admin", "system.run"]);
  });

  it("clears retained input activity on explicit null", () => {
    const instanceId = `presence-clear-${randomUUID()}`;
    updateSystemPresence({
      text: "Node: desk · mode ui",
      instanceId,
      host: "desk",
      mode: "ui",
      lastInputSeconds: 4,
    });

    updateSystemPresence({
      text: "Node: desk · mode ui",
      instanceId,
      host: "desk",
      mode: "ui",
      lastInputSeconds: null,
    });

    const entry = listSystemPresence().find((candidate) => candidate.instanceId === instanceId);
    expect(entry?.host).toBe("desk");
    expect(entry?.lastInputSeconds).toBeUndefined();
  });

  it("parses node presence text and normalizes the update key", () => {
    useFakePerformanceClock();
    vi.setSystemTime(new Date("2026-05-11T04:00:00.000Z"));
    const update = updateSystemPresence({
      text: "Node: Relay-Host (10.0.0.9) · app 2.1.0 · last input 7s ago · mode ui · reason beacon",
      instanceId: "  Mixed-Case-Node  ",
    });

    expect(update.key).toBe("mixed-case-node");
    expect(update.changedKeys).toEqual(["host", "ip", "version", "mode", "reason"]);
    expect({ key: update.key, changedKeys: update.changedKeys, next: update.next }).toEqual({
      key: "mixed-case-node",
      changedKeys: ["host", "ip", "version", "mode", "reason"],
      next: {
        instanceId: "  Mixed-Case-Node  ",
        lastInputSeconds: 7,
        text: "Node: Relay-Host (10.0.0.9) · app 2.1.0 · last input 7s ago · mode ui · reason beacon",
        ts: 1_778_472_000_000,
        host: "Relay-Host",
        ip: "10.0.0.9",
        version: "2.1.0",
        mode: "ui",
        reason: "beacon",
      },
    });

    const refreshed = updateSystemPresence({
      text: update.next.text,
      instanceId: "mixed-case-node",
      lastInputSeconds: 11,
    });
    expect(refreshed.changedKeys).toEqual([]);
    expect(refreshed.next.lastInputSeconds).toBe(11);
    expect(update.next.lastInputSeconds).toBe(7);

    const moved = updateSystemPresence({
      text: update.next.text,
      instanceId: "mixed-case-node",
      ip: "10.0.0.10",
    });
    expect(moved.changedKeys).toEqual(["ip"]);
    expect(moved.next.ip).toBe("10.0.0.10");
    expect(refreshed.next.ip).toBe("10.0.0.9");
  });

  it("keeps fallback text keys UTF-16 safe", () => {
    const keyPrefix = `presence-${randomUUID()}`.padEnd(63, "x");
    const update = updateSystemPresence({ text: `${keyPrefix}🚀tail` });

    expect(update.key).toBe(keyPrefix);
  });

  it("keeps the gateway when the clock jumps forward during expiry pruning", () => {
    useFakePerformanceClock();
    const now = Date.now();
    const self = listSystemPresence().find((entry) => entry.reason === "self");
    expect(self?.instanceId).toBeDefined();
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 5 * 60 * 1000 + 1);
    try {
      expect(
        listSystemPresence().filter((entry) => entry.instanceId === self?.instanceId),
      ).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  function addCapacityPeers(prefix: string) {
    for (let index = 0; index < 205; index += 1) {
      const deviceId = `${prefix}${index}`;
      upsertPresence(deviceId, { deviceId, host: deviceId, mode: "ui" });
    }
  }

  it("keeps the genuine gateway row when a beacon uses its hostname key", () => {
    useFakePerformanceClock();
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    const self = listSystemPresence().find((entry) => entry.reason === "self");
    if (!self?.host || !self.instanceId) {
      throw new Error("gateway presence was not initialized");
    }
    const forged = {
      deviceId: self.host,
      instanceId: self.instanceId,
      host: self.host,
      mode: "gateway",
      reason: "self",
      text: "caller-controlled gateway row",
    };
    updateSystemPresence(forged);
    const snapshot = listSystemPresence();
    expect(snapshot.filter((entry) => entry.text === self.text)).toHaveLength(1);
    expect(snapshot.filter((entry) => entry.text === forged.text)).toHaveLength(1);
    expect(snapshot.find((entry) => entry.text === self.text)?.deviceId).toBeUndefined();
    addCapacityPeers(`collision-${randomUUID()}-`);
    const bounded = listSystemPresence();
    expect(bounded).toHaveLength(200);
    expect(bounded.filter((entry) => entry.text === self.text)).toHaveLength(1);
    expect(bounded.some((entry) => entry.text === forged.text)).toBe(false);
  });

  it("preserves freshness across clock rollback without extending the TTL", () => {
    useFakePerformanceClock();
    const initialTime = Date.now();
    vi.setSystemTime(initialTime);

    const deviceId = randomUUID();
    upsertPresence(deviceId, {
      deviceId,
      host: "rollback-stale-host",
      mode: "ui",
      reason: "connect",
    });

    vi.setSystemTime(initialTime - 60 * 60 * 1000);

    expect(listSystemPresence().map((entry) => entry.deviceId)).toContain(deviceId);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const entries = listSystemPresence();
    expect(entries.map((entry) => entry.deviceId)).not.toContain(deviceId);
    expect(entries.map((entry) => entry.reason)).toContain("self");
  });

  it("keeps presence refreshed during rollback fresh when wall time recovers", () => {
    useFakePerformanceClock();
    const initialTime = Date.now();
    const forwardTime = initialTime + 24 * 60 * 60 * 1000;
    vi.setSystemTime(forwardTime);
    listSystemPresence();

    const deviceId = randomUUID();
    const rolledTime = initialTime - 60 * 60 * 1000;
    upsertPresence(deviceId, {
      deviceId,
      host: "rollback-refresh-host",
      mode: "ui",
      reason: "connect",
    });
    vi.setSystemTime(rolledTime);
    expect(touchPresence(deviceId)).toBe(true);

    vi.advanceTimersByTime(60 * 1000);
    vi.setSystemTime(forwardTime + 60 * 1000);

    const recovered = listSystemPresence().find((entry) => entry.deviceId === deviceId);
    expect(recovered?.ts).toBe(rolledTime);

    vi.advanceTimersByTime(4 * 60 * 1000 + 1);

    expect(listSystemPresence().map((entry) => entry.deviceId)).not.toContain(deviceId);
  });

  it("expires presence suspended while the wall clock remains rolled back", () => {
    const clock = useFakeSuspendClock();
    const initialTime = Date.now();
    vi.setSystemTime(initialTime);
    listSystemPresence();

    const deviceId = randomUUID();
    const rolledTime = initialTime - 60 * 60 * 1000;
    vi.setSystemTime(rolledTime);
    upsertPresence(deviceId, {
      deviceId,
      host: "rollback-suspended-host",
      mode: "ui",
      reason: "connect",
    });

    clock.uptime += 5 * 60 + 1;

    expect(listSystemPresence().map((entry) => entry.deviceId)).not.toContain(deviceId);
  });

  it("evicts stale presence before a peer refreshed during suspend and rollback", () => {
    const clock = useFakeSuspendClock();
    const initialTime = Date.now() + 24 * 60 * 60 * 1000;
    vi.setSystemTime(initialTime);
    listSystemPresence();

    const refreshedDeviceId = `rollback-refreshed-${randomUUID()}`;
    upsertPresence(refreshedDeviceId, {
      deviceId: refreshedDeviceId,
      host: "rollback-refreshed-host",
      mode: "ui",
      reason: "connect",
    });
    const staleDeviceId = `rollback-stale-${randomUUID()}`;
    upsertPresence(staleDeviceId, {
      deviceId: staleDeviceId,
      host: "rollback-stale-host",
      mode: "ui",
      reason: "connect",
    });

    vi.setSystemTime(initialTime - 60 * 60 * 1000);
    clock.uptime += 1;
    expect(touchPresence(refreshedDeviceId)).toBe(true);

    const freshPrefix = `rollback-fresh-${randomUUID()}-`;
    for (let index = 0; index < 198; index += 1) {
      upsertPresence(`${freshPrefix}${index}`, {
        deviceId: `${freshPrefix}${index}`,
        host: `rollback-fresh-host-${index}`,
        mode: "ui",
        reason: "connect",
      });
    }

    const entries = listSystemPresence();
    expect(entries.map((entry) => entry.deviceId)).not.toContain(staleDeviceId);
    expect(entries.map((entry) => entry.deviceId)).toContain(refreshedDeviceId);
    expect(entries.filter((entry) => entry.deviceId?.startsWith(freshPrefix))).toHaveLength(198);
    expect(entries.map((entry) => entry.reason)).toContain("self");
  });
});
