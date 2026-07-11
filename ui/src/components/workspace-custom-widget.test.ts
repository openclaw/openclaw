import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceWidget, WidgetManifestView } from "../lib/workspace/types.ts";
import {
  attachWidgetBridge,
  loadWidgetManifestView,
  renderCustomWidgetHost,
  widgetAssetUrl,
  type CustomWidgetHostContext,
} from "./workspace-custom-widget.ts";

function widget(overrides: Partial<WorkspaceWidget> = {}): WorkspaceWidget {
  return {
    id: "w_custom",
    kind: "custom:revenue-chart",
    title: "Revenue Chart",
    grid: { x: 0, y: 0, w: 6, h: 4 },
    collapsed: false,
    bindings: { value: { source: "static", value: { revenue: 42 } } },
    ...overrides,
  };
}

function manifest(overrides?: Partial<WidgetManifestView>): WidgetManifestView {
  return {
    name: "revenue-chart",
    entrypoint: "index.html",
    bindings: { value: { source: "static", value: null } },
    capabilities: ["data:read"],
    ...overrides,
  };
}

function host(overrides?: Partial<CustomWidgetHostContext>): CustomWidgetHostContext {
  return { client: null, basePath: "", sessionKey: "main", ...overrides };
}

function renderToContainer(template: unknown): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(template as never, container);
  return container;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("widgetAssetUrl", () => {
  it("builds a URL under the plugin route with encoded segments", () => {
    expect(widgetAssetUrl("", "revenue-chart", "index.html")).toBe(
      "/plugins/workspaces/widgets/revenue-chart/index.html",
    );
    expect(widgetAssetUrl("/base", "a b", "assets/app.js")).toBe(
      "/base/plugins/workspaces/widgets/a%20b/assets/app.js",
    );
  });
});

describe("loadWidgetManifestView", () => {
  it("shapes a fetched manifest into the bridge read model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          entrypoint: "index.html",
          bindings: [{ id: "value", source: "static", value: 1 }],
          capabilities: ["data:read", "prompt:send"],
        }),
      })),
    );
    const view = await loadWidgetManifestView("", "revenue-chart");
    expect(view).toEqual({
      name: "revenue-chart",
      entrypoint: "index.html",
      bindings: { value: { source: "static", value: 1 } },
      capabilities: ["data:read", "prompt:send"],
    });
  });

  it("returns null on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    expect(await loadWidgetManifestView("", "revenue-chart")).toBeNull();
  });

  it("represents schema-valid binding ids without prototype collisions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          entrypoint: "index.html",
          bindings: [{ id: "__proto__", source: "static", value: 1 }],
          capabilities: ["data:read"],
        }),
      })),
    );

    const view = await loadWidgetManifestView("", "revenue-chart");
    expect(Object.keys(view?.bindings ?? {})).toEqual(["__proto__"]);
    expect(Reflect.get(view?.bindings ?? {}, "__proto__")).toEqual({
      source: "static",
      value: 1,
    });
  });
});

describe("renderCustomWidgetHost DOM", () => {
  it("renders an iframe whose sandbox is exactly allow-scripts", () => {
    const container = renderToContainer(
      renderCustomWidgetHost({ widget: widget(), manifest: manifest(), context: host() }),
    );
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    // The sandbox attribute is a CONSTANT — exactly "allow-scripts", nothing else.
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
    const tokens = (iframe?.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
    expect(tokens).toEqual(["allow-scripts"]);
    expect(tokens).not.toContain("allow-same-origin");
    expect(tokens).not.toContain("allow-forms");
    expect(tokens).not.toContain("allow-popups");
    expect(tokens).not.toContain("allow-top-navigation");
  });

  it("sets referrerpolicy=no-referrer and the served src", () => {
    const container = renderToContainer(
      renderCustomWidgetHost({
        widget: widget(),
        manifest: manifest(),
        context: host({ basePath: "/gw" }),
      }),
    );
    const iframe = container.querySelector("iframe");
    expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe?.getAttribute("src")).toBe(
      "/gw/plugins/workspaces/widgets/revenue-chart/index.html",
    );
  });
});

