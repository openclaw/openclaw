// @vitest-environment node
import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import { createApplicationRouter, startApplicationRouter, type RouteId } from "../app-routes.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "./context.ts";

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const fixture = createApplicationGateway({
    phase: "connected",
    client: {},
    hello: gatewayHelloForMethods([]),
    selfUser: { id: "reader" },
  } as ApplicationGatewaySnapshot);
  const context = { basePath: "", gateway: fixture.gateway } as ApplicationContext<RouteId>;
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
    pathname: "/chat/main/dashboard/12345678-90ab-cdef-1234-567890abcdef",
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
  };
}

describe("session route reconnect recovery", () => {
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
