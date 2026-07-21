import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";

function sessionsResult(sessions: SessionsListResult["sessions"], ts: number): SessionsListResult {
  return {
    ts,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function createGatewayHarness(client: GatewayBrowserClient, featureMethods?: string[]) {
  let snapshot: {
    client: GatewayBrowserClient | null;
    connected: boolean;
    sessionKey: string;
    assistantAgentId: string | null;
    hello: GatewayHelloOk | null;
  } = {
    client,
    connected: true,
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello:
      featureMethods === undefined
        ? null
        : ({ features: { methods: featureMethods } } as GatewayHelloOk),
  };
  const listeners = new Set<(next: typeof snapshot) => void>();
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeEvents(listener: (event: GatewayEventFrame) => void) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    },
    emitEvent: (event: GatewayEventFrame) => {
      for (const listener of eventListeners) {
        listener(event);
      }
    },
    publish: (connected: boolean) => {
      snapshot = { ...snapshot, connected };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

describe("createSessionCapability group mutations", () => {
  it("adds a group using the advertised add method", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.add") {
        return { groups: [{ name: "Alpha" }, { name: "Beta" }] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.add"]);
    const sessions = createSessionCapability(gateway);

    await expect(sessions.groupsAdd("Beta")).resolves.toBe("completed");
    expect(request).toHaveBeenCalledWith("sessions.groups.add", { name: "Beta" });
    expect(sessions.state.groups).toEqual(["Alpha", "Beta"]);
    sessions.dispose();
  });

  it("falls back to put when add is not advertised", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "sessions.groups.put") {
        const names = Array.isArray(params.names)
          ? params.names.filter((name): name is string => typeof name === "string")
          : [];
        return { groups: names.map((name) => ({ name })) };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.put"]);
    const sessions = createSessionCapability(gateway);
    await sessions.groupsPut(["Alpha"]);

    await expect(sessions.groupsAdd("Beta")).resolves.toBe("completed");
    expect(request).toHaveBeenLastCalledWith("sessions.groups.put", {
      names: ["Alpha", "Beta"],
    });
    expect(sessions.state.groups).toEqual(["Alpha", "Beta"]);
    sessions.dispose();
  });

  it("reorders groups using the advertised reorder method", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.reorder") {
        return { groups: [{ name: "Beta" }, { name: "Alpha" }] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.reorder"]);
    const sessions = createSessionCapability(gateway);

    await expect(sessions.groupsReorder(["Beta", "Alpha"])).resolves.toBe("completed");
    expect(request).toHaveBeenCalledWith("sessions.groups.reorder", { names: ["Beta", "Alpha"] });
    expect(sessions.state.groups).toEqual(["Beta", "Alpha"]);
    sessions.dispose();
  });

  it("publishes state.error when group add is rejected", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.add") {
        throw new Error("add failed");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.add"]);
    const sessions = createSessionCapability(gateway);

    await expect(sessions.groupsAdd("Alpha")).rejects.toThrow("add failed");
    expect(sessions.state.error).toBe("Error: add failed");
    sessions.dispose();
  });

  it("reports a group add as stale after a same-client reconnect", async () => {
    const added = deferred<{ groups: Array<{ name: string }> }>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.add") {
        return await added.promise;
      }
      if (method === "sessions.subscribe") {
        return {};
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client, ["sessions.groups.add"]);
    const sessions = createSessionCapability(gateway);

    const operation = sessions.groupsAdd("Alpha");
    publish(false);
    publish(true);
    added.resolve({ groups: [{ name: "Alpha" }] });

    await expect(operation).resolves.toBe("stale");
    expect(sessions.state.groups).toEqual([]);
    expect(sessions.state.error).toBeNull();
    sessions.dispose();
  });
});