describe("attachWidgetBridge accept filter (identity, not origin)", () => {
  it("drops a message from a foreign window and accepts one from the iframe window", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const posts: unknown[] = [];
    // Capture posts by stubbing the child's postMessage.
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage = ((message: unknown) => posts.push(message)) as never;
    }
    const detach = attachWidgetBridge({
      iframe,
      widget: widget(),
      manifest: manifest(),
      context: host(),
    });

    // A message whose source is NOT the iframe's contentWindow is ignored.
    const foreign = document.createElement("iframe");
    document.body.appendChild(foreign);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "workspace:getData", requestId: "r1", bindingId: "value" },
        source: foreign.contentWindow,
      }),
    );
    // A message from the real iframe window IS handled (static binding → data post).
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "workspace:getData", requestId: "r2", bindingId: "value" },
        source: iframe.contentWindow,
      }),
    );
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: "workspace:data", requestId: "r2", bindingId: "value" });
    detach();
  });

  it("sends an approved prompt with a gateway idempotency key", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const request = vi.fn(async () => ({ runId: "run-1", status: "started" }));
    const detach = attachWidgetBridge({
      iframe,
      widget: widget(),
      manifest: manifest({ name: "prompt-send-test", capabilities: ["prompt:send"] }),
      context: host({ client: { request } as never, confirmPrompt: () => true }),
    });

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          v: 1,
          type: "workspace:sendPrompt",
          requestId: "r1",
          text: "Summarize this workspace",
        },
        source: iframe.contentWindow,
      }),
    );

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("chat.send", {
      sessionKey: "main",
      message: "Summarize this workspace",
      deliver: false,
      idempotencyKey: expect.any(String),
    });
    expect((request.mock.calls[0]?.[1] as { idempotencyKey?: string }).idempotencyKey).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    detach();
  });

  it("removes its window listener on detach", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const posts: unknown[] = [];
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage = ((message: unknown) => posts.push(message)) as never;
    }
    const detach = attachWidgetBridge({
      iframe,
      widget: widget(),
      manifest: manifest(),
      context: host(),
    });
    detach();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "workspace:getData", requestId: "r1", bindingId: "value" },
        source: iframe.contentWindow,
      }),
    );
    // Give any (incorrectly still-attached) async handler a tick.
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(posts).toHaveLength(0);
  });
});

describe("attachWidgetBridge privileged-data boundary", () => {
  it("denies an rpc binding without calling the gateway", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const posts: unknown[] = [];
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage = ((message: unknown) => posts.push(message)) as never;
    }
    const request = vi.fn(async () => ({ leaked: true }));
    const detach = attachWidgetBridge({
      iframe,
      widget: widget({ bindings: { value: { source: "rpc", method: "sessions.delete" } } }),
      manifest: manifest({
        bindings: { value: { source: "rpc", method: "sessions.delete" } },
      }),
      context: host({ client: { request } as never }),
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "workspace:getData", requestId: "r1", bindingId: "value" },
        source: iframe.contentWindow,
      }),
    );
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0]).toMatchObject({
      type: "workspace:error",
      code: "binding_denied",
      requestId: "r1",
    });
    expect(request).not.toHaveBeenCalled();
    detach();
  });

  it("denies an allowlisted rpc binding without calling the gateway", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const posts: unknown[] = [];
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage = ((message: unknown) => posts.push(message)) as never;
    }
    const request = vi.fn(async () => ({ sessions: [] }));
    const detach = attachWidgetBridge({
      iframe,
      widget: widget({ bindings: { value: { source: "rpc", method: "sessions.list" } } }),
      manifest: manifest({ bindings: { value: { source: "rpc", method: "sessions.list" } } }),
      context: host({ client: { request } as never }),
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "workspace:getData", requestId: "r1", bindingId: "value" },
        source: iframe.contentWindow,
      }),
    );
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0]).toMatchObject({
      type: "workspace:error",
      code: "binding_denied",
      requestId: "r1",
    });
    expect(request).not.toHaveBeenCalled();
    detach();
  });

  it("denies a file binding without reading through the gateway", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const posts: unknown[] = [];
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage = ((message: unknown) => posts.push(message)) as never;
    }
    const request = vi.fn(async () => ({ secret: true }));
    const detach = attachWidgetBridge({
      iframe,
      widget: widget({ bindings: { value: { source: "file", path: "private.json" } } }),
      manifest: manifest({ bindings: { value: { source: "file", path: "private.json" } } }),
      context: host({ client: { request } as never }),
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "workspace:getData", requestId: "r1", bindingId: "value" },
        source: iframe.contentWindow,
      }),
    );
    await vi.waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts[0]).toMatchObject({
      type: "workspace:error",
      code: "binding_denied",
      requestId: "r1",
    });
    expect(request).not.toHaveBeenCalled();
    detach();
  });

  it("refuses a manifest with no entrypoint", async () => {
    // The approval gate hashes the declared entrypoint; without one there is no
    // approved file to load, so nothing should mount.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ bindings: [], capabilities: [] }),
      })),
    );

    expect(await loadWidgetManifestView("", "revenue-chart")).toBeNull();
  });
});
