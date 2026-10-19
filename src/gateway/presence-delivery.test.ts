import { describe, expect, it } from "vitest";
import type { PresenceDelta } from "../../packages/gateway-protocol/src/presence-deltas.js";
import { listSystemPresence, upsertPresence } from "../infra/system-presence.js";
import { preparePresenceDelivery } from "./presence-delivery.js";
import type { GatewayWsClient } from "./server/ws-types.js";

describe("presence wire size", () => {
  it("sends one projected row for a 24-row roster and resets when a delta costs more", () => {
    for (let index = 0; index < 24; index++) {
      upsertPresence(`wire-size-${index}`, {
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
    const updated = preparePresenceDelivery(client, source, projected, 2);
    const delta = JSON.parse(`{${updated.fragment.slice(1)}}`).payload as PresenceDelta;
    expect(delta.base).toBe(1);
    expect(delta.upsert).toEqual([
      { key: "entry:wire-size-0", set: {}, unset: ["watchedSessions"] },
    ]);
    expect(delta.remove).toEqual([]);
    expect(delta.order).toEqual(source.map((row) => `entry:${row.connectionId}`));
    const event = (payload: unknown) => ({
      type: "event",
      event: "presence",
      payload,
      seq: 2,
      stateVersion: { presence: 2, health: 1 },
    });
    const beforeBytes = Buffer.byteLength(JSON.stringify(event({ presence: projected })));
    const afterBytes = Buffer.byteLength(JSON.stringify(event(delta)));
    expect(afterBytes).toBeLessThan(beforeBytes / 10);
    console.info(`24-row presence event: full=${beforeBytes} B delta=${afterBytes} B`);

    const small = preparePresenceDelivery(client, source.slice(0, 1), [{ ts: 0, text: "" }], 3);
    expect(JSON.parse(`{${small.fragment.slice(1)}}`).payload).toMatchObject({ reset: true });
  });
});
