// @vitest-environment node
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { sessionRequest as groupRequests } from "./hydration-family.test-support.ts";
import { createSessionCapability } from "./index.ts";
import {
  createGatewayHarness as sharedGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import { sessionChanged } from "./session-rpc.test-support.ts";

const legacyKey = "openclaw:sessions:custom-groups";
const clientGroup = { name: "Client", position: 0 };
const clientDefaults = { name: "Client", cwd: "/repos/client", worktree: true };
const expectedClient = [{ ...clientGroup, ...clientDefaults }];
type Groups = { groups: { name: string; position: number }[] };
type Defaults = { defaults: (typeof clientDefaults)[] };
const groupMethods = (names: string[]) => names.map((name) => `sessions.groups.${name}`);

function legacyGroups() {
  vi.stubGlobal("localStorage", createStorageMock());
  const legacy = JSON.stringify(["Research"]);
  localStorage.setItem(legacyKey, legacy);
  return legacy;
}

function createGatewayHarness(
  request: ReturnType<typeof vi.fn>,
  scopes = ["operator.write"],
  methods = groupMethods(["list", "defaults", "put", "rename"]),
) {
  const harness = sharedGatewayHarness({ request } as unknown as GatewayBrowserClient, methods);
  harness.gateway.snapshot.hello = {
    ...harness.gateway.snapshot.hello,
    auth: { role: "operator", scopes },
  } as GatewayHelloOk;
  return harness;
}
function createSessions(request: ReturnType<typeof vi.fn>, scopes?: string[], methods?: string[]) {
  return createTestSessionCapability(createGatewayHarness(request, scopes, methods).gateway);
}

afterEach(() => vi.unstubAllGlobals());

it.each(["disconnected", "disposed"] as const)(
  "retires automatic group loads for a %s owner",
  async (boundary) => {
    const stale = createDeferred<Groups>();
    let reads = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        return ++reads === 1 ? stale.promise : { groups: [{ name: "Current", position: 0 }] };
      }
      if (method === "sessions.groups.defaults") {
        return { defaults: [{ name: "Current", cwd: "/workspace/current", worktree: true }] };
      }
      return sessionsResult([], 1);
    });
    const harness = createGatewayHarness(request);
    const bootstrap = createConnectionBootstrapCoordinator();
    bootstrap.synchronize({ client: harness.gateway.snapshot.client, connected: true });
    const sessions = createSessionCapability(
      harness.gateway,
      { state: { selectedId: "main" }, subscribe: () => () => {} },
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
      } else {
        sessions.dispose();
      }
      stale.resolve({ groups: [{ name: "Stale", position: 0 }] });
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

it.each([false, true])(
  "migrates browser groups only with write authority (%s)",
  async (writable) => {
    const legacy = legacyGroups();
    const request = groupRequests({
      "sessions.groups.list": () => ({ groups: [] }),
      ...(writable
        ? {
            "sessions.groups.put": () => ({ groups: [{ name: "Research", position: 0 }] }),
            "sessions.groups.defaults": () => ({ defaults: [{ name: "Research" }] }),
          }
        : {}),
    });
    const sessions = createSessions(request, [writable ? "operator.write" : "operator.read"]);
    await sessions.groupsLoad();
    if (writable) {
      expect(request).toHaveBeenCalledWith("sessions.groups.put", { names: ["Research"] });
      expect(sessions.state.groups).toEqual(["Research"]);
    } else {
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith("sessions.groups.list", {});
    }
    expect(localStorage.getItem(legacyKey)).toBe(writable ? null : legacy);
  },
);

it("does not replace saved groups from an invalidated legacy import", async () => {
  const legacy = legacyGroups();
  const stale = createDeferred<Groups>();
  const current = createDeferred<Groups>();
  let reads = 0;
  const request = groupRequests({
    "sessions.groups.list": () => (++reads === 1 ? stale.promise : current.promise),
    "sessions.groups.put": () => ({ groups: [{ name: "Research", position: 0 }] }),
    "sessions.groups.defaults": () => ({ defaults: [clientDefaults] }),
  });
  const sessions = createSessions(request);
  onTestFinished(() => current.resolve({ groups: [clientGroup] }));
  const staleLoad = sessions.groupsLoad();
  sessions.groupsInvalidate();
  const currentLoad = sessions.groupsLoad();
  stale.resolve({ groups: [] });
  await staleLoad;
  expect(request).not.toHaveBeenCalledWith("sessions.groups.put", expect.anything());
  expect(localStorage.getItem(legacyKey)).toBe(legacy);
  current.resolve({ groups: [clientGroup] });
  await currentLoad;
  expect(sessions.state.groupSettings).toEqual(expectedClient);
});

it("reloads path-free mutations and clears removed defaults on update", async () => {
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
    "sessions.groups.update": () => ({ defaults: [{ name: "Client", worktree: false }] }),
  });
  const sessions = createSessions(
    request,
    undefined,
    groupMethods(["list", "defaults", "put", "update"]),
  );

  await expect(sessions.groupsLoad()).resolves.toBeNull();
  expect(sessions.groupsStatus()).toBe("unavailable");

  await expect(sessions.groupsPut(["Client"])).resolves.toBe("completed");
  await vi.waitFor(() => expect(defaultsCalls).toBe(2));
  expect(sessions.state.groups).toEqual(["Client"]);
  expect(sessions.groupsStatus()).toBe("loading");

  refreshedDefaults.resolve({ defaults: [clientDefaults] });
  await vi.waitFor(() => expect(sessions.groupsStatus()).toBe("ready"));
  expect(sessions.state.groupSettings).toEqual(expectedClient);
  await expect(sessions.groupsUpdate("Client", { cwd: null, worktree: false })).resolves.toBe(
    "completed",
  );
  expect(sessions.state.groupSettings).toEqual([{ name: "Client", position: 0, worktree: false }]);
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
  const harness = createGatewayHarness(request);
  const sessions = createTestSessionCapability(harness.gateway);

  const staleLoad = sessions.groupsLoad();
  await vi.waitFor(() => expect(calls).toBe(1));
  harness.publish(false);
  harness.publish(true);
  const currentLoad = sessions.groupsLoad();
  await vi.waitFor(() => expect(calls).toBe(2));
  let joined = false;
  const routeLoad = sessions.groupsLoad().then((settings) => {
    joined = true;
    return settings;
  });
  await Promise.resolve();
  expect(joined).toBe(false);

  stale.resolve({ defaults: [{ name: "Client", cwd: "/gateway-a", worktree: true }] });
  await expect(staleLoad).resolves.toBeNull();
  const currentDefaults = { name: "Client", cwd: "/gateway-b", worktree: false };
  current.resolve({ defaults: [currentDefaults] });
  const expected = [{ ...clientGroup, ...currentDefaults }];
  await expect(currentLoad).resolves.toEqual(expected);
  await expect(routeLoad).resolves.toEqual(expected);
  expect(sessions.state.groupSettings).toEqual(expected);
});
