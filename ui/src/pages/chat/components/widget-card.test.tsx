/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context-types.ts";
import type { ApplicationGatewaySnapshot } from "../../../app/gateway.ts";
import { WIDGET_PROMPT_EVENT } from "../../../components/mcp-app-security.ts";
import { ValueSignal } from "../../../lib/board/provider-signals.ts";
import { mcpAppWidgetNameForViewId, type BoardProvider } from "../../../lib/board/provider.ts";
import { bumpCanvasWidgetFrameConnectionGeneration } from "../../../lib/chat/canvas-widget-frame-generation.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import * as toast from "../../../lib/toast.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext } from "../../../test-helpers/app-sidebar.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../../test-helpers/application-context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { SidebarPanel } from "./chat-sidebar-content.tsx";
import { ToolPreview } from "./widget-card-view.tsx";
import { ToolPreview as DeferredToolPreview } from "./widget-card.ts";
import * as widgetExport from "./widget-export.ts";
import { WidgetPinButton } from "./widget-pin-button.tsx";

const canvasPreview = {
  kind: "canvas",
  surface: "assistant_message",
  render: "url",
} as const;
const sessionKey = "agent:main:main";
const actionButton = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>('button[aria-label="Widget actions"]');
const pinButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[data-pin-widget]");
const menuLabels = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('[role="menuitem"]'), (item) => item.textContent?.trim());
const widgetPorts: MessagePort[] = [];
type PreviewState = {
  preview: Parameters<typeof ToolPreview>[0]["preview"];
  options: Parameters<typeof ToolPreview>[0]["options"];
};
const widgets = new Map<
  HTMLElement,
  { update: (state: PreviewState) => void; unmount: () => void }
>();

function documentPreview(
  id: string,
  overrides: Partial<Extract<PreviewState["preview"], { kind: "canvas" }>> = {},
) {
  return {
    ...canvasPreview,
    url: `/__openclaw__/canvas/documents/${id}/index.html`,
    sandbox: "scripts" as const,
    ...overrides,
  };
}

function connectedHost() {
  return document.body.appendChild(document.createElement("div"));
}

function showCapability(preview: PreviewState["preview"], host: HTMLElement, capability: string) {
  return mountWidget(
    preview,
    { canvasPluginSurfaceUrl: `https://canvas.test/__openclaw__/cap/${capability}` },
    host,
  );
}

function boardProvider(overrides: Partial<BoardProvider> = {}) {
  const pinnedWidgets: { name: string }[] = [];
  const snapshot = new ValueSignal({ widgets: pinnedWidgets });
  const provider = {
    sessionKey: "agent:main:main",
    canPinWidgets: true,
    pinWidget: vi.fn(async () => undefined),
    snapshot$: snapshot,
    ...overrides,
  } as unknown as BoardProvider;
  return { provider, snapshot };
}

function unmountWidget(host: HTMLElement) {
  widgets.get(host)?.unmount();
  widgets.delete(host);
}

function mountWidget(
  preview: PreviewState["preview"],
  options?: PreviewState["options"],
  host: HTMLElement = document.createElement("div"),
) {
  const state = { preview, options };
  const mounted = widgets.get(host);
  if (mounted) {
    mounted.update(state);
  } else {
    let update!: (state: PreviewState) => void;
    const root = mountSolid(
      () => {
        const [current, setCurrent] = createSignal(state);
        update = setCurrent;
        return <ToolPreview {...current()} surface="chat_message" />;
      },
      { container: host },
    );
    widgets.set(host, { update, unmount: root.unmount });
  }
  flush();
  return host;
}

function initializeWidgetFrame(frame: HTMLIFrameElement, loaded = false) {
  const channel = new MessageChannel();
  widgetPorts.push(channel.port1, channel.port2);
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "openclaw:widget-prompt-offer" },
      origin: "null",
      source: frame.contentWindow,
      ports: [channel.port2],
    }),
  );
  if (!loaded) {
    frame.dispatchEvent(new Event("load"));
  }
  return channel;
}

async function openActions(host: HTMLElement) {
  actionButton(host)!.click();
  await waitForSolid(() =>
    expect(host.querySelector('[role="menu"]')?.matches(":popover-open")).toBe(true),
  );
}

