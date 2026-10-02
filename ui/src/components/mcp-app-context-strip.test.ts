import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationGateway } from "../app/gateway.ts";
import { publishMcpAppContext, readMcpAppContexts } from "../lib/mcp-app-context.ts";
import { McpAppContextStrip } from "./mcp-app-context-strip.ts";

afterEach(() => document.body.replaceChildren());

describe("composer app context", () => {
  it("removes an individual app item with its exact update receipt", async () => {
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
  });
});
