import { describe, expect, it, vi, type Mock } from "vitest";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import * as mcpContexts from "../lib/mcp-app-context.ts";
import { publishMcpAppContext, readMcpAppContexts } from "../lib/mcp-app-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  createApplicationGateway,
  createSolidApplicationContextProvider,
} from "../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { McpAppContextStrip } from "./mcp-app-context-strip.ts";

describe("composer app context", () => {
  it("clears consumed context immediately", () => {
    const state = {
      updateId: "revision-one",
      content: [
        { type: "text" as const, text: "selected hex bolt", _meta: { "openai/title": "Hex bolt" } },
      ],
    };
    const request = vi.fn(async () => ({ state }));
    const client = { request } as unknown as NonNullable<ApplicationGateway["snapshot"]["client"]>;
    const listeners = new Set<(event: GatewayEventFrame) => void>();
    publishMcpAppContext(client, {
      sessionKey: "agent:main:one",
      agentId: "main",
      viewId: "view-one",
      title: "Library",
      state,
    });
    const context = {
      gateway: {
        snapshot: { client, phase: "connected" },
        connectionRevision: 1,
        subscribe: () => () => {},
        subscribeEvents: (listener: (event: GatewayEventFrame) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    } as unknown as ApplicationContext;
    const { container: strip } = mountSolid(
      () => <McpAppContextStrip sessionKey="agent:main:one" agentId="main" />,
      { wrapper: createSolidApplicationContextProvider(context).wrapper },
    );
    flush();
    expect(strip.textContent).toContain("Hex bolt");
    const emit = (payload: Record<string, unknown>) => {
      for (const listener of listeners) {
        listener({ type: "event", event: "mcp.app.hostContextChanged", payload });
      }
    };
    emit({ viewId: "another-view", modelContext: null, updateId: "revision-one" });
    flush();
    expect(strip.textContent).toContain("Hex bolt");
    emit({ viewId: "view-one", modelContext: null, updateId: "earlier-revision" });
    flush();
    expect(strip.textContent).toContain("Hex bolt");
    emit({ viewId: "view-one", modelContext: null, updateId: "revision-one" });
    flush();
    expect.soft(strip.textContent?.trim()).toBe("");
    expect(strip.querySelector('[role="alert"]')).toBeNull();
  });
  it("clears an already-consumed item after an idempotent removal response", async () => {
    const request = vi.fn(async () => ({ state: null }));
    const client = { request } as unknown as NonNullable<ApplicationGateway["snapshot"]["client"]>;
    publishMcpAppContext(client, {
      sessionKey: "agent:main:one",
      agentId: "main",
      viewId: "view-one",
      title: "Library",
      state: {
        updateId: "revision-one",
        content: [
          { type: "text", text: "selected hex bolt", _meta: { "openai/title": "Hex bolt" } },
        ],
      },
    });
    const context = {
      gateway: {
        snapshot: { client, phase: "connected" },
        connectionRevision: 1,
        subscribe: () => () => {},
        subscribeEvents: () => () => {},
      },
    } as unknown as ApplicationContext;
    const { container: strip } = mountSolid(
      () => <McpAppContextStrip sessionKey="agent:main:one" agentId="main" />,
      { wrapper: createSolidApplicationContextProvider(context).wrapper },
    );
    flush();
    expect(strip.textContent).toContain("Hex bolt");
    strip.querySelector<HTMLButtonElement>("button")!.click();
    await waitForSolid(() => expect(strip.textContent?.trim()).toBe(""));
    expect(request).toHaveBeenCalledWith("mcp.app.removeModelContext", {
      sessionKey: "agent:main:one",
      agentId: "main",
      viewId: "view-one",
      updateId: "revision-one",
      index: 0,
    });
    expect(readMcpAppContexts(client, "agent:main:one", "main")).toEqual([]);
    expect(strip.textContent?.trim()).toBe("");
    expect(strip.querySelector('[role="alert"]')).toBeNull();
  });

  it("releases each context subscription when its client is replaced or the strip unmounts", () => {
    const subscribe = mcpContexts.subscribeMcpAppContexts;
    const releases: Mock<() => void>[] = [];
    const subscription = vi
      .spyOn(mcpContexts, "subscribeMcpAppContexts")
      .mockImplementation((client, listener) => {
        const release = vi.fn(subscribe(client, listener));
        releases.push(release);
        return release;
      });
    const application = createApplicationGateway();
    const firstClient = createTestGatewayClient(async () => ({}));
    const secondClient = createTestGatewayClient(async () => ({}));
    application.publish({
      ...application.gateway.snapshot,
      client: firstClient,
      phase: "connected",
    });
    // SAFETY: The strip reads only the Gateway; the provider supplies shared optional defaults.
    const context = { gateway: application.gateway } as ApplicationContext;
    const mounted = mountSolid(
      () => <McpAppContextStrip sessionKey="agent:main:one" agentId="main" />,
      { wrapper: createSolidApplicationContextProvider(context).wrapper },
    );
    try {
      flush();
      expect(subscription).toHaveBeenCalledTimes(1);
      expect(releases[0]).not.toHaveBeenCalled();
      application.publish({ ...application.gateway.snapshot, client: secondClient });
      flush();
      expect(subscription).toHaveBeenCalledTimes(2);
      expect(subscription).toHaveBeenLastCalledWith(secondClient, expect.any(Function));
      expect(releases[0]).toHaveBeenCalledOnce();
      expect(releases[1]).not.toHaveBeenCalled();
      mounted.unmount();
      expect(releases[1]).toHaveBeenCalledOnce();
      expect(releases[0]).toHaveBeenCalledOnce();
    } finally {
      mounted.unmount();
      subscription.mockRestore();
    }
  });
});
