import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { sourceConfigSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid } from "../../test-helpers/solid-cleanup.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  authorizationCode,
  availableStatus,
  createIdentityFixture,
  createMutationRunner,
  setupRequest,
  sharedTarget,
} from "./github-identity-harness.test-support.ts";

const confirmation = vi.hoisted(() => ({ show: vi.fn(async () => true) }));
vi.mock("../../components/confirm-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/confirm-dialog.ts")>()),
  showConfirmDialog: confirmation.show,
}));

beforeEach(() => {
  confirmation.show.mockReset().mockResolvedValue(true);
});

function authorConfig(systemName: string, agentName: string) {
  const identity = (name: string, letter: string) => ({
    profileId: `ghp_${letter.repeat(32)}`,
    gitAuthor: { name },
  });
  return {
    tools: { github: identity(systemName, "a") },
    agents: { entries: { main: { tools: { github: identity(agentName, "b") } } } },
  };
}

const createRuntimeConfig = (client: GatewayBrowserClient) =>
  createRuntimeConfigCapability({
    snapshot: {
      client,
      phase: "connected",
      sessionKey: "main",
      hello: gatewayHelloForMethods(["config.set"]),
    },
    subscribe: () => () => undefined,
  });

afterEach(() => {
  cleanupSolid();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createController(behavior: { beforeDispatch?: () => void; refreshError?: string } = {}) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "secrets.store.set" || method === "secrets.store.delete") {
        return { ok: true };
      }
      if (method === "tools.github.configure") {
        return availableStatus((params.scope as "system" | "agent") ?? "system");
      }
      if (method === "tools.github.status") {
        return availableStatus((params.selectedScope as "system" | "agent") ?? "system");
      }
      throw new Error(`unexpected method ${method}`);
    }),
  } as unknown as GatewayBrowserClient;
  const runExternalMutation = createMutationRunner(client, behavior);
  return { ...createIdentityFixture(client, { runExternalMutation }), client, requests };
}

it("keeps independent identity drafts isolated and clears only the inherited target", async () => {
  const { identity, sync, requests } = createController();
  const config = authorConfig("System Author", "Agent Author");
  const system = createController();
  sync({ config, scope: "agent" });
  identity.setDraft("token", "agent-token");
  system.sync({ config });
  system.identity.setDraft("token", "system-token");
  sync({ config, scope: "agent" });

  expect(identity.read().draft.token).toBe("agent-token");
  await identity.inherit();
  expect(confirmation.show).toHaveBeenCalled();
  expect(requests).toContainEqual({
    method: "tools.github.configure",
    params: { scope: "agent", agentId: "main", mode: "inherit" },
  });
  expect(identity.read().scope).toBe("agent");
  expect(identity.read().draft).toEqual({ token: "", name: "", email: "" });
  system.sync({ config });
  expect(system.identity.read().draft).toMatchObject({
    name: "System Author",
    token: "system-token",
  });
  expect(system.requests).toEqual([]);
});

it.each(["access", "profile"] as const)(
  "deletes a stored handoff when %s changes before dispatch",
  async (change) => {
    const behavior: { beforeDispatch?: () => void } = {};
    const { identity, sync, requests } = createController(behavior);
    behavior.beforeDispatch = () =>
      sync(change === "access" ? { configurable: false } : { target: sharedTarget() });
    sync();
    identity.setDraft("token", "one-use-token");

    await identity.configure();

    expect(requests.map((entry) => entry.method)).toEqual([
      "secrets.store.set",
      "secrets.store.delete",
    ]);
    expect(identity.read().configurable).toBe(change === "profile");
    expect(identity.read().error).toBeNull();
  },
);

it("keeps a consumed handoff successful while surfacing its refresh warning", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: <T extends Uint8Array>(array: T): T => array.fill(0xab),
  });
  const { identity, sync, requests } = createController({
    refreshError: "authoritative config refresh unavailable",
  });
  sync();
  identity.setDraft("token", "one-use-token");

  await identity.configure();

  expect(requests.map((entry) => entry.method)).toEqual([
    "secrets.store.set",
    "tools.github.configure",
  ]);
  expect(requests[0]?.params).toMatchObject({
    value: "one-use-token",
    kind: "secret",
    allowedHosts: [],
  });
  expect(requests[1]?.params).not.toHaveProperty("token");
  expect(requests[0]?.params.name).toMatch(/^github-setup-[a-f0-9]{32}$/u);
  expect(requests[1]?.params.secretName).toBe(requests[0]?.params.name);
  expect(identity.read().status).toEqual(availableStatus("system"));
  expect(requests[1]?.params).toMatchObject({ agentId: "main" });
  expect(identity.read().draft.token).toBe("");
  expect(identity.read().error).toContain("GitHub identity was updated");
  expect(identity.read().error).toContain("authoritative config refresh unavailable");
});

