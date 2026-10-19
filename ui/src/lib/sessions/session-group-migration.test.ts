// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createSessionCapability } from "./index.ts";
import {
  createGatewayHarness as sharedGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionGateway } from "./session-capability.ts";
import { sessionRpc as groupRequests, sessionChanged } from "./session-rpc.test-support.ts";

const legacyKey = "openclaw:sessions:custom-groups";
const clientGroup = { name: "Client", position: 0 };
const clientDefaults = { name: "Client", cwd: "/repos/client", worktree: true };
const expectedClient = [{ ...clientGroup, ...clientDefaults }];
type Groups = { groups: { name: string }[] };
type Defaults = { defaults: (typeof clientDefaults)[] };

function legacyGroups() {
  vi.stubGlobal("localStorage", createStorageMock());
  const legacy = JSON.stringify(["Research"]);
  localStorage.setItem(legacyKey, legacy);
  return legacy;
}

function createGatewayHarness(request: ReturnType<typeof vi.fn>, scopes: string[]) {
  const harness = sharedGatewayHarness({ request } as unknown as GatewayBrowserClient, [
    "sessions.groups.list",
    "sessions.groups.defaults",
    "sessions.groups.put",
    "sessions.groups.rename",
  ]);
  harness.gateway.snapshot.hello = {
    ...harness.gateway.snapshot.hello,
    auth: { role: "operator", scopes },
  } as GatewayHelloOk;
  return harness;
}
function createGateway(request: ReturnType<typeof vi.fn>, scopes: string[]): SessionGateway {
  return createGatewayHarness(request, scopes).gateway;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(["disconnected", "disposed"] as const)(
  "retires automatic group loads for a %s owner",
  async (boundary) => {
    const stale = createDeferred<{ groups: { name: string }[] }>();
    let reads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        return ++reads === 1 ? stale.promise : { groups: [{ name: "Current" }] };
      }
      if (method === "sessions.groups.defaults") {
        return { defaults: [{ name: "Current", cwd: "/workspace/current", worktree: true }] };
      }
      return sessionsResult([], 1);
    });
    const harness = createGatewayHarness(request, ["operator.write"]);
    const bootstrap = createConnectionBootstrapCoordinator();
    bootstrap.synchronize({ client: harness.gateway.snapshot.client, connected: true });
    const sessions = createSessionCapability(
      harness.gateway,
      {
        state: { selectedId: "main" },
        subscribe: () => () => {},
      },
      { connectionBootstrap: bootstrap },
    );
    const invalidate = () => harness.emitEvent(sessionChanged({ reason: "groups" }));
    try {
      invalidate();
      await vi.waitFor(() => expect(reads).toBe(1));
      const completion = bootstrap.run(sessions.groupsLoad, async () => {});
      invalidate();
      if (boundary === "disconnected") {
        harness.publish(false);
      } else if (boundary === "disposed") {
        sessions.dispose();
      }
      stale.resolve({ groups: [{ name: "Stale" }] });
      await completion;
      expect(reads).toBe(1);
      expect(sessions.state.groupSettings).not.toContainEqual({ name: "Stale", position: 0 });
    } finally {
      stale.resolve({ groups: [] });
      sessions.dispose();
      bootstrap.reset();
    }
  },
);

it("does not migrate browser groups without operator.write", async () => {
  const legacy = legacyGroups();
  const request = groupRequests({ "sessions.groups.list": () => ({ groups: [] }) });
  const sessions = createTestSessionCapability(createGateway(request, ["operator.read"]));

  await sessions.groupsLoad();

  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith("sessions.groups.list", {});
  expect(localStorage.getItem(legacyKey)).toBe(legacy);
});

it("migrates browser groups with operator.write", async () => {
  legacyGroups();
  const request = groupRequests({
    "sessions.groups.list": () => ({ groups: [] }),
    "sessions.groups.put": () => ({ groups: [{ name: "Research" }] }),
    "sessions.groups.defaults": () => ({ defaults: [{ name: "Research" }] }),
  });
  const sessions = createTestSessionCapability(createGateway(request, ["operator.write"]));

  await sessions.groupsLoad();

  expect(request).toHaveBeenCalledWith("sessions.groups.put", { names: ["Research"] });
  expect(sessions.state.groups).toEqual(["Research"]);
  expect(localStorage.getItem(legacyKey)).toBeNull();
});

it("does not replace saved groups from an invalidated legacy import", async () => {
  const legacy = legacyGroups();
  const stale = createDeferred<Groups>();
  const current = createDeferred<Groups>();
  let reads = 0;
  const request = groupRequests({
    "sessions.groups.list": () => (++reads === 1 ? stale.promise : current.promise),
    "sessions.groups.put": () => ({ groups: [{ name: "Research" }] }),
    "sessions.groups.defaults": () => ({ defaults: [clientDefaults] }),
  });
  const sessions = createTestSessionCapability(createGateway(request, ["operator.write"]));
  try {
    const staleLoad = sessions.groupsLoad();
    sessions.groupsInvalidate();
    const currentLoad = sessions.groupsLoad();
    stale.resolve({ groups: [] });
    await staleLoad;

    expect(request).not.toHaveBeenCalledWith("sessions.groups.put", expect.anything());
    expect(localStorage.getItem(legacyKey)).toBe(legacy);
    current.resolve({ groups: [{ name: "Client" }] });
    await currentLoad;
    expect(sessions.state.groupSettings).toEqual(expectedClient);
  } finally {
    current.resolve({ groups: [{ name: "Client" }] });
    sessions.dispose();
  }
});

