/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiLobsterdex } from "./control-ui-lobsterdex.ts";

function fixture() {
  const abort = new AbortController();
  const request = vi.fn().mockResolvedValue({ entries: [] });
  const context = {
    gateway: {
      connection: { gatewayUrl: "ws://fixture.invalid" },
      snapshot: { phase: "connected", client: { request }, selfUser: { id: "fixture" } },
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
    },
  } as unknown as ApplicationContext;
  return {
    abort,
    api: createControlUiLobsterdex({ current: () => context, signal: abort.signal }),
  };
}

beforeEach(() => localStorage.clear());

describe("LobsterDex plugin host", () => {
  it("reads legacy history, isolates returned definitions, and never collects a preview", () => {
    localStorage.setItem("openclaw.control.lobsterdex.v1", JSON.stringify(["crimson"]));
    const { api, abort } = fixture();
    expect(api.listInventory()).toEqual([
      { id: "crimson", firstSeenAt: null, name: null, shinySeenAt: null, available: true },
    ]);
    const definition = api.getDefinition("crimson")!;
    definition.name = "Changed by consumer";
    expect(api.getDefinition("crimson")?.name).not.toBe("Changed by consumer");
    api.listCatalog();
    expect(api.listInventory()).toHaveLength(1);
    abort.abort();
  });
  it("records encounters once, notifies subscribers, and revokes retained methods", () => {
    const { api, abort } = fixture();
    const changed = vi.fn();
    const unsubscribe = api.subscribe(changed);
    api.recordEncounter("crimson", { name: "Ruby" });
    const original = api.listInventory()[0];
    api.recordEncounter("crimson", { name: "Replacement", shiny: true });
    expect(api.listInventory()[0]).toMatchObject({ ...original, shinySeenAt: expect.any(Number) });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(() => api.recordEncounter("missing")).toThrow("available");
    unsubscribe();
    const retained = api.listCatalog;
    abort.abort();
    expect(retained).toThrow();
    expect(() => api.recordEncounter("blue")).toThrow();
  });
});
