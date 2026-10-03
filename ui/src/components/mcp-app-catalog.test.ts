import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpAppDiscoverResult } from "../../../src/shared/mcp-app-extensions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { McpAppCatalog } from "./mcp-app-catalog.ts";
import { MCP_APP_OPEN_EVENT, type McpAppOpenDetail } from "./mcp-app-launch.ts";

afterEach(() => document.body.replaceChildren());
const result: McpAppDiscoverResult = {
  servers: [
    {
      serverName: "parts",
      label: "Parts plugin",
      entrypoints: [
        {
          title: "Parts tray",
          toolName: "tray",
          resourceUri: "ui://parts/tray",
          entrypoint: { type: "thread" },
        },
        {
          title: "Library",
          toolName: "library",
          resourceUri: "ui://parts/library",
          entrypoint: { type: "global" },
        },
      ],
    },
  ],
};

describe("app launch catalog", () => {
  it.each(["sidebar", "thread", "file"] as const)(
    "hides unsupported %s controls after empty discovery",
    async (surface) => {
      const read = createDeferred<McpAppDiscoverResult>();
      const element = new McpAppCatalog();
      element.surface = surface;
      element.sessionKey = "agent:main:empty";
      Reflect.set(element, "context", {
        gateway: {
          snapshot: {
            client: { request: () => read.promise },
            phase: "connected",
            hello: { features: { methods: ["mcp.app.discover"] } },
          },
          connectionRevision: 1,
          subscribe: () => () => {},
          subscribeEvents: () => () => {},
        },
        agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
      });
      document.body.append(element);
      await element.updateComplete;
      read.resolve({ servers: [], onboarding: [] });
      await read.promise;
      await element.updateComplete;
      expect(element.querySelector("button")).toBeNull();
      expect(element.querySelector('[role="alert"]')).toBeNull();
    },
  );
  it("ignores discovery from a replaced conversation", async () => {
    const first = createDeferred<McpAppDiscoverResult>();
    const second = createDeferred<McpAppDiscoverResult>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const element = new McpAppCatalog();
    Reflect.set(element, "context", {
      gateway: {
        snapshot: {
          client: { request },
          phase: "connected",
          hello: { features: { methods: ["mcp.app.discover"] } },
        },
        connectionRevision: 1,
        subscribe: () => () => {},
        subscribeEvents: () => () => {},
      },
      agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
    });
    element.sessionKey = "agent:main:one";
    document.body.append(element);
    await element.updateComplete;
    element.sessionKey = "agent:main:two";
    await element.updateComplete;
    second.resolve({ servers: [] });
    await second.promise;
    await element.updateComplete;
    first.resolve(result);
    await first.promise;
    await element.updateComplete;
    expect(element.textContent).not.toContain("Library");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("launches the selected thread app through its conversation owner without sending a prompt", async () => {
    const read = createDeferred<McpAppDiscoverResult>();
    const request = vi.fn(() => read.promise);
    const client = { request };
    const gateway = {
      snapshot: {
        client,
        phase: "connected",
        sessionKey: "agent:main:one",
        hello: { features: { methods: ["mcp.app.discover"] } },
      },
      connectionRevision: 1,
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
    };
    const element = new McpAppCatalog();
    Reflect.set(element, "context", {
      gateway,
      agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
    });
    element.surface = "thread";
    element.sessionKey = "agent:main:one";
    element.agentId = "main";
    document.body.append(element);
    await element.updateComplete;
    read.resolve(result);
    await read.promise;
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>("button")!.click();
    await element.updateComplete;
    const launch = vi.fn((event: Event) => event.preventDefault());
    element.addEventListener(MCP_APP_OPEN_EVENT, launch);
    const button = [...element.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.textContent?.includes("Parts tray"),
    );
    expect(button).toBeDefined();
    button!.click();
    expect((launch.mock.calls[0]![0] as CustomEvent<McpAppOpenDetail>).detail).toMatchObject({
      sessionKey: "agent:main:one",
      agentId: "main",
      serverName: "parts",
      owner: client,
      entrypoint: { toolName: "tray" },
    });
    expect(request.mock.calls).toEqual([
      ["mcp.app.discover", { sessionKey: "agent:main:one", agentId: "main" }],
    ]);
  });
});
