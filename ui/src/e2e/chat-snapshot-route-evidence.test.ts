import { expect, vi } from "vitest";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { createControlUiMockGatewayInitScript } from "../test-helpers/control-ui-e2e.ts";
import {
  flushMockTimers,
  mockGatewayTest as it,
} from "../test-helpers/mock-gateway-page.test-support.ts";
import { captureSnapshotRouteEvidence } from "./chat-snapshot-route-evidence.test-support.ts";

it("retains admission and reply evidence without replacing results or recording message content", async ({
  gatewayPage,
}) => {
  const { execute, window, responses } = gatewayPage;
  const debug = vi.spyOn(window.console, "debug").mockImplementation(() => {});
  execute(createControlUiMockGatewayInitScript({ heldMethods: ["sessions.resolve"] }));
  execute(`(${captureSnapshotRouteEvidence.toString()})("session-path");`);
  execute(`
    const value = { kind: "session", sessionKey: "agent:main:chat:original",
      key: "agent:other:chat:accepted", sessionResolutionFromCache: "snapshot",
      messages: [{ content: "private transcript payload" }] };
    const promise = Promise.resolve(value);
    const sentinel = new Error("original exception");
    const route = { loader: () => promise };
    const context = {
      router: { getRoute: () => route,
        getState: () => ({ matches: [], pendingMatches: [] }),
        subscribe: () => () => {} },
      gateway: { snapshot: { client: { request(method) {
        if (method === "sessions.describe") throw sentinel;
        return promise;
      } } }, subscribe: () => () => {} },
      navigate() {}, navigateAndWait() { return promise; }, replace() {}
    };
    const provider = document.createElement("div");
    document.body.append(provider);
    provider.addEventListener("context-request", event => event.callback(context));
    provider.dispatchEvent(Object.assign(new Event("context-provider", { bubbles: true }),
      { context: "openclaw.application" }));
    if (context.gateway.snapshot.client.request("sessions.resolve", { reference: { key: "requested" } }) !== promise)
      throw new Error("RPC promise was replaced");
    let threw = false;
    try { context.gateway.snapshot.client.request("sessions.describe"); }
    catch (error) {
      if (error !== sentinel) throw new Error("RPC exception was replaced");
      threw = true;
    }
    if (!threw) throw new Error("RPC exception was swallowed");
    const controller = new AbortController();
    const options = { cause: "navigation", signal: controller.signal,
      location: { pathname: "/chat", search: "?session-path=/chat/main/original" } };
    if (route.loader(context, options) !== promise) throw new Error("Loader promise was replaced");
    controller.abort();
    route.loader(context, { ...options, signal: new AbortController().signal });
    context.replace("chat", { pathname: "/chat/other/accepted" });
    if (context.navigateAndWait("chat", { pathname: "/chat/other/accepted" }) !== promise)
      throw new Error("Navigation promise was replaced");
    history.replaceState({}, "", "/chat/other/accepted");
  `);
  const { send } = gatewayPage.connect();
  await flushMockTimers();
  send("held-resolve", "sessions.resolve", { reference: { key: "requested" } });
  expect(responses).toEqual([]);
  (window as MockGatewayWindow).openclawControlUiE2eGateway!.resolveDeferred("sessions.resolve", {
    key: "agent:other:chat:accepted",
    messages: [{ content: "private transcript payload" }],
  });
  await flushMockTimers();
  expect(responses).toEqual([
    expect.objectContaining({
      id: "held-resolve",
      payload: {
        key: "agent:other:chat:accepted",
        messages: [{ content: "private transcript payload" }],
      },
    }),
  ]);
  const events = debug.mock.calls.map(([text]) =>
    JSON.parse(String(text).slice("[snapshot-route] ".length)),
  );
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "route.admission",
        decision: "accepted",
        result: expect.objectContaining({ cache: "snapshot" }),
      }),
      expect.objectContaining({
        event: "route.admission",
        decision: "rejected",
        reason: "aborted",
      }),
      expect.objectContaining({
        event: "rpc.consumed",
        method: "sessions.resolve",
        key: "requested",
        reply: expect.objectContaining({ key: "agent:other:chat:accepted" }),
      }),
      expect.objectContaining({
        event: "rpc.rejected",
        method: "sessions.describe",
        reason: "Error",
      }),
      expect.objectContaining({
        event: "mock.reply.dispatched",
        id: "held-resolve",
        key: "requested",
      }),
      expect.objectContaining({
        event: "history.replaceState",
        to: "/chat/other/accepted",
        source: expect.any(String),
      }),
      expect.objectContaining({
        event: "navigation.replace",
        pathname: "/chat/other/accepted",
        source: expect.any(String),
      }),
      expect.objectContaining({
        event: "navigation.navigateAndWait",
        pathname: "/chat/other/accepted",
        source: expect.any(String),
      }),
    ]),
  );
  expect(
    events.every((event) => Number.isFinite(event.at) && Number.isFinite(event.sequence)),
  ).toBe(true);
  expect(JSON.stringify(events)).not.toContain("private transcript payload");
});