async function downloadWidget(host: HTMLElement) {
  await openActions(host);
  host.querySelector<HTMLButtonElement>('[role="menuitem"][value="download"]')!.click();
}

afterEach(async () => {
  // Rendering starts lazy element imports that must finish before this environment retires.
  await vi.dynamicImportSettled();
  for (const port of widgetPorts.splice(0)) {
    port.close();
  }
  for (const host of widgets.keys()) {
    unmountWidget(host);
  }
  document.body.replaceChildren();
  delete document.documentElement.dataset.themeMode;
});

describe("widget-card", () => {
  it.each(["transcript", "strict transcript", "sidebar"] as const)(
    "retains the %s document through a blip and retires it on identity or access change",
    async (surface) => {
      // SAFETY: Raw frames only use the client as presentation identity; they issue no RPCs.
      const client = { request: vi.fn() } as unknown as ApplicationGatewaySnapshot["client"];
      const hello: ApplicationGatewaySnapshot["hello"] = {
        type: "hello-ok",
        protocol: 1,
        auth: { role: "operator", scopes: ["operator.read"], recoveryScope: "reader-a" },
      };
      const fixture = createApplicationGateway();
      fixture.publish({
        ...fixture.gateway.snapshot,
        client,
        hello,
        phase: "connected",
        canvasPluginSurfaceUrl: "https://canvas.test/__openclaw__/cap/one",
        sessionKey: "agent:main:test",
      });
      // SAFETY: These leaf renderers consume only the Gateway capability.
      const provider = createSolidApplicationContextProvider({
        gateway: fixture.gateway,
      } as ApplicationContext);
      const entryUrl = "/__openclaw__/canvas/documents/cv_retained/index.html";
      const root = mountSolid(
        () => {
          const gateway = projectGateway(fixture.gateway);
          return surface !== "sidebar" ? (
            <DeferredToolPreview
              preview={documentPreview("cv_retained", {
                sandbox: surface === "strict transcript" ? "strict" : "scripts",
              })}
              surface="chat_message"
              options={{ canvasPluginSurfaceUrl: gateway.read().snapshot.canvasPluginSurfaceUrl }}
            />
          ) : (
            <SidebarPanel
              content={{ kind: "canvas", docId: "cv_retained", entryUrl }}
              showingRawText={false}
              error={null}
              onRetry={() => {}}
              onClose={() => {}}
              onViewRawText={() => {}}
              onClick={() => {}}
              onKeydown={() => {}}
              attachmentRuntime={{}}
              canvasPluginSurfaceUrl={gateway.read().snapshot.canvasPluginSurfaceUrl}
            />
          );
        },
        { wrapper: provider.wrapper },
      );
      const frame = () => root.container.querySelector<HTMLIFrameElement>("iframe");
      await vi.dynamicImportSettled();
      await waitForSolid(() => expect(frame()).not.toBeNull());
      const original = frame()!;
      const src = original.getAttribute("src");
      original.contentDocument!.open();
      original.contentDocument!.write('<input value="draft">');
      original.contentDocument!.close();
      const draft = original.contentDocument!.querySelector("input")!;
      draft.value = "unsaved work";
      original.dispatchEvent(new Event("load"));
      const prompts = vi.fn();
      root.container.addEventListener(WIDGET_PROMPT_EVENT, prompts);
      let expectPrompts: (count: number) => Promise<void> = async () => {};
      if (surface === "transcript") {
        const channel = initializeWidgetFrame(original, true);
        original.checkVisibility = () => true;
        original.focus();
        expectPrompts = async (count) => {
          await new Promise<void>((resolve) => {
            channel.port2.addEventListener("message", () => resolve(), { once: true });
            channel.port1.postMessage({ type: "openclaw:widget-prompt", prompt: "Keep working" });
          });
          expect(prompts).toHaveBeenCalledTimes(count);
        };
      }
      await expectPrompts(1);
      const publish = (patch: Partial<ApplicationGatewaySnapshot>) => {
        bumpCanvasWidgetFrameConnectionGeneration();
        fixture.publish({ ...fixture.gateway.snapshot, ...patch });
        flush();
      };
      publish({ phase: "reconnecting", hello: null, canvasPluginSurfaceUrl: null });
      expect(frame()).toBe(original);
      expect(original.getAttribute("src")).toBe(src);
      await expectPrompts(1);
      publish({
        phase: "connected",
        hello,
        canvasPluginSurfaceUrl: "https://canvas.test/__openclaw__/cap/two",
      });
      expect(frame()).toBe(original);
      expect(original.getAttribute("src")).toBe(src);
      expect(original.contentDocument!.querySelector("input")).toBe(draft);
      expect(draft.value).toBe("unsaved work");
      await expectPrompts(2);
      publish({ client: { request: vi.fn() } as unknown as ApplicationGatewaySnapshot["client"] });
      expect(frame()).not.toBe(original);
      publish({ hello: { ...hello, auth: { role: "operator", scopes: [] } } });
      expect(frame()).toBeNull();
    },
  );
  it("retains video playback through title changes after the player loads", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const preview = {
      ...canvasPreview,
      title: "Synthetic video",
      url: "https://youtu.be/AbCdEfGhI_1",
    };
    const host = mountWidget(preview, { sessionKey: "agent:main:video" });
    await waitForSolid(() =>
      expect(host.querySelector('button[aria-label="Play Synthetic video"]')).not.toBeNull(),
    );
    host.querySelector<HTMLButtonElement>('button[aria-label="Play Synthetic video"]')!.click();
    flush();
    const frame = host.querySelector("iframe");
    expect(frame).not.toBeNull();

    mountWidget(
      { ...preview, title: "Updated video title" },
      { sessionKey: "agent:main:video" },
      host,
    );

    expect(host.querySelector("iframe")).toBe(frame);
    expect(frame?.title).toBe("YouTube player: Updated video title");
  });

  it("exports the current raw frame after replacing its URL", async () => {
    const exportImage = vi.spyOn(widgetExport, "exportWidget").mockResolvedValue("png");
    onTestFinished(() => exportImage.mockRestore());
    const host = connectedHost();
    const preview = documentPreview("cv_export_one", { title: "Raw widget" });
    mountWidget(preview, undefined, host);
    const first = host.querySelector("iframe")!;
    await downloadWidget(host);
    expect(exportImage).toHaveBeenLastCalledWith("download", first, "Raw widget", {
      documentHtml: undefined,
    });

    mountWidget(
      { ...preview, url: "/__openclaw__/canvas/documents/cv_export_two/index.html" },
      undefined,
      host,
    );
    const current = host.querySelector("iframe")!;
    expect(current).not.toBe(first);
    expect(first.isConnected).toBe(false);
    await downloadWidget(host);
    expect(exportImage).toHaveBeenLastCalledWith("download", current, "Raw widget", {
      documentHtml: undefined,
    });
    expect(exportImage).toHaveBeenCalledTimes(2);
  });

  it("reads the managed export frame and document when the action is selected", async () => {
    const exportImage = vi.spyOn(widgetExport, "exportWidget").mockResolvedValue("png");
    onTestFinished(() => exportImage.mockRestore());
    const { gateway } = createApplicationGateway();
    const sessions = createTestSessionCapability(gateway);
    const provider = createApplicationContextProvider(createContext(gateway, sessions));
    const host = document.createElement("div");
    provider.append(host);
    document.body.append(provider);
    onTestFinished(() => {
      unmountWidget(host);
      sessions.dispose();
      disposeSidebarContextLifecycles();
    });
    mountWidget(
      documentPreview("cv_export_managed", {
        title: "Managed widget",
        viewId: "cv_export_managed",
      }),
      undefined,
      host,
    );
    await vi.dynamicImportSettled();
    const widget = host.querySelector("openclaw-canvas-widget-view")!;
    const previewFrame = document.createElement("iframe");
    const documentHtml = "<!doctype html><title>Managed export</title>";
    Object.defineProperties(widget, {
      previewFrame: { configurable: true, get: () => previewFrame },
      documentHtml: { configurable: true, get: () => documentHtml },
    });
    // The owner can expose a frame after adoption without placing it beneath the menu.
    document.body.append(previewFrame);
    await downloadWidget(host);
    expect(exportImage).toHaveBeenCalledExactlyOnceWith(
      "download",
      previewFrame,
      "Managed widget",
      { documentHtml },
    );
  });

  it("keeps theme delivery attached to a retained mounted frame", async () => {
    const host = connectedHost();
    mountWidget(
      documentPreview("unused", { url: "https://example.test/theme-widget" }),
      { allowExternalEmbedUrls: true },
      host,
    );
    const frame = host.querySelector("iframe")!;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    frame.dispatchEvent(new Event("load"));
    frame.className = "";
    post.mockClear();

    document.documentElement.dataset.themeMode = "light";
    await Promise.resolve();
    expect(host.querySelector("iframe")).toBe(frame);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "openclaw:widget-theme", mode: "light" }),
      "*",
    );
  });

  it.each([true, false])("rotates capabilities with an initialized=%s frame", (initialized) => {
    const preview = documentPreview("cv_surface_lease_one");
    const host = connectedHost();
    showCapability(preview, host, "one");
    const original = host.querySelector("iframe")!;
    const originalSrc = original.getAttribute("src");
    expect(originalSrc).toContain("/__openclaw__/cap/one/");
    if (initialized) {
      initializeWidgetFrame(original);
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "openclaw:widget-size", height: 48 },
          source: original.contentWindow,
        }),
      );
      expect(original.style.height).toBe("48px");
      showCapability(preview, host, "one");
      expect(original.getAttribute("style")).toContain("48px");
    } else {
      // HTTP error documents dispatch load without offering a widget bridge.
      original.dispatchEvent(new Event("load"));
    }
    showCapability(preview, host, "two");
    const current = host.querySelector("iframe")!;
    expect(current === original).toBe(initialized);
    if (initialized) {
      expect(current.getAttribute("src")).toBe(originalSrc);
      expect(current.getAttribute("style")).toContain("48px");
    } else {
      expect(current.getAttribute("src")).toContain("/__openclaw__/cap/two/");
      initializeWidgetFrame(current);
    }
    showCapability(preview, host, "three");
    expect(host.querySelector("iframe")).toBe(current);
    expect(current.getAttribute("src")).toContain(
      `/__openclaw__/cap/${initialized ? "one" : "two"}/`,
    );

    unmountWidget(host);
    showCapability(preview, host, "two");
    const remountedFrame = host.querySelector("iframe");
    expect(remountedFrame).not.toBe(current);
    expect(remountedFrame?.getAttribute("src")).toContain("/__openclaw__/cap/two/");
    initializeWidgetFrame(remountedFrame!);

    bumpCanvasWidgetFrameConnectionGeneration();
    showCapability(preview, host, "three");
    expect(host.querySelector("iframe")).toBe(remountedFrame);
  });

  it("unloads an external frame when external embeds become disallowed", () => {
    const preview = documentPreview("external-policy", {
      viewId: "external-policy",
      url: "https://example.test/widget",
    });
    const host = mountWidget(preview, { allowExternalEmbedUrls: true });
    const allowedFrame = host.querySelector("iframe");
    expect(allowedFrame?.getAttribute("src")).toBe("https://example.test/widget");

    mountWidget(preview, { allowExternalEmbedUrls: false }, host);
    expect(host.querySelector("iframe")).not.toBe(allowedFrame);
    expect(host.querySelector("iframe")?.hasAttribute("src")).toBe(false);
  });

  it("dispatches canvas HTML and MCP App content and ignores unknown kinds", async () => {
    const canvas = mountWidget(
      documentPreview("cv_dispatch", { preferredHeight: 320, sandbox: undefined }),
    );
    expect(canvas.querySelector("iframe.chat-tool-card__preview-frame")).not.toBeNull();
    expect(canvas.querySelector("mcp-app-view")).toBeNull();
    expect(actionButton(canvas)).not.toBeNull();
    document.body.append(canvas);
    await openActions(canvas);
    expect(menuLabels(canvas)).toEqual(["Copy as image", "Download as image"]);

    const appPreview = {
      ...canvasPreview,
      title: "App",
      preferredHeight: 480,
      mcpApp: { viewId: "view-dispatch" },
    };
    const app = mountWidget(appPreview, { sessionKey });
    await vi.dynamicImportSettled();
    expect(customElements.get("mcp-app-view")).toBeDefined();
    expect(app.querySelector("mcp-app-view")).not.toBeNull();
    expect(app.querySelector(".chat-tool-card__preview")?.getAttribute("data-content-kind")).toBe(
      "mcp-app",
    );
    expect(app.querySelector("iframe")).toBeNull();
    expect(actionButton(app)).toBeNull();

    mountWidget(appPreview, { sessionKey, rawText: "raw app payload" }, app);
    expect(actionButton(app)).not.toBeNull();

    const external = mountWidget(
      {
        ...canvasPreview,
        url: "https://example.test/widget",
      },
      { allowExternalEmbedUrls: true, rawText: "external raw payload" },
    );
    document.body.append(external);
    await openActions(external);
    expect(menuLabels(external)).toEqual(["Show raw details"]);

    const unknown = mountWidget({ kind: "unknown" } as never);
    expect(unknown.childElementCount).toBe(0);
  });

  it("pins default-script Canvas HTML through the board provider", async () => {
    const pinWidget = vi.fn(async () => undefined);
    const { provider, snapshot } = boardProvider({ pinWidget });
    const canvas = mountWidget(
      documentPreview("cv_release", {
        title: "Release status",
        viewId: " cv_release ",
        sandbox: undefined,
      }),
      { boardProvider: provider },
    );
    expect(canvas.querySelector("openclaw-canvas-widget-view")).not.toBeNull();
    pinButton(canvas)?.click();
    await vi.waitFor(() => {
      expect(pinWidget).toHaveBeenCalledWith({
        docId: "cv_release",
        name: "canvas-cv_release",
        title: "Release status",
      });
    });

    snapshot.value = { widgets: [{ name: "release-status" }] };
    const pinned = mountWidget(
      documentPreview("cv_release", { viewId: "cv_release", boardWidgetName: "release-status" }),
      { boardProvider: provider },
    );
    expect(pinButton(pinned)).toMatchObject({ disabled: true, ariaLabel: "Pinned" });
  });

  it("retains pin feedback through title updates and reconciles retries with the board", async () => {
    const first = Promise.withResolvers<void>();
    const retry = Promise.withResolvers<void>();
    const pinWidget = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    const { provider, snapshot } = boardProvider({ pinWidget });
    const preview = documentPreview("cv_pin_feedback", {
      viewId: "cv_pin_feedback",
      title: "Release status",
    });
    const host = mountWidget(preview, { boardProvider: provider });
    const button = pinButton(host)!;
    button.click();
    button.click();
    await waitForSolid(() =>
      expect(button).toMatchObject({ disabled: true, ariaLabel: "Pinning…" }),
    );
    expect(pinWidget).toHaveBeenCalledTimes(1);

    mountWidget({ ...preview, title: "Updated release status" }, { boardProvider: provider }, host);
    expect(pinButton(host)).toBe(button);
    expect(button).toMatchObject({ disabled: true, ariaLabel: "Pinning…", title: "Pinning…" });

    first.reject(new Error("Synthetic pin failure"));
    await waitForSolid(() =>
      expect(button).toMatchObject({
        disabled: false,
        ariaLabel: "Pin to dashboard",
        title: "Could not pin to dashboard. Try again.",
      }),
    );
    mountWidget({ ...preview, title: "Retained failure" }, { boardProvider: provider }, host);
    expect(pinButton(host)).toBe(button);
    expect(button.title).toBe("Could not pin to dashboard. Try again.");
    button.click();
    await waitForSolid(() =>
      expect(button).toMatchObject({ disabled: true, ariaLabel: "Pinning…" }),
    );
    expect(pinWidget).toHaveBeenLastCalledWith({
      docId: "cv_pin_feedback",
      name: "canvas-cv_pin_feedback",
      title: "Retained failure",
    });
    snapshot.set({ widgets: [{ name: "canvas-cv_pin_feedback" }] });
    retry.resolve();
    await waitForSolid(() => expect(button).toMatchObject({ disabled: true, ariaLabel: "Pinned" }));
    expect(button.hasAttribute("data-pinned")).toBe(true);

    snapshot.set({ widgets: [] });
    await waitForSolid(() =>
      expect(button).toMatchObject({ disabled: false, ariaLabel: "Pin to dashboard" }),
    );
    expect(button.hasAttribute("data-pinned")).toBe(false);
  });

  it("announces a connected pin failure once across title updates", async () => {
    const showToast = vi.spyOn(toast, "showToast").mockImplementation(() => true);
    onTestFinished(() => showToast.mockRestore());
    const completion = Promise.withResolvers<void>();
    const { provider } = boardProvider({ pinWidget: () => completion.promise });
    let setTitle!: (title: string) => void;
    const root = mountSolid(() => {
      const [title, updateTitle] = createSignal("Synthetic chart");
      setTitle = updateTitle;
      return (
        <WidgetPinButton
          target={{ board: provider, name: "chart", viewId: "chart", mcpApp: false }}
          title={title()}
        />
      );
    });
    onTestFinished(root.unmount);
    const button = pinButton(root.container)!;
    button.click();
    completion.reject(new Error("Synthetic pin failure"));
    await waitForSolid(() => expect(button.title).toBe("Could not pin to dashboard. Try again."));
    expect(showToast).toHaveBeenCalledExactlyOnceWith({
      message: "Could not pin to dashboard. Try again.",
    });
    setTitle("Updated chart");
    flush();
    expect(pinButton(root.container)).toBe(button);
    expect(button.title).toBe("Could not pin to dashboard. Try again.");
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("replaces a pin target while its previous board write is still pending", async () => {
    const pending = Promise.withResolvers<void>();
    const first = boardProvider({ pinWidget: vi.fn(() => pending.promise) });
    const nextPin = vi.fn(async () => undefined);
    const next = boardProvider({ pinWidget: nextPin });
    const host = mountWidget(documentPreview("cv_first", { viewId: "cv_first" }), {
      boardProvider: first.provider,
    });
    const previousButton = pinButton(host)!;
    previousButton.click();
    try {
      await waitForSolid(() => expect(previousButton.ariaLabel).toBe("Pinning…"));
      mountWidget(
        documentPreview("cv_next", { viewId: "cv_next" }),
        { boardProvider: next.provider },
        host,
      );
      await waitForSolid(() => {
        expect(pinButton(host)).not.toBe(previousButton);
        expect(pinButton(host)).toMatchObject({ disabled: false, ariaLabel: "Pin to dashboard" });
      });
      pinButton(host)!.click();
      expect(nextPin).toHaveBeenCalledWith({ docId: "cv_next", name: "canvas-cv_next" });
    } finally {
      pending.resolve();
    }
  });

  it.each([
    [
      "external",
      documentPreview("cv_external", {
        viewId: "cv_external",
        url: "https://example.com/widget.html",
      }),
    ],
    ["mismatched", documentPreview("cv_other", { viewId: "cv_expected" })],
    ["strict", documentPreview("cv_strict", { viewId: "cv_strict", sandbox: "strict" })],
    ["MCP App", { ...canvasPreview, viewId: "cv_app", mcpApp: { viewId: "cv_app" } }],
  ] as const)("does not offer Canvas pinning for %s content", (_label, preview) => {
    const { provider } = boardProvider();
    const host = mountWidget(preview, {
      boardProvider: provider,
      sessionKey,
      allowExternalEmbedUrls: true,
    });
    expect(pinButton(host)).toBeNull();
  });

  it("pins an MCP App using only its view identity", async () => {
    const pinMcpApp = vi.fn(async () => undefined);
    const { provider } = boardProvider({ canPinMcpApps: true, pinMcpApp });
    const preview = {
      ...canvasPreview,
      title: "Weather",
      mcpApp: {
        viewId: " mcp-app-source ",
        serverName: "weather",
      },
    };

    const origin = mountWidget(preview, { boardProvider: provider, sessionKey });
    pinButton(origin)?.click();
    await vi.waitFor(() =>
      expect(pinMcpApp).toHaveBeenCalledWith({
        viewId: "mcp-app-source",
        name: mcpAppWidgetNameForViewId("mcp-app-source"),
        title: "Weather",
      }),
    );

    const unsupportedProvider = { ...provider, canPinMcpApps: false } as BoardProvider;
    const unsupported = mountWidget(preview, {
      boardProvider: unsupportedProvider,
      sessionKey,
    });
    expect(pinButton(unsupported)).toBeNull();

    const missingView = mountWidget(
      { ...preview, mcpApp: { ...preview.mcpApp, viewId: "   " } },
      { boardProvider: provider, sessionKey },
    );
    expect(pinButton(missingView)).toBeNull();
  });
  it("releases placement observation while a retained widget is hidden", () => {
    const observers: ResizeObserverStub[] = [];
    class ResizeObserverStub implements ResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor(private readonly callback: ResizeObserverCallback) {
        observers.push(this);
      }
      deliver() {
        this.callback([], this);
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const frames: FrameRequestCallback[] = [];
    const request = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    const [presented, setPresented] = createSignal(true);
    const [options, setOptions] = createSignal({ rawText: "Widget details" });
    const root = mountSolid(() => (
      <ContentPresentation value={presented}>
        <div class="chat-thread">
          <ToolPreview
            preview={{ ...canvasPreview, url: "about:blank", sandbox: "strict" }}
            surface="chat_message"
            options={options()}
          />
        </div>
      </ContentPresentation>
    ));
    onTestFinished(() => {
      root.unmount();
      request.mockRestore();
      cancel.mockRestore();
      vi.unstubAllGlobals();
    });
    flush();
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observe).toHaveBeenCalledTimes(2);
    const frame = root.container.querySelector("iframe");
    const thread = root.container.querySelector<HTMLElement>(".chat-thread")!;
    const preview = root.container.querySelector<HTMLElement>(".chat-tool-card__preview")!;
    vi.spyOn(thread, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    Object.defineProperty(thread, "clientWidth", { value: 100 });
    const geometry = vi
      .spyOn(preview, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 90, 100));
    observers[0]?.deliver();
    expect(preview.hasAttribute("data-widget-actions-above")).toBe(false);
    frames.shift()?.(0);
    expect(preview.hasAttribute("data-widget-actions-above")).toBe(true);

    setOptions({ rawText: "Updated widget details" });
    flush();
    expect(observers).toHaveLength(1);
    expect(observers[0]?.disconnect).not.toHaveBeenCalled();

    geometry.mockReturnValue(new DOMRect(0, 0, 50, 100));
    observers[0]?.deliver();
    setPresented(false);
    flush();
    frames.shift()?.(0);
    expect(preview.hasAttribute("data-widget-actions-above")).toBe(true);
    expect(observers[0]?.disconnect).toHaveBeenCalledOnce();
    expect(root.container.querySelector("iframe")).toBe(frame);

    setPresented(true);
    flush();
    observers[1]?.deliver();
    frames.shift()?.(0);
    expect(observers).toHaveLength(2);
    expect(preview.hasAttribute("data-widget-actions-above")).toBe(false);
    expect(root.container.querySelector("iframe")).toBe(frame);
  });

  const preview = documentPreview("cv_clock", { title: "Clock", viewId: "cv_clock" });

  it.each([
    ["strict", "scripts", false],
    ["trusted", undefined, true],
    ["trusted", "strict", false],
  ] as const)("applies %s policy to preview sandbox %s", (embedSandboxMode, sandbox, scripted) => {
    const { provider, snapshot } = boardProvider();
    snapshot.value = { widgets: [{ name: "canvas-cv_clock" }] };
    const host = mountWidget(
      { ...preview, sandbox },
      { embedSandboxMode, boardProvider: provider },
    );
    const managedView = host.querySelector("openclaw-canvas-widget-view");
    expect(managedView !== null).toBe(sandbox !== "strict");
    expect(pinButton(host) !== null).toBe(scripted);
    if (managedView) {
      expect(managedView.allowScripts).toBe(scripted);
      expect(host.querySelector("iframe")).toBeNull();
    } else {
      expect(host.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
    }
  });
});
