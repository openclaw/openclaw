// @vitest-environment node
import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import { createApplicationRouter, startApplicationRouter } from "../app-routes.ts";
import {
  createSessionRouteContext,
  createSessionRouteRow,
} from "../pages/chat/route-resolution.test-support.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import type { ApplicationContext } from "./context.ts";

afterEach(() => vi.restoreAllMocks());

async function setup(pathname = "/chat/main/dashboard/12345678-90ab-cdef-1234-567890abcdef") {
  const request = vi.fn(async (): Promise<{ ok: boolean; key?: string }> => ({ ok: true }));
  const fixture = createApplicationGateway({
    phase: "connected",
    client: createTestGatewayClient(request),
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
    hello: gatewayHelloForMethods([]),
    selfUser: { id: "reader" },
  });
  const context = {
    basePath: "",
    gateway: fixture.gateway,
    agents: { state: { agentsList: { mainKey: "main" } } },
  } as ApplicationContext;
  let location: RouteLocation = { pathname: "/activity", search: "", hash: "" };
  const writeHistory = vi.fn((next: RouteLocation) => {
    location = next;
  });
  const history: RouterHistory = {
    location: () => location,
    push: writeHistory,
    replace: writeHistory,
    listen: () => () => {},
  };
  const router = createApplicationRouter();
  onTestFinished(() => router.stop());
  const activity = router.getRoute("activity")!;
  vi.spyOn(activity, "component").mockResolvedValue({ render: () => null });
  vi.spyOn(activity, "loader").mockResolvedValue(null);
  const chat = router.getRoute("chat")!;
  vi.spyOn(chat, "component").mockResolvedValue({ render: () => null });
  const load = vi.spyOn(chat, "loader").mockResolvedValue({ sessionKey: "destination" });
  await startApplicationRouter(router, history, "", context);
  const destination: RouteLocation = {
    pathname,
    search: "?draft=keep-this",
    hash: "#message",
  };
  const disconnect = () =>
    fixture.publish({ ...fixture.gateway.snapshot, phase: "reconnecting", hello: null });
  const reconnect = () =>
    fixture.publish({
      ...fixture.gateway.snapshot,
      phase: "connected",
      hello: gatewayHelloForMethods([]),
    });
  const beginLoad = async () => {
    const deferred = createDeferredCore<unknown>();
    load.mockImplementationOnce(() => deferred.promise);
    const navigation = router
      .navigate("chat", context, { history: "push" }, destination)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    return { deferred, navigation };
  };
  return {
    ...fixture,
    context,
    router,
    load,
    destination,
    disconnect,
    reconnect,
    beginLoad,
    writeHistory,
    request,
  };
}

