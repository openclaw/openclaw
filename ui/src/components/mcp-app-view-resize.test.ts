import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { createMcpBridgeFixture } from "../test-helpers/mcp-app-view-bridge.ts";

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
function theme(mode: string, background: string, text: string) {
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.setProperty("--card", background);
  document.documentElement.style.setProperty("--text", text);
  return {
    theme: mode,
    styles: {
      variables: expect.objectContaining({
        "--color-background-primary": background,
        "--color-text-primary": text,
      }),
    },
  };
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
    const dark = theme("dark", "#161920", "#d4d4d8");
    const { bridge, frame, themeListeners, unsubscribe, view, unmount } = await mountBridge(
      `view-context-${crypto.randomUUID()}`,
    );
    expect(bridge.options.hostContext).toMatchObject({
      ...dark,
      containerDimensions: { width: 640, height: 600 },
    });
    await expect.poll(() => themeListeners.size).toBe(1);
    const light = theme("light", "#ffffff", "#403c35");
    themeListeners.values().next().value?.();
    expectHost(bridge, light);
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
    const teardown = deferred<Record<string, never>>();
    onTestFinished(() => teardown.resolve({}));
    bridge.teardownResource.mockReturnValueOnce(teardown.promise);
    const retiring = view.teardown();
    expect(frame.isConnected).toBe(true);
    await expect.poll(() => observers[0]!.disconnect).toHaveBeenCalledOnce();
    expect(observers[0]!.targets.size).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(themeListeners.size).toBe(0);
    teardown.resolve({});
    await retiring;
    expect(frame.isConnected).toBe(false);
    unmount();
  });
});
