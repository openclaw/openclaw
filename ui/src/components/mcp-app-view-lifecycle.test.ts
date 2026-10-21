import { flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { i18n } from "../i18n/index.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { createMcpBridgeFixture } from "../test-helpers/mcp-app-view-bridge.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { mountView } from "./mcp-app-view.test-support.ts";

const bridgeMocks = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
  transports: [] as Array<Record<string, unknown>>,
  appModes: undefined as string[] | undefined,
}));
vi.mock("@modelcontextprotocol/ext-apps/app-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@modelcontextprotocol/ext-apps/app-bridge")>();
  const { createMcpAppBridgeMocks } = await import("./mcp-app-view-mocks.test-support.ts");
  return { ...actual, ...createMcpAppBridgeMocks(bridgeMocks) };
});
const mountBridge = createMcpBridgeFixture(bridgeMocks);
function viewCalls(request: ReturnType<typeof createGatewayRequestMock>) {
  return request.mock.calls.filter(([method]) => method === "mcp.app.view");
}
const replacement = { sessionKey: "agent:other:main", viewId: "view-final", agentId: "other" };

it("coalesces same-turn identity changes into one replacement view", async () => {
  const { view, request } = await mountBridge("view-batched-original");
  Object.assign(view, replacement);
  await waitForSolid(() => {
    expect(viewCalls(request)).toHaveLength(2);
    expect(viewCalls(request)[1]?.[1]).toEqual(replacement);
  });
});

it.each(["restart", "binding"])("reopens a retired view only on %s", async (reopen) => {
  const { view, request, gateway, publish } = await mountBridge("view-retired");
  await view.teardown();
  publish({ ...gateway.snapshot, phase: "reconnecting" });
  flush();
  publish({ ...gateway.snapshot, phase: "connected" });
  Object.assign(view, { title: "Retained title", surface: "board" });
  await view.updateComplete;
  expect(view.querySelector("iframe")).toBeNull();
  expect(viewCalls(request)).toHaveLength(1);
  if (reopen === "restart") {
    view.restartAfterTeardown();
  } else {
    view.viewId = "view-retired-replacement";
  }
  await waitForSolid(() => expect(viewCalls(request)).toHaveLength(2));
});

it.each(["user", "generation", "access"] as const)("updates binding on %s", async (change) => {
  const { view, frame, request, gateway, publish } = await mountBridge("view-same-object");
  if (change === "user") {
    gateway.snapshot.selfUser = { id: "one", name: "One" };
    publish(gateway.snapshot);
    flush();
    expect(viewCalls(request)).toHaveLength(1);
    expect(view.querySelector("iframe")).toBe(frame);
    gateway.snapshot.selfUser = { id: "two", name: "Two" };
  } else if (change === "generation") {
    const value = gateway.connectionRevision + 1;
    Object.defineProperty(gateway, "connectionRevision", { value });
  } else {
    gateway.snapshot.hello!.auth!.scopes = [];
  }
  publish(gateway.snapshot);
  await waitForSolid(() => {
    expect(frame.isConnected).toBe(false);
    expect(viewCalls(request)).toHaveLength(change === "access" ? 1 : 2);
  });
  if (change === "access") {
    expect(view.querySelector(".error")?.textContent).toContain("gateway unavailable");
  }
});

it("retires an initializing request synchronously before coalescing reconnect inputs", async () => {
  const response = deferred<unknown>();
  const request = createGatewayRequestMock(() => response.promise);
  const { gateway, publish } = createApplicationGateway();
  const client = createTestGatewayClient(request);
  const hello = gatewayHelloForMethods(["mcp.app.view"]);
  publish({ ...gateway.snapshot, client, phase: "connected", hello });
  const binding = { sessionKey: "agent:main:main", viewId: "view-initializing" };
  const { view, unmount } = mountView(binding, { gateway });
  publish({ ...gateway.snapshot, hello: gatewayHelloForMethods(["mcp.app.view"]) });
  await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
  const signal = request.mock.calls[0]?.[2]?.signal;
  expect(signal?.aborted).toBe(false);
  publish({ ...gateway.snapshot, phase: "reconnecting" });
  expect(signal?.aborted).toBe(true);
  publish({ ...gateway.snapshot, phase: "connected" });
  Object.assign(view, replacement);
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual(replacement);
  });
  unmount();
  response.resolve({});
});

it("updates the default localized title without resetting negotiated frame height", async () => {
  const { view, frame, bridge, request } = await mountBridge("view-localized-title");
  view.title = "";
  await view.updateComplete;
  bridge.onsizechange?.({ height: 900 });
  i18n.registerTranslation("de", { mcpApp: { title: "Lokalisierte App" } });
  await i18n.setLocale("de");
  expect(frame).toMatchObject({ title: "Lokalisierte App", style: { height: "900px" } });
  expect(view.querySelector("iframe")).toBe(frame);
  expect(viewCalls(request)).toHaveLength(1);
});