describe("session route reconnect recovery", () => {
  const referencePath = "/chat/main/research-12345678";
  const session = {
    kind: "session",
    sessionKey: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
  };

  it.each(["pending", "cached"])(
    "verifies first-connect data only when it was already committed offline: %s",
    async (state) => {
      const f = await setup(referencePath);
      f.router.stop();
      f.publish({ ...f.gateway.snapshot, phase: "connecting", hello: null });
      const loaded = createDeferredCore<unknown>();
      f.load.mockImplementationOnce(() => loaded.promise);
      f.request.mockResolvedValue({ ok: true, key: session.sessionKey });
      const startup = startApplicationRouter(
        f.router,
        {
          location: () => f.destination,
          push: f.writeHistory,
          replace: f.writeHistory,
          listen: () => () => {},
        },
        "",
        f.context,
      );
      await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
      if (state === "pending") {
        f.reconnect();
      }
      loaded.resolve(session);
      await startup;
      if (state === "cached") {
        f.reconnect();
      }
      await vi.dynamicImportSettled();
      expect(f.request).toHaveBeenCalledTimes(state === "cached" ? 1 : 0);
      expect(f.load).toHaveBeenCalledOnce();
    },
  );

  it("retries a failed first-connect loader without adding success verification", async () => {
    const f = await setup(referencePath);
    f.router.stop();
    f.publish({ ...f.gateway.snapshot, phase: "connecting", hello: null });
    f.load.mockRejectedValueOnce(new Error("Gateway unavailable")).mockResolvedValue(session);
    await startApplicationRouter(
      f.router,
      {
        location: () => f.destination,
        push: f.writeHistory,
        replace: f.writeHistory,
        listen: () => () => {},
      },
      "",
      f.context,
    ).catch(() => undefined);
    expect(f.router.getState().status).toBe("error");
    f.reconnect();
    await vi.waitFor(() => expect(f.router.getState().status).toBe("success"));
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("verifies cached loader data when its component commits after the first hello", async () => {
    const row = createSessionRouteRow();
    const { context, publishGateway, request } = createSessionRouteContext({ ok: false }, [row]);
    context.gateway.snapshot.phase = "connecting";
    context.sessions.state.resultCached = true;
    const router = createApplicationRouter();
    context.router = router;
    onTestFinished(() => router.stop());
    const component = createDeferredCore<{ render: () => null }>();
    const route = router.getRoute("chat")!;
    vi.spyOn(route, "component").mockReturnValue(component.promise);
    const loader = route.loader!;
    const completed = vi.fn();
    vi.spyOn(route, "loader").mockImplementation(async (...args) => {
      const result = await loader(...args);
      completed(result);
      return result;
    });
    const location = { pathname: "/chat/roboclaw/cached-12345678", search: "", hash: "" };
    const startup = startApplicationRouter(
      router,
      { location: () => location, push: () => {}, replace: () => {}, listen: () => () => {} },
      "",
      context,
    );
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(request).not.toHaveBeenCalled();
    publishGateway({ phase: "connected", hello: gatewayHelloForMethods([]) });
    component.resolve({ render: () => null });
    await startup;
    await vi.waitFor(() =>
      expect(router.getState().matches[0]?.data).toMatchObject({ kind: "missing-session" }),
    );
    expect(request).toHaveBeenCalledWith(
      "sessions.resolve",
      expect.objectContaining({ reference: { key: row.key } }),
    );
  });

  it("verifies a bridged startup route whose component finishes after reconnect", async () => {
    const f = await setup(referencePath);
    f.router.stop();
    const component = createDeferredCore<{ render: () => null }>();
    vi.spyOn(f.router.getRoute("chat")!, "component").mockReturnValue(component.promise);
    f.load.mockResolvedValueOnce(session).mockResolvedValue({ kind: "missing-session" });
    f.request.mockResolvedValue({ ok: false });
    const startup = startApplicationRouter(
      f.router,
      {
        location: () => f.destination,
        push: f.writeHistory,
        replace: f.writeHistory,
        listen: () => () => {},
      },
      "",
      f.context,
    );
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    f.disconnect();
    f.reconnect();
    component.resolve({ render: () => null });
    await startup;
    await vi.waitFor(() =>
      expect(f.router.getState().matches[0]?.data).toEqual({ kind: "missing-session" }),
    );
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "sessions.resolve",
      expect.objectContaining({ reference: { key: session.sessionKey } }),
    );
    expect(f.writeHistory).not.toHaveBeenCalled();
  });

  it.each(["before", "after"])(
    "verifies an offline-resolved session that commits %s reconnect",
    async (settlement) => {
      const f = await setup(referencePath);
      f.request.mockResolvedValue({ ok: false });
      f.load.mockResolvedValue({ kind: "missing-session" });
      const { deferred, navigation } = await f.beginLoad();
      f.disconnect();
      if (settlement === "after") {
        f.reconnect();
      }
      deferred.resolve(session);
      await navigation;
      if (settlement === "before") {
        f.reconnect();
      }
      await vi.waitFor(() =>
        expect(f.router.getState().matches[0]?.data).toEqual({ kind: "missing-session" }),
      );
      expect(f.request).toHaveBeenCalledExactlyOnceWith(
        "sessions.resolve",
        expect.objectContaining({ reference: { key: session.sessionKey } }),
      );
      expect(f.writeHistory).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["/chat/main", "/chat/main/~key/research"])(
    "preserves a creation route across reconnect: %s",
    async (pathname) => {
      const f = await setup(pathname);
      f.load.mockResolvedValue(session);
      await f.router.navigate("chat", f.context, {}, f.destination);
      f.disconnect();
      f.reconnect();
      await Promise.resolve();
      expect(f.request).not.toHaveBeenCalled();
      expect(f.load).toHaveBeenCalledOnce();
    },
  );

  it.each(["present", "unavailable"])(
    "keeps established history when exact discovery is %s",
    async (result) => {
      const f = await setup(referencePath);
      f.load.mockResolvedValue(session);
      await f.router.navigate("chat", f.context, {}, f.destination);
      const match = f.router.getState().matches[0];
      if (result === "unavailable") {
        f.request.mockRejectedValue(new Error("Gateway starting"));
      } else {
        f.request.mockResolvedValue({ ok: true, key: session.sessionKey });
      }
      f.disconnect();
      f.reconnect();
      await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(f.router.getState().matches[0]).toBe(match);
      expect(f.load).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["navigation", "connection", "stop"])(
    "rejects a late missing result after %s",
    async (change) => {
      const f = await setup(referencePath);
      f.load.mockResolvedValue(session);
      await f.router.navigate("chat", f.context, {}, f.destination);
      const pending = createDeferredCore<{ ok: boolean }>();
      f.request.mockReturnValue(pending.promise);
      f.disconnect();
      f.reconnect();
      await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
      if (change === "navigation") {
        await f.router.navigate("activity", f.context, {});
      } else if (change === "connection") {
        f.disconnect();
      } else {
        f.router.stop();
      }
      pending.resolve({ ok: false });
      await Promise.resolve();
      await Promise.resolve();
      expect(f.load).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["before", "after"])(
    "resumes a failed session load when its rejection settles %s reconnect",
    async (settlement) => {
      const fixture = await setup();
      const { deferred, navigation } = await fixture.beginLoad();
      fixture.disconnect();
      if (settlement === "after") {
        fixture.reconnect();
      }
      deferred.reject(new Error("gateway closed (1006):"));
      await navigation;
      if (settlement === "before") {
        fixture.reconnect();
      }
      await vi.waitFor(() => expect(fixture.router.getState().status).toBe("success"));
      expect(fixture.router.getState().matches[0]).toMatchObject({
        location: fixture.destination,
        data: { sessionKey: "destination" },
      });
      expect(fixture.load).toHaveBeenCalledTimes(2);
      expect(fixture.writeHistory).toHaveBeenCalledExactlyOnceWith(fixture.destination);
      fixture.reconnect();
      await Promise.resolve();
      expect(fixture.load).toHaveBeenCalledTimes(2);
    },
  );

  it("lets newer navigation win before a queued recovery runs", async () => {
    const fixture = await setup();
    const { deferred, navigation } = await fixture.beginLoad();
    fixture.disconnect();
    deferred.reject(new Error("gateway closed (1006):"));
    await navigation;
    fixture.reconnect();
    await fixture.router.navigate("activity", fixture.context, { history: "push" });
    expect(fixture.router.getState().matches[0]?.routeId).toBe("activity");
    expect(fixture.load).toHaveBeenCalledOnce();
  });

  it("preserves a loaded conversation across reconnect", async () => {
    const fixture = await setup();
    await fixture.router.navigate(
      "chat",
      fixture.context,
      { history: "push" },
      fixture.destination,
    );
    const match = fixture.router.getState().matches[0];
    fixture.disconnect();
    fixture.reconnect();
    await Promise.resolve();
    expect(fixture.router.getState().matches[0]).toBe(match);
    expect(fixture.load).toHaveBeenCalledOnce();
  });

  it("does not adopt an interrupted load into a replacement Gateway", async () => {
    const fixture = await setup();
    const { deferred, navigation } = await fixture.beginLoad();
    fixture.disconnect();
    Object.defineProperty(fixture.gateway, "connectionRevision", { value: 1 });
    fixture.disconnect();
    deferred.reject(new Error("gateway closed (1006):"));
    await navigation;
    fixture.reconnect();
    await Promise.resolve();
    expect(fixture.load).toHaveBeenCalledOnce();
  });

  it.each(["failure", "replacement", "stop"])(
    "does not replay a session for an unrelated %s",
    async (reason) => {
      const fixture = await setup();
      const { deferred, navigation } = await fixture.beginLoad();
      if (reason !== "failure") {
        fixture.disconnect();
      }
      deferred.reject(new Error(reason === "failure" ? "Access denied" : "gateway closed (1006):"));
      await navigation;
      if (reason === "failure") {
        fixture.disconnect();
      } else if (reason === "replacement") {
        Object.defineProperty(fixture.gateway, "connectionRevision", { value: 1 });
      } else {
        fixture.router.stop();
      }
      fixture.reconnect();
      await Promise.resolve();
      expect(fixture.load).toHaveBeenCalledOnce();
    },
  );
});
