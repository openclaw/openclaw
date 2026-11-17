import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGateway, ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { bindOwnerApproval, ownerApprovalFor } from "./owner-approval-lifetime.ts";

const held = vi.hoisted(() => ({
  account: { sub: "owner", idToken: "test-account-token" } as unknown,
  accountListeners: [] as ((value: unknown) => void)[],
  keyListeners: [] as (() => void)[],
  owners: [] as {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    suspend: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  }[],
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
const statusRequests = new WeakMap<GatewayBrowserClient, () => number>();
function fakeClient(gatewayUrl = "ws://127.0.0.1:18789") {
  let count = 0;
  const client = {
    gatewayUrl,
    request: async (method: string) => {
      if (method !== "openclawId.status") {
        return { link: { linked: true, clawId: status.clawId } };
      }
      count += 1;
      return { channel: status.channel, owner: status.owner, link: { linked: true } };
    },
  } as unknown as GatewayBrowserClient;
  statusRequests.set(client, () => count);
  return client;
}
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
  return { ...g, client, first: held.owners[0]! };
}

describe("owner approval reader lifetime", () => {
  it("keeps the reader and its attempts across a transport reconnect of the same client", async () => {
    const { set, client, first } = await bound();
    set({ phase: "reconnecting" });
    set({ phase: "connected" });
    expect(first.suspend).toHaveBeenCalled();
    await vi.waitFor(() => expect(first.resume).toHaveBeenCalledWith(client));
    expect(statusRequests.get(client)?.()).toBe(2);
    expect(first.stop).not.toHaveBeenCalled();
    expect(held.owners).toHaveLength(1);
    expect(ownerApprovalFor(client)).toBe(first);
  });

  it.each([
    ["no longer an owner", () => (status.owner = false)],
    ["no longer local", () => (status.channel = "remote_owner")],
    ["relinked to another claw", () => (status.clawId = "34".repeat(16))],
  ])("tears the reader down when the reconnected client is %s", async (_case, change) => {
    const { set, client, first } = await bound();
    set({ phase: "reconnecting" });
    change();
    set({ phase: "connected" });
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledTimes(1));
    expect(first.resume).not.toHaveBeenCalled();
    expect(ownerApprovalFor(client)).toBeUndefined();
  });

  it.each([
    ["an account change", () => held.accountListeners.forEach((l) => l({ sub: "other" }))],
    ["an owner key change", () => held.keyListeners.forEach((l) => l())],
  ])("starts over on %s, even mid-reconnect", async (_case, change) => {
    const { set, first } = await bound();
    set({ phase: "reconnecting" });
    change();
    expect(first.stop).toHaveBeenCalledTimes(1);
    set({ phase: "connected" });
    await vi.waitFor(() => expect(held.owners).toHaveLength(2));
    expect(first.resume).not.toHaveBeenCalled();
  });

  it("finishes the first admission through unrelated snapshot updates", async () => {
    const g = fakeGateway(fakeClient());
    dispose = bindOwnerApproval(g.gateway, vi.fn(), vi.fn(), vi.fn());
    g.set({ sessionKey: "agent:main:other" });
    await vi.waitFor(() => expect(held.owners).toHaveLength(1));
    expect(held.owners[0]!.start).toHaveBeenCalled();
  });

  it("retires a held reader as soon as a reconnect targets another Gateway", async () => {
    const { set, first } = await bound();
    set({ phase: "reconnecting" });
    expect(first.stop).not.toHaveBeenCalled();
    set({ client: fakeClient("wss://other.example.test"), phase: "connecting" });
    expect(first.stop).toHaveBeenCalledTimes(1);
  });

  it("moves the reader to a replacement client for the same Gateway", async () => {
    const { set, client, first } = await bound();
    set({ phase: "reconnecting" });
    const replacement = fakeClient();
    set({ client: replacement, phase: "connected" });
    await vi.waitFor(() => expect(first.resume).toHaveBeenCalledWith(replacement));
    expect(first.stop).not.toHaveBeenCalled();
    expect(held.owners).toHaveLength(1);
    expect(ownerApprovalFor(replacement)).toBe(first);
    expect(ownerApprovalFor(client)).toBeUndefined();
  });

  it("starts over for a client to a different Gateway", async () => {
    const { set, first } = await bound();
    set({ client: fakeClient("wss://other.example.test") });
    expect(first.stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(held.owners).toHaveLength(2));
    expect(first.resume).not.toHaveBeenCalled();
  });

  it("does not move the reader to a replacement client that is no longer an owner", async () => {
    const { set, first } = await bound();
    status.owner = false;
    const replacement = fakeClient();
    set({ client: replacement });
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalledTimes(1));
    expect(first.resume).not.toHaveBeenCalled();
    expect(ownerApprovalFor(replacement)).toBeUndefined();
  });

  it.each(["stopped", "reload-required"] as const)(
    "stops a reader held through a reconnect when the client becomes %s",
    async (phase) => {
      const { set, first } = await bound();
      set({ phase: "reconnecting" });
      set({ phase });
      expect(first.stop).toHaveBeenCalledTimes(1);
      set({ phase: "connected" });
      await vi.waitFor(() => expect(held.owners).toHaveLength(2));
      expect(first.resume).not.toHaveBeenCalled();
    },
  );

  it.each(["stopped", "reload-required"] as const)(
    "stops the reader when the same client is %s",
    async (phase) => {
      const { set, first } = await bound();
      set({ phase });
      expect(first.stop).toHaveBeenCalledTimes(1);
    },
  );
});