it("config.set drains drafts before managed and refreshes both edits", async () => {
  vi.useFakeTimers();
  const order: string[] = [];
  let hashCounter = 1;
  let storedConfig: Record<string, unknown> = {
    pendingEdit: "original",
    tools: { github: { profileId: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    order.push(method);
    if (method === "config.get") {
      return sourceConfigSnapshot(storedConfig, `hash-${hashCounter}`);
    }
    if (method === "config.set") {
      storedConfig = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
      hashCounter += 1;
      return { config: storedConfig, hash: `hash-${hashCounter}` };
    }
    if (method === "secrets.store.set" || method === "secrets.store.delete") {
      return { ok: true };
    }
    if (method === "tools.github.configure") {
      expect(params).toMatchObject({ mode: "managed" });
      storedConfig = {
        ...storedConfig,
        tools: { github: { profileId: "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } },
      };
      hashCounter += 1;
      return availableStatus("system");
    }
    throw new Error(`unexpected method ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const runtimeConfig = createRuntimeConfig(client);
  await runtimeConfig.ensureLoaded();
  order.length = 0;
  runtimeConfig.patchForm(["pendingEdit"], "managed");
  const { identity, sync } = createIdentityFixture(client, {
    runExternalMutation: runtimeConfig.runExternalMutation,
  });
  sync({ config: runtimeConfig.state.configForm ?? {} });
  const unsubscribe = runtimeConfig.subscribe(() => {
    sync({ config: runtimeConfig.state.configForm ?? {} });
  });
  try {
    identity.setDraft("token", "one-use-token");
    identity.setDraft("name", "Managed Author");
    await identity.configure();

    expect(order).toEqual([
      "secrets.store.set",
      "config.set",
      "tools.github.configure",
      "config.get",
    ]);
    expect(identity.read()).toMatchObject({
      busy: false,
      scope: "system",
      status: availableStatus("system"),
      draft: { token: "", name: "Managed Author", email: "" },
    });
    expect(runtimeConfig.state.configForm).toMatchObject({
      pendingEdit: "managed",
      tools: { github: { profileId: "ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } },
    });
  } finally {
    unsubscribe();
    runtimeConfig.dispose();
    vi.clearAllTimers();
  }
});

it("keeps UUID generation failures inside configure handling", async () => {
  vi.stubGlobal("crypto", {});
  const { identity, sync, requests } = createController();
  sync();
  identity.setDraft("token", "one-use-token");

  await expect(identity.configure()).resolves.toBeUndefined();

  expect(requests).toEqual([]);
  expect(identity.read().busy).toBe(false);
  await expect(identity.read().mutationCompletion).rejects.toThrow("Web Crypto is required");
});

it("does not dispatch without the required operator scopes", async () => {
  const { identity, sync, requests } = createController();
  sync({
    statusReadable: false,
    configurable: false,
    authorizable: false,
  });
  identity.setDraft("token", "unused-token");
  await identity.verify();
  await identity.configure();
  await identity.inherit();
  expect(requests).toEqual([]);
});

it("refreshes clean drafts without overwriting active edits", () => {
  const { identity, sync } = createController();
  sync({ config: authorConfig("System One", "Agent One"), scope: "agent" });
  identity.setDraft("name", "Active Agent Edit");
  sync({ config: authorConfig("System Two", "Agent Two"), scope: "agent" });
  expect(identity.read().draft.name).toBe("Active Agent Edit");
  sync({ config: authorConfig("System Two", "Agent Two") });
  expect(identity.read().draft.name).toBe("System Two");
});

it("requires the explicit new-run disclosure before removing a selected identity", async () => {
  confirmation.show.mockResolvedValueOnce(false);
  const { identity, sync, requests } = createController();
  sync();

  await identity.inherit();

  expect(confirmation.show).toHaveBeenCalledWith(
    expect.objectContaining({
      confirmLabel: "Use native for new runs",
      message: expect.stringContaining("Active runs keep their current identity"),
    }),
  );
  expect(requests).toEqual([]);
});

it("resets the shared profile draft and rejects its pending removal confirmation", async () => {
  const confirmed = createDeferredCore<boolean>();
  confirmation.show.mockReturnValueOnce(confirmed.promise);
  const { identity, sync, requests } = createController();
  const config = authorConfig("System Author", "Agent Author");
  sync({ config });
  identity.setDraft("token", "old-profile-token");
  identity.setDraft("name", "Old Profile Author");
  const removal = identity.inherit();
  sync({ config, target: sharedTarget("profile-b", config) });
  confirmed.resolve(true);
  await removal;
  expect(requests).toEqual([]);
  expect(identity.read().draft).toEqual({ token: "", name: "System Author", email: "" });
});

it("invalidates an in-flight status on effective identity change and verifies once", async () => {
  const first = createDeferredCore<ReturnType<typeof availableStatus>>();
  const second = createDeferredCore<ReturnType<typeof availableStatus>>();
  const responses = [first.promise, second.promise];
  const config = (profileId: string) => ({ tools: { github: { profileId } } });
  const { request, sync, identity } = setupRequest(async () => responses.shift(), {
    context: { config: config("ghp_11111111111111111111111111111111") },
  });
  const initial = identity.verify();
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(1);
  identity.setDraft("name", "dirty author");
  sync({ config: config("ghp_22222222222222222222222222222222") });
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(2);
  expect(identity.read().draft.name).toBe("dirty author");

  await initial;
  expect(identity.read().status).toBeNull();
  first.resolve(availableStatus("system"));
  second.resolve(availableStatus("system"));
  await identity.read().statusCompletion;
  expect(identity.read().status).toEqual(availableStatus("system"));
  expect(request).toHaveBeenCalledTimes(2);
});

it.each(["unused", "pending", "loaded", "failed"])(
  "refreshes only previously requested GitHub status after reconnect (%s)",
  async (initialState) => {
    const first = createDeferredCore<ReturnType<typeof availableStatus>>();
    const currentStatus = availableStatus("system");
    const { request, sync, identity } = setupRequest(
      vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(currentStatus),
    );
    let initial: Promise<void> | undefined;
    if (initialState !== "unused") {
      initial = identity.verify();
      if (initialState === "loaded") {
        first.resolve(currentStatus);
        await initial;
      } else if (initialState === "failed") {
        first.reject(new Error("Status unavailable"));
        await expect(initial).rejects.toThrow("Status unavailable");
        initial = undefined;
      }
    }
    identity.setDraft("name", "Unsaved author");
    const previousStatus = identity.read().status;
    sync({
      connected: false,
      clientRevision: 2,
      statusReadable: false,
      configurable: false,
      authorizable: false,
    });
    expect(identity.read().status).toBe(previousStatus);
    expect(identity.read().draft.name).toBe("Unsaved author");
    sync({ clientRevision: 3 });
    await Promise.resolve();
    if (initialState !== "unused") {
      await waitForFast(() => {
        expect(identity.read().loading).toBe(false);
        expect(identity.read().status).toEqual(currentStatus);
      });
    }

    const statusCall = ["tools.github.status", { agentId: "main", selectedScope: "system" }];
    expect(request.mock.calls).toEqual(initialState === "unused" ? [] : [statusCall, statusCall]);
    expect(identity.read().draft.name).toBe("Unsaved author");
    expect(identity.read().status).toEqual(initialState === "unused" ? null : currentStatus);
    first.resolve(availableStatus("agent"));
    await initial;
    expect(identity.read().error).toBeNull();

    const replacement = createTestGatewayClient(request);
    sync({ client: replacement, clientRevision: 4 });
    expect(identity.read().draft.name).toBe("");
    expect(identity.read().status).toBeNull();
    sync({ client: replacement, connected: false, clientRevision: 5 });
    sync({ client: replacement, clientRevision: 6 });
    await Promise.resolve();
    expect(request.mock.calls).toEqual(initialState === "unused" ? [] : [statusCall, statusCall]);
  },
);

it("rejects status returned for a different agent", async () => {
  const { identity } = setupRequest(async () => ({
    ...availableStatus("system"),
    agentId: "reviewer",
  }));
  await expect(identity.verify()).rejects.toThrow("different target");
  expect(identity.read().status).toBeNull();
});

it("waits for each authoritative poll deadline and adopts successful OAuth status", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  const pollTimes: number[] = [];
  const pollResults = [
    { status: "slow_down" as const, retryAfterMs: 10_000 },
    { status: "success" as const, githubStatus: availableStatus("system") },
  ];
  const request = vi.fn(async (method: string) => {
    if (method === "config.get") {
      return sourceConfigSnapshot({}, "poll-hash");
    }
    if (method === "tools.github.authorize.start") {
      return authorizationCode;
    }
    if (method === "tools.github.authorize.poll") {
      pollTimes.push(Date.now());
      return pollResults.shift();
    }
    throw new Error(`unexpected method ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const runtimeConfig = createRuntimeConfig(client);
  await runtimeConfig.ensureLoaded();
  request.mockClear();
  const { identity, sync } = createIdentityFixture(client, {
    runExternalMutation: runtimeConfig.runExternalMutation,
  });
  sync();

  await identity.startAuthorization();
  expect(identity.read().authorization).toMatchObject({ phase: "code", userCode: "ABCD-1234" });
  await vi.advanceTimersByTimeAsync(4_999);
  expect(pollTimes).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(pollTimes).toEqual([1_800_000_005_000]);
  expect(identity.read().authorization).toMatchObject({ phase: "pending", slowedDown: true });
  expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(0);

  await vi.advanceTimersByTimeAsync(9_999);
  expect(pollTimes).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(pollTimes).toEqual([1_800_000_005_000, 1_800_000_015_000]);
  expect(identity.read().status).toEqual(availableStatus("system"));
  expect(identity.read().authorization).toEqual({ phase: "idle" });
  expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);
  runtimeConfig.dispose();
});

it.each([
  { label: "selected agent changes", overrides: { agentId: "reviewer" } },
  { label: "connection generation changes", overrides: { clientRevision: 2 } },
  { label: "administrator access is lost", overrides: { authorizable: false } },
  { label: "selected scope changes", overrides: { scope: "agent" as const } },
  {
    label: "shared profile changes",
    overrides: { target: sharedTarget() },
  },
])("cancels the exact authorization when $label", async ({ overrides }) => {
  vi.useFakeTimers();
  const { request, sync, identity } = setupRequest(async (method) => {
    if (method === "tools.github.authorize.start") {
      return authorizationCode;
    }
    return { cancelled: true };
  });
  await identity.startAuthorization();

  sync(overrides);
  await Promise.resolve();

  expect(request).toHaveBeenCalledWith("tools.github.authorize.cancel", {
    requestId: authorizationCode.requestId,
  });
  expect(identity.read().authorization).toEqual({ phase: "idle" });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request.mock.calls.some(([method]) => method === "tools.github.authorize.poll")).toBe(
    false,
  );
});

it("cancels the exact request once when cancellation is repeated", async () => {
  vi.useFakeTimers();
  const { request, identity } = setupRequest(async (method) =>
    method === "tools.github.authorize.start" ? authorizationCode : { cancelled: true },
  );
  await identity.startAuthorization();

  await Promise.all([identity.cancelAuthorization(), identity.cancelAuthorization()]);

  expect(
    request.mock.calls.filter(([method]) => method === "tools.github.authorize.cancel"),
  ).toEqual([["tools.github.authorize.cancel", { requestId: authorizationCode.requestId }]]);
  expect(identity.read().authorization).toEqual({ phase: "idle" });
});

it("keeps a too-late cancellation alive and adopts the in-flight success", async () => {
  vi.useFakeTimers();
  const poll = createDeferredCore<unknown>();
  const { request, identity } = setupRequest(
    async (method) => {
      if (method === "tools.github.authorize.start") {
        return { ...authorizationCode, pollAfterMs: 1_000 };
      }
      if (method === "tools.github.authorize.poll") {
        return await poll.promise;
      }
      if (method === "tools.github.authorize.cancel") {
        return { cancelled: false };
      }
      throw new Error(`unexpected method ${method}`);
    },
    { mutation: true },
  );
  await identity.startAuthorization();
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "tools.github.authorize.poll",
      expect.anything(),
      expect.anything(),
    ),
  );

  await identity.cancelAuthorization();
  expect(identity.read().authorization).toMatchObject({ phase: "finishing" });
  poll.resolve({ status: "success", githubStatus: availableStatus("system") });
  await vi.waitFor(() => expect(identity.read().authorization).toEqual({ phase: "idle" }));

  expect(identity.read().status).toEqual(availableStatus("system"));
});

it("keeps authorization pending and surfaces a cancellation network failure", async () => {
  vi.useFakeTimers();
  const { request, identity } = setupRequest(
    async (method) => {
      if (method === "tools.github.authorize.start") {
        return authorizationCode;
      }
      if (method === "tools.github.authorize.cancel") {
        throw new Error("Gateway unavailable");
      }
      if (method === "tools.github.authorize.poll") {
        return { status: "pending", retryAfterMs: 5_000 };
      }
      throw new Error(`unexpected method ${method}`);
    },
    { mutation: true },
  );
  await identity.startAuthorization();

  await identity.cancelAuthorization();
  expect(identity.read().authorization).toMatchObject({
    phase: "cancel_error",
    message: expect.stringContaining("Gateway unavailable"),
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(request).toHaveBeenCalledWith(
    "tools.github.authorize.poll",
    { requestId: authorizationCode.requestId },
    expect.anything(),
  );
  expect(identity.read().authorization).toMatchObject({ phase: "cancel_error" });
});