it("clears cached cwd when a defaults update omits the removed value", async () => {
  const request = groupRequests({
    "sessions.groups.list": () => ({ groups: [clientGroup] }),
    "sessions.groups.defaults": () => ({ defaults: [clientDefaults] }),
    "sessions.groups.update": () => ({ defaults: [{ name: "Client", worktree: false }] }),
  });
  const gateway = createGateway(request, ["operator.write"]);
  gateway.snapshot.hello = {
    ...gateway.snapshot.hello,
    features: {
      methods: ["sessions.groups.list", "sessions.groups.defaults", "sessions.groups.update"],
    },
  } as GatewayHelloOk;
  const sessions = createTestSessionCapability(gateway);

  await sessions.groupsLoad();
  expect(sessions.state.groupSettings).toEqual(expectedClient);

  await expect(sessions.groupsUpdate("Client", { cwd: null, worktree: false })).resolves.toBe(
    "completed",
  );
  expect(sessions.state.groupSettings).toEqual([{ name: "Client", position: 0, worktree: false }]);
});

it("keeps path-free mutations pending until fresh defaults arrive", async () => {
  const refreshedDefaults = createDeferred<Defaults>();
  let defaultsCalls = 0;
  const request = groupRequests({
    "sessions.groups.list": () => ({ groups: [clientGroup] }),
    "sessions.groups.defaults": () => {
      defaultsCalls += 1;
      if (defaultsCalls === 1) {
        throw new Error("defaults unavailable");
      }
      return refreshedDefaults.promise;
    },
    "sessions.groups.put": () => ({ groups: [clientGroup] }),
  });
  const sessions = createTestSessionCapability(createGateway(request, ["operator.write"]));

  await expect(sessions.groupsLoad()).resolves.toBeNull();
  expect(sessions.groupsStatus()).toBe("unavailable");

  await expect(sessions.groupsPut(["Client"])).resolves.toBe("completed");
  await vi.waitFor(() => expect(defaultsCalls).toBe(2));
  expect(sessions.state.groups).toEqual(["Client"]);
  expect(sessions.groupsStatus()).toBe("loading");

  refreshedDefaults.resolve({ defaults: [clientDefaults] });
  await vi.waitFor(() => expect(sessions.groupsStatus()).toBe("ready"));
  expect(sessions.state.groupSettings).toEqual(expectedClient);
});

it("joins an in-flight load so route consumers see current defaults", async () => {
  const defaults = createDeferred<Defaults>();
  const request = groupRequests({
    "sessions.groups.list": () => ({ groups: [clientGroup] }),
    "sessions.groups.defaults": () => defaults.promise,
  });
  const sessions = createTestSessionCapability(createGateway(request, ["operator.write"]));

  const backgroundLoad = sessions.groupsLoad();
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sessions.groups.defaults", {}));
  let joined = false;
  const routeLoad = sessions.groupsLoad().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);

  defaults.resolve({ defaults: [clientDefaults] });
  await Promise.all([backgroundLoad, routeLoad]);
  expect(sessions.state.groupSettings).toEqual(expectedClient);
});

it("returns only defaults owned by the current same-client connection", async () => {
  const stale = createDeferred<Defaults>();
  const current = createDeferred<Defaults>();
  let calls = 0;
  const request = groupRequests({
    "sessions.subscribe": () => ({ subscribed: true }),
    "sessions.list": () => sessionsResult([], 1),
    "sessions.groups.list": () => ({ groups: [clientGroup] }),
    "sessions.groups.defaults": () => (++calls === 1 ? stale.promise : current.promise),
  });
  const harness = createGatewayHarness(request, ["operator.write"]);
  const sessions = createTestSessionCapability(harness.gateway);

  const staleLoad = sessions.groupsLoad();
  await vi.waitFor(() => expect(calls).toBe(1));
  harness.publish(false);
  harness.publish(true);
  const currentLoad = sessions.groupsLoad();
  await vi.waitFor(() => expect(calls).toBe(2));

  stale.resolve({
    defaults: [{ name: "Client", cwd: "/gateway-a", worktree: true }],
  });
  await expect(staleLoad).resolves.toBeNull();
  current.resolve({
    defaults: [{ name: "Client", cwd: "/gateway-b", worktree: false }],
  });
  await expect(currentLoad).resolves.toEqual([
    { name: "Client", position: 0, cwd: "/gateway-b", worktree: false },
  ]);
  expect(sessions.state.groupSettings).toEqual([
    { name: "Client", position: 0, cwd: "/gateway-b", worktree: false },
  ]);
});
