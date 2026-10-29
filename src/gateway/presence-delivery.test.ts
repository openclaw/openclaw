import { describe, expect, it, vi } from "vitest";
import type { PresenceDelta } from "../../packages/gateway-protocol/src/presence-deltas.js";
import {
  getSystemPresenceKey,
  listSystemPresence,
  upsertPresence,
} from "../infra/system-presence.js";
import { preparePresenceDelivery } from "./presence-delivery.js";
import type { GatewayWsClient } from "./server/ws-types.js";

describe("presence wire size", () => {
  it("encodes interleaved audiences and delivery baselines once per publication", () => {
    upsertPresence("shared-delivery", { text: "x".repeat(400), watchedSessions: ["visible"] });
    const source = listSystemPresence().filter((row) => row.watchedSessions?.[0] === "visible");
    const visible = source.map((row) => ({ ...row }));
    const hidden = source.map(({ watchedSessions: _watchedSessions, ...row }) => row);
    const first = {} as GatewayWsClient;
    const second = {} as GatewayWsClient;
    const restricted = {} as GatewayWsClient;
    const encode = (client: GatewayWsClient, view: typeof source, version: number) => {
      const delivery = preparePresenceDelivery(client, source, view, version);
      client.presenceSnapshot = delivery.snapshot;
      return String(delivery.fragment);
    };
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const firstReset = encode(first, visible, 1);
      const hiddenReset = encode(restricted, hidden, 1);
      expect(encode(second, visible, 1)).toBe(firstReset);
      expect(hiddenReset).not.toContain('"watchedSessions"');
      expect(stringify).toHaveBeenCalledTimes(2);

      stringify.mockClear();
      const hiddenDelta = encode(first, hidden, 2);
      const visibleDelta = encode(restricted, visible, 2);
      expect(encode(second, hidden, 2)).toBe(hiddenDelta);
      const payload = JSON.parse(`{${hiddenDelta.slice(1)}}`).payload;
      expect(payload).toEqual({
        base: 1,
        version: 2,
        upsert: [{ key: getSystemPresenceKey(source[0]!), set: {}, unset: ["watchedSessions"] }],
        remove: [],
        order: source.map(getSystemPresenceKey),
      });
      expect(visibleDelta).toContain('"set":{"watchedSessions":["visible"]}');
      // Two resets and two distinct baseline/audience deltas, including field comparisons.
      const encoded = stringify.mock.calls.filter(
        ([value]) => value && typeof value === "object" && ("reset" in value || "upsert" in value),
      );
      expect(encoded).toHaveLength(4);

      // A dropped recipient must reset even when its audience already has a delta.
      second.presenceSnapshot = undefined;
      const reset = encode(second, hidden, 2);
      expect(JSON.parse(`{${reset.slice(1)}}`).payload).toMatchObject({ reset: true, version: 2 });
      // Reusing the view with a new source must not retain the old wire keys.
      upsertPresence("replacement-delivery", { text: "replacement" });
      const replacement = listSystemPresence().filter((row) => row.text === "replacement");
      const changedSource = preparePresenceDelivery({} as GatewayWsClient, replacement, hidden, 2);
      expect(JSON.parse(`{${String(changedSource.fragment).slice(1)}}`).payload.keys).toEqual(
        replacement.map(getSystemPresenceKey),
      );
    } finally {
      stringify.mockRestore();
    }
  });

  it("sends one projected row for a 24-row roster and resets when a delta costs more", () => {
    for (let index = 0; index < 24; index++) {
      upsertPresence(`wire-size-${index}-${"a".repeat(64)}`, {
        connectionId: `wire-size-${index}`,
        instanceId: `instance-${index}`,
        deviceId: `device-${index}`,
        host: `operator-workstation-${index}`,
        platform: "macos 26.0",
        version: "2026.10.17",
        clientId: "openclaw-control-ui",
        mode: "webchat",
        reason: "connect",
        roles: ["operator"],
        scopes: [
          "operator.admin",
          "operator.read",
          "operator.write",
          "operator.approvals",
          "operator.questions",
          "operator.pairing",
        ],
        user: {
          id: `profile-${index}`,
          identity: { type: "profile", id: `profile-${index}` },
          name: `Synthetic Operator ${index}`,
          email: `operator-${index}@example.com`,
          avatarUrl: `https://example.com/avatars/${"x".repeat(140)}-${index}.png`,
        },
        watchedSessions: ["agent:main:visible"],
      });
    }
    const source = listSystemPresence()
      .filter((row) => row.connectionId?.startsWith("wire-size-"))
      .toSorted((left, right) => left.connectionId!.localeCompare(right.connectionId!));
    const client = {} as GatewayWsClient;
    const initial = preparePresenceDelivery(client, source, source, 1);
    client.presenceSnapshot = initial.snapshot;
    // The raw roster has not changed: only this recipient's session visibility changed.
    const projected = source.map((row, index) =>
      index === 0 ? { ...row, watchedSessions: undefined } : row,
    );
    const stringify = vi.spyOn(JSON, "stringify");
    let updated: ReturnType<typeof preparePresenceDelivery>;
    try {
      updated = preparePresenceDelivery(client, source, projected, 2);
      // Immutable fields shared with the prior row need no wire comparison.
      expect(stringify).not.toHaveBeenCalledWith(source[0]!.user);
      expect(stringify).not.toHaveBeenCalledWith(source[0]!.scopes);
      expect(stringify).not.toHaveBeenCalledWith(source[0]!.host);
    } finally {
      stringify.mockRestore();
    }
    const delta = JSON.parse(`{${String(updated.fragment).slice(1)}}`).payload as PresenceDelta;
    expect(delta.base).toBe(1);
    expect(delta.upsert).toEqual([
      { key: getSystemPresenceKey(source[0]!), set: {}, unset: ["watchedSessions"] },
    ]);
    expect(delta.remove).toEqual([]);
    expect(delta.order).toEqual(source.map(getSystemPresenceKey));
    const event = (payload: unknown) => ({
      type: "event",
      event: "presence",
      payload,
      seq: 2,
      stateVersion: { presence: 2, health: 1 },
    });
    const beforeBytes = Buffer.byteLength(JSON.stringify(event({ presence: projected })));
    const afterBytes = Buffer.byteLength(JSON.stringify(event(delta)));
    expect(afterBytes).toBeLessThan(500);
    expect(afterBytes).toBeLessThan(beforeBytes / 10);
    console.info(`24-row presence event: full=${beforeBytes} B delta=${afterBytes} B`);

    const small = preparePresenceDelivery(client, source.slice(0, 1), [{ ts: 0, text: "" }], 3);
    expect(JSON.parse(`{${String(small.fragment).slice(1)}}`).payload).toMatchObject({
      reset: true,
    });
  });
});
