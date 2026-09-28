/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import type { ApplicationGateway } from "./gateway.ts";
import { acquireLobsterdexCatalog } from "./lobsterdex-catalog.ts";

function gatewayFixture() {
  const changed = new Set<() => void>();
  const events = new Set<(event: { event: string }) => void>();
  const request = vi.fn().mockResolvedValue({ entries: [] });
  const gateway = {
    connection: { gatewayUrl: "ws://one.invalid" },
    snapshot: { phase: "connected", client: { request }, selfUser: { id: "one" } },
    subscribe: (listener: () => void) => {
      changed.add(listener);
      return () => changed.delete(listener);
    },
    subscribeEvents: (listener: (event: { event: string }) => void) => {
      events.add(listener);
      return () => events.delete(listener);
    },
  };
  return { gateway: gateway as unknown as ApplicationGateway, request, changed, events };
}
const character = {
  id: "reef/one/coral",
  source: "plugin",
  name: "Coral",
  pluginId: "reef",
  packId: "one",
  packName: "Reef",
  appearance: { kind: "svg", url: "/art.svg", anchor: { x: 0.5, y: 1 } },
};

describe("shared LobsterDex catalog", () => {
  it("shares one projection and releases its subscriptions only after the last consumer", async () => {
    const fixture = gatewayFixture();
    const first = acquireLobsterdexCatalog(fixture.gateway);
    const second = acquireLobsterdexCatalog(fixture.gateway);
    await Promise.resolve();
    expect(fixture.request).toHaveBeenCalledTimes(1);
    expect(first.snapshot).toBe(second.snapshot);
    first.release();
    expect(fixture.changed.size).toBe(1);
    second.release();
    expect(fixture.changed.size).toBe(0);
    expect(fixture.events.size).toBe(0);
  });

  it("does not publish a response from the previous connection", async () => {
    const fixture = gatewayFixture();
    let complete!: (value: { entries: unknown[] }) => void;
    fixture.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const catalog = acquireLobsterdexCatalog(fixture.gateway);
    await Promise.resolve();
    fixture.gateway.connection.gatewayUrl = "ws://two.invalid";
    const oldComplete = complete;
    for (const listener of fixture.changed) {
      listener();
    }
    oldComplete({ entries: [character] });
    await Promise.resolve();
    expect(catalog.snapshot.entries.some((entry) => entry.id === character.id)).toBe(false);
    catalog.release();
  });

  it("drops custom entries after a failed authoritative refresh", async () => {
    const fixture = gatewayFixture();
    fixture.request.mockResolvedValue({ entries: [character] });
    const catalog = acquireLobsterdexCatalog(fixture.gateway);
    await Promise.resolve();
    await Promise.resolve();
    expect(catalog.snapshot.entries.some((entry) => entry.id === character.id)).toBe(true);
    fixture.request.mockRejectedValue(new Error("disconnected"));
    await expect(catalog.refresh()).rejects.toThrow("disconnected");
    expect(catalog.snapshot.entries.some((entry) => entry.id === character.id)).toBe(false);
    expect(catalog.snapshot.error).toBe("disconnected");
    catalog.release();
  });
});
