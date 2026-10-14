import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentIdentityResult } from "../../api/types.ts";
import type { ApplicationGatewayPhase, ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createAgentIdentityCapability, fetchAgentIdentity } from "./identity.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

it.each([undefined, 7_000])(
  "paces rejected identity reads per agent (retry hint %s)",
  async (hint) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const unavailable = new GatewayProtocolRequestError({
      code: "UNAVAILABLE",
      message: "agent.identity.get unavailable during gateway restart",
      details: { reason: "gateway-restarting" },
      retryable: true,
      retryAfterMs: hint,
    });
    const request = vi.fn().mockRejectedValue(unavailable);
    const client = createTestGatewayClient(request);
    const capability = createAgentIdentityCapability({
      snapshot: { client, phase: "connected" },
      subscribe: () => () => undefined,
    });
    let now = 0;
    for (const [attempt, backoff] of [500, 1_000, 2_000, 4_000, 5_000, 5_000].entries()) {
      await capability.ensure([" main ", "main"]);
      for (let render = 0; render < 40; render += 1) {
        await capability.ensure(["main"]);
      }
      expect(request).toHaveBeenCalledTimes(attempt + 1);
      now += Math.max(backoff, hint ?? 0);
      clock.mockReturnValue(now - 1);
      await expect(fetchAgentIdentity(client, "main")).rejects.toBe(unavailable);
      expect(request).toHaveBeenCalledTimes(attempt + 1);
      clock.mockReturnValue(now);
    }

    const recovered = { agentId: "main", name: "Recovered", avatar: "" };
    request.mockResolvedValueOnce(recovered);
    await capability.ensure(["main"]);
    expect(capability.get("main")).toBe(recovered);
    // Another agent owns a separate retry window.
    await capability.ensure(["other"]);
    expect(request).toHaveBeenCalledTimes(8);

    clock.mockReturnValue(now + 60_000);
    await capability.ensure(["main"]);
    clock.mockReturnValue(now + 60_000 + Math.max(500, hint ?? 0));
    await capability.ensure(["main"]);
    expect(request).toHaveBeenCalledTimes(8);
    expect(capability.get("main")).toBe(recovered);
  },
);

it.each([
  { name: "restart", restartPending: true, suspensionPhase: "accepting" },
  { name: "suspension preparation", restartPending: false, suspensionPhase: "preparing" },
  { name: "suspension drain", restartPending: false, suspensionPhase: "draining" },
  { name: "prepared suspension", restartPending: false, suspensionPhase: "prepared" },
] as const)("retains identity and pauses refresh during $name", async (unavailable) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(0);
  const original = { agentId: "main", name: "Main", avatar: "/avatar/main?v=old" };
  const replacement = { ...original, avatar: "/avatar/main?v=new" };
  const request = vi.fn().mockResolvedValueOnce(original).mockResolvedValue(replacement);
  const snapshot: Pick<
    ApplicationGatewaySnapshot,
    "client" | "phase" | "restartPending" | "suspensionPhase"
  > = {
    client: createTestGatewayClient(request),
    phase: "connected",
  };
  let onSnapshot = (_snapshot: typeof snapshot) => {};
  const capability = createAgentIdentityCapability({
    snapshot,
    subscribe(listener) {
      onSnapshot = listener;
      return () => undefined;
    },
  });
  await capability.ensure(["main"]);
  clock.mockReturnValue(60_000);
  snapshot.restartPending = unavailable.restartPending;
  snapshot.suspensionPhase = unavailable.suspensionPhase;
  onSnapshot(snapshot);
  for (let render = 0; render < 40; render += 1) {
    await capability.ensure(["main"]);
  }
  expect(request).toHaveBeenCalledOnce();
  expect(capability.get("main")).toBe(original);

  snapshot.restartPending = false;
  snapshot.suspensionPhase = "accepting";
  onSnapshot(snapshot);
  await capability.ensure(["main"]);
  expect(request).toHaveBeenCalledOnce();
  expect(capability.get("main")).toBe(original);
});

