import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { publishMcpAppContext, readMcpAppContexts } from "../lib/mcp-app-context.ts";
import { McpAppContextStrip } from "./mcp-app-context-strip.ts";

afterEach(() => document.body.replaceChildren());

describe("composer app context", () => {
  it("clears consumed context immediately and ignores an earlier refresh result", async () => {
    const state = {
      updateId: "revision-one",
      content: [
        { type: "text" as const, text: "selected hex bolt", _meta: { "openai/title": "Hex bolt" } },
      ],
    };
    const refresh = createDeferred<{ state: typeof state }>();
    const request = vi.fn(() => refresh.promise);
    const client = { request } as unknown as NonNullable<ApplicationGateway["snapshot"]["client"]>;
    const listeners = new Set<(event: GatewayEventFrame) => void>();
    publishMcpAppContext(client, {
      sessionKey: "agent:main:one",
      agentId: "main",
      viewId: "view-one",
      title: "Library",
      state,
    });
    const strip = new McpAppContextStrip();
    Reflect.set(strip, "context", {
      gateway: {
        snapshot: { client, phase: "connected" },
        connectionRevision: 1,
        subscribe: () => () => {},
        subscribeEvents: (listener: (event: GatewayEventFrame) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    strip.sessionKey = "agent:main:one";
    strip.agentId = "main";
    document.body.append(strip);
    await strip.updateComplete;
    expect(strip.textContent).toContain("Hex bolt");
    const emit = (payload: Record<string, unknown>) => {
      for (const listener of listeners) {
        listener({ type: "event", event: "mcp.app.hostContextChanged", payload });
      }
    };
    emit({ viewId: "view-one" });
    expect(request).toHaveBeenCalledTimes(1);
    emit({ viewId: "another-view", modelContext: null, updateId: "revision-one" });
    await strip.updateComplete;
    expect(strip.textContent).toContain("Hex bolt");
    emit({ viewId: "view-one", modelContext: null, updateId: "earlier-revision" });
    await strip.updateComplete;
    expect(strip.textContent).toContain("Hex bolt");
    emit({ viewId: "view-one", modelContext: null, updateId: "revision-one" });
    await strip.updateComplete;
    expect.soft(strip.textContent?.trim()).toBe("");
    refresh.resolve({ state });
    await refresh.promise;
    await strip.updateComplete;
    expect(strip.textContent?.trim()).toBe("");
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
    const strip = new McpAppContextStrip();
    Reflect.set(strip, "context", {
      gateway: {
        snapshot: { client, phase: "connected" },
        connectionRevision: 1,
        subscribe: () => () => {},
        subscribeEvents: () => () => {},
      },
    });
    strip.sessionKey = "agent:main:one";
    strip.agentId = "main";
    document.body.append(strip);
    await strip.updateComplete;
    expect(strip.textContent).toContain("Hex bolt");
    strip.querySelector<HTMLButtonElement>("button")!.click();
    await Promise.resolve();
    await strip.updateComplete;
    expect(request).toHaveBeenCalledWith("mcp.app.removeModelContext", {
      sessionKey: "agent:main:one",
      agentId: "main",
      viewId: "view-one",
      updateId: "revision-one",
      index: 0,
    });
    expect(readMcpAppContexts(client, strip.sessionKey, "main")).toEqual([]);
    expect(strip.textContent?.trim()).toBe("");
    expect(strip.querySelector('[role="alert"]')).toBeNull();
  });
});
