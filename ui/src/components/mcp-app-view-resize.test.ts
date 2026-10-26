import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
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
type BridgeFixture = Awaited<ReturnType<typeof mountBridge>>;
function expectHost(bridge: BridgeFixture["bridge"], context: Record<string, unknown>) {
  expect(bridge.setHostContext).toHaveBeenLastCalledWith(expect.objectContaining(context));
}
function stubAppResizeObservers() {
  const observers: TestResizeObserver[] = [];
  class TestResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>();
    readonly unobserve = vi.fn((target: Element): void => {
      this.targets.delete(target);
    });
    readonly disconnect = vi.fn(() => this.targets.clear());
    constructor(private readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    deliver(targets = [...this.targets]) {
      this.callback(
        targets.map((target) => ({
          target,
          contentRect: new DOMRectReadOnly(),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        })),
        this,
      );
    }
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  return observers;
}

describe("mcp-app-view localization", () => {
  it("pushes live theme and container changes and cleans up their observers", async () => {
    const observers = stubAppResizeObservers();
    const resize = () => observers[0]!.deliver();
    let width = 640;
    let height = 480;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width, height }) as DOMRect,
    );
    document.documentElement.dataset.themeMode = "dark";
    document.documentElement.style.setProperty("--card", "#161920");
    document.documentElement.style.setProperty("--text", "#d4d4d8");
    const { bridge, frame, themeListeners, unsubscribe, view, unmount } = await mountBridge(
      `view-context-${crypto.randomUUID()}`,
    );
    expect(bridge.options.hostContext).toMatchObject({
      theme: "dark",
      containerDimensions: { width: 640, height: 600 },
      styles: {
        variables: {
          "--color-background-primary": "#161920",
          "--color-text-primary": "#d4d4d8",
        },
      },
    });
    await expect.poll(() => themeListeners.size).toBe(1);
    document.documentElement.dataset.themeMode = "light";
    document.documentElement.style.setProperty("--card", "#ffffff");
    document.documentElement.style.setProperty("--text", "#403c35");
    themeListeners.values().next().value?.();
    expect(bridge.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: "light",
        styles: {
          variables: expect.objectContaining({
            "--color-background-primary": "#ffffff",
            "--color-text-primary": "#403c35",
          }),
        },
      }),
    );
    width = 720;
    resize();
    expectHost(bridge, { containerDimensions: { width: 720, height: 600 } });
    view.height = 480;
    await view.updateComplete;
    expect(view.querySelector("iframe")?.style.height).toBe("480px");
    expectHost(bridge, { containerDimensions: { width: 720, height: 480 } });
    const onHeightChange = vi.fn();
    view.onHeightChange = onHeightChange;
    bridge.onsizechange?.({ height: 900 });
    expect(frame.style.height).toBe("900px");
    expect(view.querySelector<HTMLElement>(".mount")?.style.minHeight).toBe("900px");
    expect(onHeightChange).toHaveBeenLastCalledWith(900);
    bridge.onsizechange?.({ height: Number.NaN });
    expect(frame.style.height).toBe("900px");
    expect(onHeightChange).toHaveBeenCalledTimes(1);
    for (const change of [
      { title: "Updated library" },
      { surface: "board" },
      { relaunching: true },
    ]) {
      Object.assign(view, change);
      await view.updateComplete;
      expect(view.querySelector("iframe")).toBe(frame);
      expect(frame.style.height).toBe("900px");
    }
    view.fillContainer = true;
    await view.updateComplete;
    expect(view.querySelector("iframe")?.style.height).toBe("100%");
    bridge.onsizechange?.({ height: 900 });
    expect(view.querySelector("iframe")?.style.height).toBe("100%");
    expect(onHeightChange).toHaveBeenCalledTimes(1);
    expectHost(bridge, { containerDimensions: { width: 720, height: 480 } });
    height = 760;
    resize();
    expectHost(bridge, { containerDimensions: { width: 720, height: 760 } });
    view.fillContainer = false;
    await view.updateComplete;
    expect(view.querySelector("iframe")?.style.height).toBe("480px");
    bridge.onsizechange?.({ height: 900 });
    expect(view.querySelector("iframe")?.style.height).toBe("900px");
    unmount();
    await expect.poll(() => observers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(themeListeners.size).toBe(0);
  });
  it("shares resize delivery across App views and retires only the closing view", async () => {
    const observers = stubAppResizeObservers();
    const first = await mountBridge("view-shared-resize-first");
    const teardown = deferred<Record<string, never>>();
    let second: ReturnType<typeof mountView> | undefined;
    try {
      second = mountView(
        {
          sessionKey: first.view.sessionKey,
          viewId: "view-shared-resize-second",
          fillContainer: true,
        },
        { gateway: first.gateway, theme: { subscribe: () => () => {} } },
      );
      await waitForSolid(() => expect(second!.view.querySelector("iframe")).not.toBeNull());
      const secondFrame = second.view.querySelector<HTMLIFrameElement>("iframe")!;
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { method: "ui/notifications/sandbox-proxy-ready" },
          source: secondFrame.contentWindow,
        }),
      );
      await waitForSolid(() => {
        expect(bridgeMocks.instances).toHaveLength(2);
        expect(observers.reduce((count, observer) => count + observer.targets.size, 0)).toBe(2);
      });
      expect(observers).toHaveLength(1);
      const observer = observers[0]!;
      const secondBridge = bridgeMocks.instances[1]!;
      const firstMount = first.view.querySelector<HTMLElement>(".mount")!;
      const secondMount = second.view.querySelector<HTMLElement>(".mount")!;
      vi.spyOn(firstMount, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 240));
      vi.spyOn(secondMount, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 480));
      vi.clearAllMocks();
      observer.deliver([firstMount]);
      expectHost(first.bridge, { containerDimensions: { width: 320, height: 600 } });
      expect(secondBridge.setHostContext).not.toHaveBeenCalled();
      observer.deliver([secondMount]);
      expect(secondBridge.setHostContext).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ containerDimensions: { width: 640, height: 480 } }),
      );

      first.bridge.teardownResource.mockReturnValueOnce(teardown.promise);
      const retiring = first.view.teardown();
      expect(first.frame.isConnected).toBe(true);
      expect(observer.targets).toEqual(new Set([secondMount]));
      expect(observer.unobserve).toHaveBeenCalledExactlyOnceWith(firstMount);
      expect(observer.disconnect).not.toHaveBeenCalled();
      vi.clearAllMocks();
      observer.deliver([secondMount]);
      expect(first.bridge.setHostContext).not.toHaveBeenCalled();
      expect(secondBridge.setHostContext).toHaveBeenCalledOnce();
      teardown.resolve({});
      await retiring;
      expect(first.frame.isConnected).toBe(false);
      await second.view.teardown();
      expect(observer.targets.size).toBe(0);
      expect(observer.disconnect).toHaveBeenCalledOnce();
    } finally {
      teardown.resolve({});
      await first.view.teardown();
      await second?.view.teardown();
      first.unmount();
      second?.unmount();
    }
  });
});
