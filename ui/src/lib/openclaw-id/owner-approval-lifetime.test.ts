import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { bindOwnerApproval, ownerApprovalFor } from "./owner-approval-lifetime.ts";

const held = vi.hoisted(() => ({
  account: { sub: "owner", idToken: "test-account-token" } as unknown,
  accountListeners: [] as ((value: unknown) => void)[],
  keyListeners: [] as (() => void)[],
  owners: [] as Record<"start" | "stop" | "suspend" | "resume", ReturnType<typeof vi.fn>>[],
}));
// mock-isolation: the signed-in account and device key come from fixtures instead of browser storage.
vi.mock("./account.ts", () => ({
  openClawIdAccount: () => held.account,
  subscribeOpenClawIdAccount: (listener: (value: unknown) => void) => {
    held.accountListeners.push(listener);
    return () => {};
  },
}));
// mock-isolation: the signed-in account and device key come from fixtures instead of browser storage.
vi.mock("./device-key.ts", () => ({
  subscribeOwnerDeviceKey: (listener: () => void) => {
    held.keyListeners.push(listener);
    return () => {};
  },
}));
// mock-isolation: this browser holds the owner key for whichever claw the Gateway reports.
vi.mock("./owner-devices.ts", () => ({ thisOwnerDevice: async () => true }));
// mock-isolation: the reader's mailbox protocol is covered by owner-approval.test.ts.
vi.mock("./owner-approval.ts", () => ({
  createOwnerApproval: () => {
    const owner = { start: vi.fn(), stop: vi.fn(), suspend: vi.fn(), resume: vi.fn() };
    held.owners.push(owner);
    return owner;
  },
}));

let status: { channel: string; owner: boolean; clawId: string };
// Admission re-reads status and people; `resume` is only reached through that check.
const fakeClient = (gatewayUrl = "ws://127.0.0.1:18789") =>
  ({
    gatewayUrl,
    request: async (method: string) =>
      method === "openclawId.status"
        ? { channel: status.channel, owner: status.owner, link: { linked: true } }
        : { link: { linked: true, clawId: status.clawId } },
  }) as unknown as GatewayBrowserClient;
function fakeGateway(client: GatewayBrowserClient) {
  const listeners = new Set<() => void>();
  const gateway = {
    snapshot: { client, phase: "connected" } as ApplicationGatewaySnapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    gateway: gateway as unknown as ApplicationGateway,
    set: (next: Partial<ApplicationGatewaySnapshot>) => {
      gateway.snapshot = { ...gateway.snapshot, ...next };
      listeners.forEach((listener) => listener());
    },
  };
}

let dispose = () => {};
beforeEach(() => {
  status = { channel: "local_operator", owner: true, clawId: "12".repeat(16) };
  held.account = { sub: "owner", idToken: "test-account-token" };
  held.accountListeners.length = 0;
  held.keyListeners.length = 0;
  held.owners.length = 0;
});
afterEach(() => dispose());

async function bound(client = fakeClient()) {
  const g = fakeGateway(client);
  dispose = bindOwnerApproval(g.gateway, vi.fn(), vi.fn(), vi.fn());
  await vi.waitFor(() => expect(held.owners).toHaveLength(1));
  return { set: g.set, client, first: held.owners[0]! };
}

describe("owner approval reader lifetime", () => {
  it.each([
    ["a transport reconnect of the same client", (client: GatewayBrowserClient) => client],
    ["a replacement client for the same Gateway", () => fakeClient()],
  ])("keeps the reader and its attempts across %s", async (_case, nextClient) => {
    const { set, client, first } = await bound();
    set({ phase: "reconnecting" });
    expect(first.suspend).toHaveBeenCalled();
    const next = nextClient(client);
    set({ client: next, phase: "connected" });
    await vi.waitFor(() => expect(first.resume).toHaveBeenCalledWith(next));
    expect(first.stop).not.toHaveBeenCalled();
    expect(held.owners).toHaveLength(1);
    expect(ownerApprovalFor(next)).toBe(first);
    expect(next === client || ownerApprovalFor(client) === undefined).toBe(true);
  });

  it.each([
    ["no longer an owner", () => (status.owner = false), false],
    ["no longer local", () => (status.channel = "remote_owner"), false],
    ["relinked to another claw", () => (status.clawId = "34".repeat(16)), false],
    ["a replacement that is no longer an owner", () => (status.owner = false), true],
  ])("tears the reader down when the reconnected client is %s", async (_case, change, replace) => {
    const { set, client, first } = await bound();
    set({ phase: "reconnecting" });
    change();
    const next = replace ? fakeClient() : client;
    set({ client: next, phase: "connected" });
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledTimes(1));
    expect(first.resume).not.toHaveBeenCalled();
    expect(ownerApprovalFor(next)).toBeUndefined();
  });

  it.each([
    ["an account change", () => held.accountListeners.forEach((l) => l({ sub: "other" }))],
    ["an owner key change", () => held.keyListeners.forEach((l) => l())],
    ["a reconnect to another Gateway", undefined],
    ["a connected client for another Gateway", undefined],
  ])("starts over on %s", async (label, change) => {
    const { set, first } = await bound();
    if (!label.startsWith("a connected")) {
      set({ phase: "reconnecting" });
    }
    if (change) {
      change();
    } else {
      set({
        client: fakeClient("wss://other.example.test"),
        phase: label.includes("connected") ? "connected" : "connecting",
      });
    }
    expect(first.stop).toHaveBeenCalledTimes(1);
    set({ phase: "connected" });
    await vi.waitFor(() => expect(held.owners).toHaveLength(2));
    expect(first.resume).not.toHaveBeenCalled();
  });

  it.each([
    ["stopped", false],
    ["reload-required", false],
    ["stopped", true],
    ["reload-required", true],
  ] as const)(
    "stops the reader when the client becomes %s (after reconnecting: %s)",
    async (phase, afterReconnect) => {
      const { set, first } = await bound();
      if (afterReconnect) {
        set({ phase: "reconnecting" });
      }
      set({ phase });
      expect(first.stop).toHaveBeenCalledTimes(1);
    },
  );

  it("finishes the first admission through unrelated snapshot updates", async () => {
    const g = fakeGateway(fakeClient());
    dispose = bindOwnerApproval(g.gateway, vi.fn(), vi.fn(), vi.fn());
    g.set({ sessionKey: "agent:main:other" });
    await vi.waitFor(() => expect(held.owners).toHaveLength(1));
    expect(held.owners[0]!.start).toHaveBeenCalled();
  });
});
