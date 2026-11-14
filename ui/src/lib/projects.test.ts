import type { ProjectRecord, ProjectsListResult } from "@openclaw/gateway-protocol";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { watchedGateway } from "./gateway-stores.test-support.ts";
import { projectsForGateway } from "./projects.ts";

const project: ProjectRecord = {
  id: "registered",
  displayName: "ClawSweeper",
  repoRoot: "/workspace/project",
  source: "registered",
  originUrl: "https://github.com/openclaw/clawsweeper.git",
};

function harness() {
  const request = vi.fn(async (): Promise<ProjectsListResult> => ({ projects: [project] }));
  const hello = gatewayHelloForMethods(["projects.list"], ["operator.read", "operator.write"]);
  hello.auth!.recoveryScope = "test-recovery-scope";
  const connection = watchedGateway({
    client: createTestGatewayClient(request),
    hello,
    sessionKey: "agent:main:first",
  });
  const { gateway, publish } = connection;
  const snapshot = gateway.snapshot;
  const store = projectsForGateway(gateway);
  const detach = store.subscribe(vi.fn());
  onTestFinished(detach);
  return {
    ...connection,
    request,
    snapshot,
    store,
    detach,
    emit: () => publish(snapshot),
    replace: async (projects: ProjectRecord[]) => {
      request.mockResolvedValue({ projects });
      await store.refresh(true);
    },
  };
}

it("records an initial discovery failure without treating the catalog as ready", async () => {
  const request = vi.fn(async (): Promise<ProjectsListResult> => {
    throw new Error("Project discovery unavailable");
  });
  const hello = gatewayHelloForMethods(["projects.list"], ["operator.read", "operator.write"]);
  const connection = watchedGateway({
    client: createTestGatewayClient(request),
    hello,
    sessionKey: "agent:main:first",
  });
  const store = projectsForGateway(connection.gateway);
  const detach = store.subscribe(vi.fn());
  onTestFinished(detach);
  await store.pendingRead;
  expect(store.snapshot).toMatchObject({ result: null, ready: false });
  expect(store.snapshot.error).toEqual(new Error("Project discovery unavailable"));
  request.mockResolvedValue({ projects: [project] });
  await store.refresh();
  expect(store.snapshot).toMatchObject({
    ready: true,
    error: null,
    result: { projects: [project] },
  });
});

it("shares one cold read across chat and the picker, preserving recents", async () => {
  const h = harness();
  const picker = projectsForGateway(h.gateway);
  onTestFinished(picker.subscribe(vi.fn()));
  expect(picker).toBe(h.store);
  const pending = h.store.pendingRead;
  expect(pending).not.toBeNull();
  expect(picker.pendingRead).toBe(pending);
  expect(h.store.refresh()).toBe(pending);
  await pending;
  expect(h.store.pendingRead).toBeNull();
  expect(h.request).toHaveBeenCalledExactlyOnceWith("projects.list", {});
  h.snapshot.sessionKey = "agent:other:second";
  h.emit();
  expect(h.request).toHaveBeenCalledTimes(1);
  const recents: ProjectsListResult["recents"] = [
    { kind: "project", projectId: project.id, displayName: project.displayName },
  ];
  h.request.mockResolvedValue({ projects: [project], recents });
  await picker.refresh(true);
  expect(picker.snapshot.result?.recents).toEqual(recents);
});

describe("registered project catalog", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness();
    await h.store.refresh();
  });
  it("keeps registered projects while offline and awaiting reconnect refresh", async () => {
    const hello = h.snapshot.hello;
    h.snapshot.phase = "reconnecting";
    h.snapshot.hello = null;
    h.emit();
    expect(h.store.snapshot.result?.projects).toEqual([project]);
    const refreshed = createDeferred<ProjectsListResult>();
    h.request.mockReturnValue(refreshed.promise);
    h.snapshot.phase = "connected";
    h.snapshot.hello = hello;
    h.emit();
    expect(h.store.snapshot.result?.projects).toEqual([project]);
    refreshed.resolve({ projects: [] });
    await h.store.refresh();
    expect(h.store.snapshot.result?.projects).toEqual([]);
  });

  it("retires projects for every consumer before an invalidating refresh can fail", async () => {
    const listener = vi.fn();
    onTestFinished(h.store.subscribe(listener));
    const failed = createDeferred<ProjectsListResult>();
    h.request.mockReturnValueOnce(failed.promise);
    const refresh = h.store.refresh(true);
    const invalidated = h.store.snapshot;
    failed.reject(new Error("catalog unavailable"));
    await refresh;
    expect(invalidated).toEqual({ result: null, ready: false, error: null });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(h.store.snapshot).toMatchObject({ result: null, ready: false });
    expect(h.store.snapshot.error).toEqual(new Error("catalog unavailable"));
    const replacement = { ...project, originUrl: "https://github.com/replacement/clawsweeper.git" };
    await h.replace([replacement]);
    expect(h.store.snapshot.result?.projects).toEqual([replacement]);
    expect(h.store.snapshot.error).toBeNull();
  });

  it.each(["client", "reconnect", "principal", "scope", "connection"])(
    "rejects a late %s result and loads the current projection",
    async (change) => {
      const old = createDeferred<ProjectsListResult>();
      h.request.mockReturnValueOnce(old.promise);
      const pending = h.store.refresh(true);
      const current = { ...project, originUrl: undefined, displayName: "Release Tools" };
      h.request.mockResolvedValue({ projects: [current] });
      if (change === "client") {
        h.snapshot.client = createTestGatewayClient(h.request);
      } else if (change === "reconnect") {
        h.snapshot.phase = "reconnecting";
        h.emit();
        h.snapshot.phase = "connected";
      } else if (change === "principal") {
        h.snapshot.hello!.auth!.recoveryScope = "principal-b";
      } else if (change === "scope") {
        h.snapshot.hello!.auth!.scopes = ["operator.read"];
      } else if (change === "connection") {
        h.gateway.connection.gatewayUrl = "ws://replacement.test";
      }
      h.emit();
      expect(h.store.snapshot.result).toBeNull();
      await h.store.refresh();
      old.resolve({ projects: [project] });
      await pending;
      expect(h.store.snapshot.result?.projects[0]?.displayName).toBe("Release Tools");
    },
  );

  it("clears projects on read permission loss without requesting wider access", async () => {
    h.snapshot.hello!.auth!.scopes = [];
    h.emit();
    expect(h.store.snapshot.result?.projects).toEqual([]);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("retires pending work and its listener when the final consumer leaves", async () => {
    const pending = createDeferred<ProjectsListResult>();
    h.request.mockReturnValueOnce(pending.promise);
    const request = h.store.refresh(true);
    expect(h.gateway.subscribe).toHaveBeenCalledOnce();
    expect(h.unsubscribe).not.toHaveBeenCalled();
    h.detach();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    pending.resolve({ projects: [project] });
    await request;
    expect(h.store.snapshot.result).toBeNull();
  });
});
