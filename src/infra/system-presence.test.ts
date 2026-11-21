import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitPresence,
  getSystemPresenceKey,
  listSystemPresence,
  touchPresence,
  updateSystemPresence,
  upsertPresence,
} from "./system-presence.js";

describe("system-presence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    listSystemPresence();
    vi.useRealTimers();
  });

  function connectDevice(deviceId: string, fields: Parameters<typeof upsertPresence>[1]) {
    upsertPresence(deviceId, { deviceId, reason: "connect", ...fields });
  }
  const findDevice = (deviceId: string) =>
    listSystemPresence().find((entry) => entry.deviceId === deviceId);
  const operators = () => listSystemPresence().filter((entry) => entry.roles?.includes("operator"));
  const expectOperators = (...rows: Parameters<typeof upsertPresence>[1][]) =>
    expect(operators()).toMatchObject(rows);

  it("keeps a replacement connection private until its own delivery commits", () => {
    const key = randomUUID();
    upsertPresence(key, { connectionId: "first", reason: "connect" }, { pending: true });
    upsertPresence(key, { connectionId: "replacement", reason: "connect" }, { pending: true });
    touchPresence(key);
    upsertPresence(key, { host: "updated host" });
    updateSystemPresence({ instanceId: key, text: "updated beacon" });

    commitPresence(key, "first");
    const replacement = expect.objectContaining({ connectionId: "replacement" });
    expect(listSystemPresence()).not.toContainEqual(replacement);
    expect(listSystemPresence({ includeConnectionId: "first" })).not.toContainEqual(replacement);
    expect(listSystemPresence({ includeConnectionId: "replacement" })).toContainEqual(
      expect.objectContaining({ connectionId: "replacement", host: "updated host" }),
    );

    commitPresence(key, "replacement");
    expect(listSystemPresence()).toContainEqual(replacement);
  });

  it("merges roles and scopes for the same device", () => {
    const deviceId = randomUUID();

    connectDevice(deviceId, { host: "openclaw", roles: ["operator"], scopes: ["operator.admin"] });
    connectDevice(deviceId, { roles: ["node"], scopes: ["system.run"] });
    expect(findDevice(deviceId)).toMatchObject({
      roles: ["operator", "node"],
      scopes: ["operator.admin", "system.run"],
    });
  });

  it("keeps live operator tabs and only the last offline row per identity until expiry", () => {
    vi.useFakeTimers();
    for (const identity of [
      { deviceId: "DEVICE", instanceId: "tab" },
      { instanceId: "INSTANCE" },
    ]) {
      const connect = (connectionId: string, watchedSessions: string[]) =>
        upsertPresence(connectionId, {
          deviceId: connectionId === "first" ? identity.deviceId : identity.deviceId?.toLowerCase(),
          instanceId: identity.deviceId ? connectionId : identity.instanceId.toLowerCase(),
          connectionId,
          roles: ["operator"],
          reason: "connect",
          watchedSessions,
        });
      const disconnect = (connectionId: string) =>
        upsertPresence(connectionId, { reason: "disconnect", watchedSessions: undefined });

      upsertPresence("node", { ...identity, roles: ["node"], reason: "connect" });

      connect("first", ["one"]);
      disconnect("first");
      expectOperators({ connectionId: "first", reason: "disconnect" });
      connect("second", ["two"]);
      expectOperators({ connectionId: "second", reason: "connect" });
      connect("third", ["three"]);
      expectOperators(
        { connectionId: "second", watchedSessions: ["two"] },
        { connectionId: "third", watchedSessions: ["three"] },
      );
      disconnect("second");
      expectOperators({ connectionId: "third", watchedSessions: ["three"] });
      disconnect("third");
      expectOperators({ connectionId: "third", reason: "disconnect", watchedSessions: undefined });
      expect(listSystemPresence().find((entry) => entry.roles?.includes("node"))).toMatchObject({
        reason: "connect",
      });
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(operators()).toEqual([]);
    }
    upsertPresence("anonymous-first", {
      connectionId: "anonymous-first",
      roles: ["operator"],
      reason: "disconnect",
    });
    upsertPresence("anonymous-second", {
      connectionId: "anonymous-second",
      roles: ["operator"],
      reason: "connect",
    });
    expect(operators()).toHaveLength(2);
  });

  it("normalizes beacon identity and preserves old presence values across refreshes", () => {
    const text =
      "Node: Relay-Host (10.0.0.9) · app 2.1.0 · last input 7s ago · mode ui · reason beacon";
    const instanceId = "  Mixed-Case-Node  ";
    const update = updateSystemPresence({ text, instanceId });

    expect([update.key, update.next.instanceId, update.changedKeys]).toEqual([
      "mixed-case-node",
      instanceId,
      ["host", "ip", "version", "mode", "reason"],
    ]);

    const normalized = { text, instanceId: "mixed-case-node" };
    const refreshed = updateSystemPresence({ ...normalized, lastInputSeconds: 11 });
    expect(getSystemPresenceKey(refreshed.next)).toBe(getSystemPresenceKey(update.next));
    expect(refreshed.changedKeys).toEqual([]);
    expect(refreshed.next.lastInputSeconds).toBe(11);
    expect(update.next.lastInputSeconds).toBe(7);

    const moved = updateSystemPresence({ ...normalized, ip: "10.0.0.10" });
    expect(moved.changedKeys).toEqual(["ip"]);
    expect(moved.next.ip).toBe("10.0.0.10");
    expect(refreshed.next.ip).toBe("10.0.0.9");
    updateSystemPresence({ ...normalized, lastInputSeconds: null });
    expect(
      listSystemPresence().find((entry) => entry.instanceId === normalized.instanceId),
    ).toMatchObject({
      host: "Relay-Host",
      lastInputSeconds: undefined,
    });
  });

  it("keeps fallback text keys UTF-16 safe", () => {
    const keyPrefix = `presence-${randomUUID()}`.padEnd(63, "x");
    const update = updateSystemPresence({ text: `${keyPrefix}🚀tail` });

    expect(update.key).toBe(keyPrefix);
  });

  it("keeps the gateway when the clock jumps forward during expiry pruning", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const self = listSystemPresence().find((entry) => entry.reason === "self");
    expect(self?.instanceId).toBeDefined();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 5 * 60 * 1000 + 1);
    expect(
      listSystemPresence().filter((entry) => entry.instanceId === self?.instanceId),
    ).toHaveLength(1);
  });

  it("keeps the genuine gateway row when a beacon uses its hostname key", () => {
    vi.useFakeTimers();
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
    const prefix = `collision-${randomUUID()}-`;
    for (let index = 0; index < 205; index += 1) {
      const deviceId = `${prefix}${index}`;
      upsertPresence(deviceId, { deviceId, host: deviceId, mode: "ui" });
    }
    const copyingSort = vi.spyOn(Array.prototype, "toSorted");
    const bounded = listSystemPresence();
    const copies = copyingSort.mock.calls.length;
    copyingSort.mockRestore();
    expect(copies).toBe(0);
    expect(bounded).toHaveLength(200);
    expect(bounded.filter((entry) => entry.text === self.text)).toHaveLength(1);
    expect(bounded.some((entry) => entry.text === forged.text)).toBe(false);
  });

  it("expires stale peers after five minutes while keeping the gateway", () => {
    vi.useFakeTimers();
    const deviceId = randomUUID();
    connectDevice(deviceId, { host: "stale-host", mode: "ui" });
    const original = findDevice(deviceId)!;
    expect(original).toBeDefined();

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    const entries = listSystemPresence();
    expect(entries.map((entry) => entry.deviceId)).not.toContain(deviceId);
    expect(entries.map((entry) => entry.reason)).toContain("self");
    connectDevice(deviceId, { host: "returned-host", mode: "ui" });
    const returned = findDevice(deviceId)!;
    expect(getSystemPresenceKey(returned)).not.toBe(getSystemPresenceKey(original));
  });
});
