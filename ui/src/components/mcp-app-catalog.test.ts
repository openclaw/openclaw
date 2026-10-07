import type { LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpAppDiscoverResult } from "../../../src/shared/mcp-app-extensions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import "../pages/apps/apps-page.ts";
import { McpAppCatalog } from "./mcp-app-catalog.ts";
import { MCP_APP_OPEN_EVENT, type McpAppOpenDetail } from "./mcp-app-launch.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
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
  it.each([false, true])(
    "prepares global discovery only for a missing session (exists: %s)",
    async (exists) => {
      let admitted = exists;
      const createResult = vi.fn(async () => {
        admitted = true;
        return { key: "agent:main:main" };
      });
      const request = vi.fn(async () => {
        if (!admitted) {
          throw new Error("The requested session is unavailable; open an existing session first.");
        }
        return result;
      });
      const configChanged = new Set<(event: { event: string }) => void>();
      const describeSession = vi.fn(async () => ({
        session: exists ? { key: "agent:main:main" } : null,
      }));
      const element = document.createElement("openclaw-apps-page") as LitElement;
      const provider = createApplicationContextProvider({
        gateway: {
          snapshot: {
            sessionKey: "agent:main:main",
            client: { request },
            phase: "connected",
            hello: { features: { methods: ["mcp.app.discover"] } },
          },
          connectionRevision: 1,
          connection: { gatewayUrl: "ws://gateway.example.test" },
          subscribe: () => () => {},
          subscribeEvents: (listener: (event: { event: string }) => void) => {
            configChanged.add(listener);
            return () => configChanged.delete(listener);
          },
        },
        sessions: {
          createResult,
          state: { error: null },
          describe: describeSession,
        },
        agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
      } as unknown as ApplicationContext);
      provider.append(element);
      document.body.append(provider);
      await element.updateComplete;
      const catalog = element.querySelector<McpAppCatalog>("openclaw-mcp-app-catalog")!;
      await catalog.updateComplete;
      await catalog.updateComplete;
      await catalog.updateComplete;
      if (exists) {
        expect(createResult).not.toHaveBeenCalled();
      } else {
        expect(createResult).toHaveBeenCalledExactlyOnceWith(
          { key: "agent:main:main", agentId: "main" },
          { reconciliation: "background" },
        );
      }
      expect(request).toHaveBeenCalledWith("mcp.app.discover", {
        sessionKey: "agent:main:main",
        agentId: "main",
      });
      await element.updateComplete;
      expect(element.textContent).toContain("Library");
      expect(element.querySelector('[role="alert"]')).toBeNull();
      for (const listener of configChanged) {
        listener({ event: "config.changed" });
      }
      await catalog.updateComplete;
      await element.updateComplete;
      expect(describeSession).toHaveBeenCalledExactlyOnceWith({
        key: "agent:main:main",
        agentId: "main",
      });
      expect(createResult).toHaveBeenCalledTimes(exists ? 0 : 1);
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
  it("onboards an app without crypto.randomUUID on insecure origins", async () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const read = createDeferred<McpAppDiscoverResult>();
    const request = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue({});
    const navigate = vi.fn();
    const element = new McpAppCatalog();
    element.sessionKey = "agent:main:one";
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
      agents: { state: { agentsList: null } },
      sessions: {
        state: { result: null },
        describe: async () => ({ session: { key: "agent:main:one" } }),
      },
      basePath: "",
      navigate,
    });
    document.body.append(element);
    await element.updateComplete;
    read.resolve({ servers: [], onboarding: [{ pluginId: "parts", title: "Parts plugin" }] });
    await read.promise;
    await element.updateComplete;
    const button = [...element.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.textContent?.includes("Parts plugin"),
    );
    expect(button).toBeDefined();
    button!.click();
    await element.updateComplete;
    expect(request).toHaveBeenCalledWith("mcp.app.onboard", {
      sessionKey: "agent:main:one",
      agentId: "main",
      pluginId: "parts",
      idempotencyKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    });
    expect(navigate).toHaveBeenCalledWith("chat", expect.any(Object));
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });
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
    element.surface = "sidebar";
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