it.each(["reconnect", "config", "agent"])(
  "retires failed identity reads on %s invalidation",
  async (kind) => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const result = { agentId: "main", name: "Current", avatar: "" };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValue(result);
    const client = createTestGatewayClient(request);
    const snapshot: { client: GatewayBrowserClient; phase: ApplicationGatewayPhase } = {
      client,
      phase: "connected",
    };
    let onSnapshot = (_snapshot: typeof snapshot) => {};
    let onEvent = (_event: { event: string }) => {};
    const capability = createAgentIdentityCapability({
      snapshot,
      subscribe(listener) {
        onSnapshot = listener;
        return () => undefined;
      },
      subscribeEvents(listener) {
        onEvent = listener;
        return () => undefined;
      },
    });
    await capability.ensure(["main"]);
    if (kind === "reconnect") {
      snapshot.phase = "reconnecting";
      onSnapshot(snapshot);
      snapshot.phase = "connected";
      onSnapshot(snapshot);
    } else if (kind === "config") {
      onEvent({ event: "config.changed" });
    } else {
      capability.invalidate(["main"]);
    }
    await capability.ensure(["main"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(capability.get("main")).toBe(result);
  },
);

it("rejects stale identities after reconnecting the same client", async () => {
  const oldRequest = createDeferred<AgentIdentityResult>();
  const currentRequest = createDeferred<AgentIdentityResult>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => oldRequest.promise)
    .mockImplementationOnce(() => currentRequest.promise);
  const client = createTestGatewayClient(request);
  let snapshot: { client: GatewayBrowserClient | null; phase: ApplicationGatewayPhase } = {
    client,
    phase: "connected",
  };
  const listeners = new Set<(next: typeof snapshot) => void>();
  const capability = createAgentIdentityCapability({
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const publish = (connected: boolean) => {
    snapshot = { client, phase: connected ? "connected" : "reconnecting" };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const stale = capability.ensure(["main"]);
  publish(false);
  publish(true);
  const current = capability.ensure(["main"]);

  oldRequest.resolve({ agentId: "main", name: "Stale", avatar: "" });
  await stale;
  expect(capability.entries()).toEqual([]);

  currentRequest.resolve({ agentId: "main", name: "Current", avatar: "" });
  await current;
  expect(capability.get("main")?.name).toBe("Current");
});

it.each(["local", "Gateway"])(
  "rejects an in-flight identity after %s invalidation",
  async (source) => {
    const staleRequest = createDeferred<AgentIdentityResult>();
    const currentRequest = createDeferred<AgentIdentityResult>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => currentRequest.promise);
    const client = createTestGatewayClient(request);
    let onEvent = (_event: { event: string; payload?: unknown }) => {};
    const capability = createAgentIdentityCapability({
      snapshot: { client, phase: "connected" },
      subscribe: () => () => undefined,
      subscribeEvents(listener) {
        onEvent = listener;
        return () => undefined;
      },
    });
    const publish = vi.fn();
    capability.subscribe(publish);

    const stale = capability.ensure(["main"]);
    if (source === "Gateway") {
      onEvent({ event: "agent.identity.changed", payload: { agentId: "main" } });
    } else {
      capability.invalidate(["main"]);
    }
    expect(publish).toHaveBeenCalledOnce();
    const current = capability.ensure(["main"]);

    staleRequest.resolve({ agentId: "main", name: "Stale", avatar: "" });
    await stale;
    expect(capability.entries()).toEqual([]);

    currentRequest.resolve({ agentId: "main", name: "Current", avatar: "" });
    await current;
    expect(capability.get("main")?.name).toBe("Current");
  },
);

it("publishes each fetched snapshot once under overlapping roster and stream updates", async () => {
  const pending = createDeferred();
  const ids = Array.from({ length: 24 }, (_, index) => `agent-${index}`);
  const request = vi.fn((_method: string, params: unknown) => {
    const { agentId } = params as { agentId: string };
    return pending.promise.then(() => ({ agentId, name: agentId, avatar: "" }));
  });
  const capability = createAgentIdentityCapability({
    snapshot: { client: createTestGatewayClient(request), phase: "connected" },
    subscribe: () => () => undefined,
  });
  const publish = vi.fn();
  capability.subscribe(publish);
  const updates = Array.from({ length: 40 }, () => capability.ensure(ids));
  pending.resolve();
  await Promise.all(updates);
  expect(request).toHaveBeenCalledTimes(ids.length);
  expect(capability.entries()).toHaveLength(ids.length);
  expect(publish).toHaveBeenCalledTimes(1);
  await capability.ensure(ids);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("shares identity requests between the sidebar and the selected chat", async () => {
  const { fetchAssistantIdentity } = await import("../../app/assistant-identity.ts");
  const result = { agentId: "main", name: "Main", avatar: "/avatar/main?v=1" };
  const request = vi.fn().mockResolvedValue(result);
  const client = createTestGatewayClient(request);
  const capability = createAgentIdentityCapability({
    snapshot: { client, phase: "connected" },
    subscribe: () => () => undefined,
  });

  const [, assistant] = await Promise.all([
    capability.ensure(["main"]),
    fetchAssistantIdentity(client, "main"),
  ]);
  expect(capability.get("main")?.avatar).toBe(result.avatar);
  expect(assistant?.avatar).toBe(result.avatar);
  expect(request).toHaveBeenCalledOnce();
});

it.each(["sidebar", "chat"])(
  "shares an invalidated identity when %s refreshes first",
  async (first) => {
    const { fetchAssistantIdentity } = await import("../../app/assistant-identity.ts");
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const oldIdentity = { agentId: "main", name: "Main", avatar: "/avatar/main?v=old" };
    const replacement = { ...oldIdentity, avatar: "/avatar/main?v=replaced" };
    const refresh = createDeferred<AgentIdentityResult>();
    const request = vi.fn().mockResolvedValueOnce(oldIdentity).mockReturnValueOnce(refresh.promise);
    const client = createTestGatewayClient(request);
    const capability = createAgentIdentityCapability({
      snapshot: { client, phase: "connected" },
      subscribe: () => () => undefined,
    });
    const publish = vi.fn();
    capability.subscribe(publish);
    await capability.ensure(["main"]);
    clock.mockReturnValue(600_000);
    const idle = Promise.all([capability.ensure(["main"]), fetchAssistantIdentity(client, "main")]);
    expect(request).toHaveBeenCalledOnce();
    await idle;

    capability.invalidate(["main"]);
    const firstRefresh =
      first === "sidebar" ? capability.ensure(["main"]) : fetchAssistantIdentity(client, "main");
    // A slow refresh stays shared regardless of elapsed time.
    clock.mockReturnValue(1_200_000);
    const waitingChat = fetchAssistantIdentity(client, "main");
    expect(request).toHaveBeenCalledTimes(2);
    expect(capability.get("main")).toBeNull();
    refresh.resolve(replacement);
    await firstRefresh;
    expect((await waitingChat)?.avatar).toBe(replacement.avatar);
    // A chat-first completion must update the sidebar's older projection too.
    await capability.ensure(["main"]);
    expect(capability.get("main")?.avatar).toBe(replacement.avatar);
    expect(request).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(3);
    clock.mockReturnValue(1_800_000);
    await Promise.all([capability.ensure(["main"]), fetchAssistantIdentity(client, "main")]);
    expect(request).toHaveBeenCalledTimes(2);
  },
);
