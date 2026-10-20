import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
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

describe("mcp-app-view owner lifecycle", () => {
  it("coalesces same-turn identity changes into one replacement view", async () => {
    const { view, request } = await mountBridge("view-batched-original");
    view.sessionKey = "agent:other:main";
    view.viewId = "view-batched-final";
    view.agentId = "other";
    await waitForSolid(() => {
      const viewCalls = request.mock.calls.filter(([method]) => method === "mcp.app.view");
      expect(viewCalls).toHaveLength(2);
      expect(viewCalls[1]?.[1]).toEqual({
        sessionKey: "agent:other:main",
        viewId: "view-batched-final",
        agentId: "other",
      });
    });
  });

  it("rebinds when a same-object gateway publication changes the user scope", async () => {
    const { view, frame, request, gateway, publish } = await mountBridge("view-user-scope");
    gateway.snapshot.selfUser = { id: "one", name: "One" };
    publish(gateway.snapshot);
    flush();
    expect(request.mock.calls.filter(([method]) => method === "mcp.app.view")).toHaveLength(1);
    expect(view.querySelector("iframe")).toBe(frame);
    gateway.snapshot.selfUser = { id: "two", name: "Two" };
    publish(gateway.snapshot);
    await waitForSolid(() => {
      expect(request.mock.calls.filter(([method]) => method === "mcp.app.view")).toHaveLength(2);
      expect(frame.isConnected).toBe(false);
    });
  });

  it.each(["restart", "binding"])(
    "keeps a retired view closed until an explicit %s change",
    async (reopen) => {
      const { view, request, gateway, publish } = await mountBridge("view-retired");
      await view.teardown();
      const hello = gateway.snapshot.hello;
      publish({ ...gateway.snapshot, phase: "reconnecting" });
      flush();
      publish({ ...gateway.snapshot, phase: "connected", hello });
      view.title = "Retained title";
      view.surface = "board";
      await view.updateComplete;
      expect(view.querySelector("iframe")).toBeNull();
      expect(request.mock.calls.filter(([method]) => method === "mcp.app.view")).toHaveLength(1);
      if (reopen === "restart") {
        view.restartAfterTeardown();
      } else {
        view.viewId = "view-retired-replacement";
      }
      await waitForSolid(() =>
        expect(request.mock.calls.filter(([method]) => method === "mcp.app.view")).toHaveLength(2),
      );
    },
  );

  it.each(["generation", "access"] as const)(
    "observes an in-place gateway %s publication",
    async (change) => {
      const { view, frame, request, gateway, publish } = await mountBridge("view-same-object");
      if (change === "generation") {
        Object.defineProperty(gateway, "connectionRevision", {
          value: gateway.connectionRevision + 1,
        });
      } else {
        gateway.snapshot.hello!.auth!.scopes = [];
      }
      publish(gateway.snapshot);
      await waitForSolid(() => expect(frame.isConnected).toBe(false));
      if (change === "generation") {
        await waitForSolid(() =>
          expect(request.mock.calls.filter(([method]) => method === "mcp.app.view")).toHaveLength(
            2,
          ),
        );
      } else {
        expect(request.mock.calls.filter(([method]) => method === "mcp.app.view")).toHaveLength(1);
        expect(view.querySelector(".error")?.textContent).toContain("gateway unavailable");
      }
    },
  );

  it("retires an initializing request synchronously before coalescing reconnect inputs", async () => {
    const response = deferred<unknown>();
    const request = createGatewayRequestMock(() => response.promise);
    const { gateway, publish } = createApplicationGateway();
    publish({
      ...gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected",
      hello: gatewayHelloForMethods(["mcp.app.view"]),
    });
    const { view, unmount } = mountView(
      { sessionKey: "agent:main:main", viewId: "view-initializing" },
      { gateway },
    );
    publish({ ...gateway.snapshot, hello: gatewayHelloForMethods(["mcp.app.view"]) });
    await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
    const signal = request.mock.calls[0]?.[2]?.signal;
    expect(signal?.aborted).toBe(false);
    publish({ ...gateway.snapshot, phase: "reconnecting" });
    expect(signal?.aborted).toBe(true);
    publish({ ...gateway.snapshot, phase: "connected" });
    view.sessionKey = "agent:other:main";
    view.viewId = "view-initializing-final";
    view.agentId = "other";
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]?.[1]).toEqual({
        sessionKey: "agent:other:main",
        viewId: "view-initializing-final",
        agentId: "other",
      });
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
    expect(frame.title).toBe("Lokalisierte App");
    expect(frame.style.height).toBe("900px");
    expect(view.querySelector("iframe")).toBe(frame);
    expect(request.mock.calls.filter(([method]) => method === "mcp.app.view")).toHaveLength(1);
  });
});
