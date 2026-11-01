/* @vitest-environment jsdom */

import type {
  CreateGhosttyTerminalOptions,
  GhosttyTerminalController,
} from "@openclaw/libterminal/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import {
  disposeTerminalController,
  replaceTerminalController,
} from "./terminal-controller-lifecycle.ts";
import { createTerminalController } from "./terminal-controller.test-support.ts";
import { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";

const runtimeMocks = vi.hoisted(() => ({
  create: vi.fn(),
  fontReady: vi.fn<() => Promise<void>>(),
  load: vi.fn(),
  proposeDimensions: vi.fn<() => { cols: number; rows: number } | undefined>(),
  disposeMeasurement: vi.fn(),
  observe: vi.fn(),
  disconnect: vi.fn(),
  notifyResize: () => {},
}));

vi.mock("@openclaw/libterminal/browser", () => ({
  createGhosttyTerminal: runtimeMocks.create,
  loadGhosttyRuntime: runtimeMocks.load,
}));
vi.mock("ghostty-web", () => ({ mockedGhosttyModule: true }));

class MeasurementAddon {
  activate() {}
  proposeDimensions = runtimeMocks.proposeDimensions;
  dispose = runtimeMocks.disposeMeasurement;
}

function terminalController(dispose: () => void = vi.fn()) {
  return createTerminalController(dispose) as unknown as GhosttyTerminalController &
    ReturnType<typeof createTerminalController>;
}

function terminalRoot() {
  const root = document.body
    .appendChild(document.createElement("div"))
    .attachShadow({ mode: "open" });
  const external = root.appendChild(document.createElement("input"));
  const previousHost = root.appendChild(document.createElement("div"));
  previousHost.tabIndex = 0;
  return { external, previousHost, root };
}

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
let underlying: ReturnType<typeof terminalController>;
let parent: HTMLDivElement;

beforeEach(() => {
  underlying = terminalController();
  parent = document.body.appendChild(document.createElement("div"));
  runtimeMocks.create.mockResolvedValue(underlying);
  runtimeMocks.load.mockResolvedValue({ FitAddon: MeasurementAddon });
  runtimeMocks.fontReady.mockReturnValue(new Promise(() => {}));
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: Object.assign(new EventTarget(), { add: vi.fn() }),
  });
  vi.stubGlobal(
    "FontFace",
    class {
      load = runtimeMocks.fontReady;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        runtimeMocks.notifyResize = () => callback([], this);
      }
      observe = runtimeMocks.observe;
      disconnect = runtimeMocks.disconnect;
      unobserve() {}
    },
  );
});

afterEach(() => {
  document.body.replaceChildren();
  restorePropertyDescriptor(document, "fonts", originalFonts);
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("cleans up pinned listeners before idempotent disposal", async () => {
  const underlyingDispose = vi.fn(() => {
    throw new Error("dispose failed");
  });
  underlying = terminalController(underlyingDispose);
  const handleMouseUp = vi.fn();
  (underlying.terminal as unknown as { handleMouseUp: EventListener }).handleMouseUp =
    handleMouseUp;
  runtimeMocks.create.mockResolvedValue(underlying);
  const removeEventListener = vi.spyOn(document, "removeEventListener");
  const controller = await createIsolatedGhosttyTerminal({ parent });
  expect(() => disposeTerminalController(controller, parent)).not.toThrow();
  expect(() => disposeTerminalController(controller, parent)).not.toThrow();

  expect(removeEventListener).toHaveBeenCalledExactlyOnceWith("mouseup", handleMouseUp);
  expect(removeEventListener.mock.invocationCallOrder[0]).toBeLessThan(
    underlyingDispose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
  expect(underlyingDispose).toHaveBeenCalledOnce();
  expect(runtimeMocks.disconnect).toHaveBeenCalledOnce();
  expect(runtimeMocks.disposeMeasurement).toHaveBeenCalledOnce();
  expect(parent.isConnected).toBe(false);
});

it.each([true, false])("gates opening focus, not explicit focus (allowed=%s)", async (allowed) => {
  vi.useFakeTimers();
  const focus = vi.fn();
  // Match the pinned renderer's immediate focus and zero-delay repeat without real sleeps.
  class FakeTerminal {
    open(_parent: HTMLElement) {
      this.focus();
    }
    focus() {
      focus();
      setTimeout(focus, 0);
    }
  }
  const opened: Array<Pick<GhosttyTerminalController["terminal"], "focus">> = [];
  runtimeMocks.load.mockResolvedValue({ Terminal: FakeTerminal, FitAddon: MeasurementAddon });
  runtimeMocks.create.mockImplementation(async (options: CreateGhosttyTerminalOptions) => {
    if (!options.runtime) {
      throw new Error("isolated runtime missing");
    }
    const terminal = new options.runtime.Terminal();
    terminal.open(options.parent);
    opened.push(terminal);
    return underlying;
  });
  const controller = await createIsolatedGhosttyTerminal({ parent }, () => allowed);
  expect(focus).toHaveBeenCalledTimes(allowed ? 1 : 0);
  vi.runOnlyPendingTimers();
  expect(focus).toHaveBeenCalledTimes(allowed ? 2 : 0);
  focus.mockClear();
  opened[0]?.focus();
  expect(focus).toHaveBeenCalledOnce();
  vi.runOnlyPendingTimers();
  expect(focus).toHaveBeenCalledTimes(2);
  controller.dispose();
});

it("applies rapid fit/resize updates and ignores them after disposal", async () => {
  underlying.resize.mockImplementation(({ columns, rows }: { columns: number; rows: number }) => {
    underlying.terminal.cols = columns;
    underlying.terminal.rows = rows;
  });
  runtimeMocks.proposeDimensions.mockReturnValue({ cols: 95, rows: 57 });
  const controller = await createIsolatedGhosttyTerminal({ parent });
  expect(underlying.terminal).toMatchObject({ cols: 95, rows: 57 });
  runtimeMocks.proposeDimensions.mockReturnValue({ cols: 2, rows: 57 });
  controller.fit();
  expect(underlying.terminal).toMatchObject({ cols: 2, rows: 57 });
  runtimeMocks.proposeDimensions.mockReturnValue({ cols: 51, rows: 25 });
  runtimeMocks.notifyResize();

  expect(underlying.terminal).toMatchObject({ cols: 51, rows: 25 });
  controller.dispose();
  runtimeMocks.proposeDimensions.mockReturnValue({ cols: 100, rows: 30 });
  runtimeMocks.notifyResize();
  expect(underlying.terminal).toMatchObject({ cols: 51, rows: 25 });
});

it.each([false, true])("remeasures fonts only while live (disposed=%s)", async (disposed) => {
  const ready = createDeferred();
  runtimeMocks.fontReady.mockReturnValue(ready.promise);
  const controller = await createIsolatedGhosttyTerminal({ parent, autoFit: false });
  if (disposed) {
    controller.dispose();
  }
  ready.resolve();
  await ready.promise;
  document.fonts.dispatchEvent(new Event("loadingdone"));
  expect(underlying.terminal.renderer.remeasureFont).toHaveBeenCalledTimes(disposed ? 0 : 2);
  expect(runtimeMocks.proposeDimensions).not.toHaveBeenCalled();
  controller.dispose();
  document.fonts.dispatchEvent(new Event("loadingdone"));
  expect(underlying.terminal.renderer.remeasureFont).toHaveBeenCalledTimes(disposed ? 0 : 2);
});

it("does not observe a terminal aborted during creation", async () => {
  const dispose = vi.spyOn(underlying, "dispose");
  const created = createDeferred<GhosttyTerminalController>();
  runtimeMocks.create.mockReturnValue(created.promise);
  const abort = new AbortController();
  const pending = createIsolatedGhosttyTerminal({ parent, signal: abort.signal });
  await vi.waitFor(() => expect(runtimeMocks.create).toHaveBeenCalledOnce());
  abort.abort();
  created.resolve(underlying);

  await pending;
  expect(runtimeMocks.observe).not.toHaveBeenCalled();
  expect(runtimeMocks.proposeDimensions).not.toHaveBeenCalled();
  expect(runtimeMocks.disposeMeasurement).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
});

it.each(["replacement", "external", "newer"] as const)(
  "publishes a measurable writable replacement, preserving %s focus",
  async (focusAfter) => {
    const { external, previousHost, root } = terminalRoot();
    const newer = root.appendChild(document.createElement("input"));
    const previous = underlying;
    const replacement = terminalController();
    const target = { controller: previous, host: previousHost };
    previousHost.style.display = "none";
    previousHost.style.visibility = "visible";
    (focusAfter === "replacement" ? previousHost : external).focus();

    const replaced = await replaceTerminalController(
      target,
      async (host, options) => {
        expect(options).toEqual({ readOnly: true });
        expect(host).toMatchObject({
          style: { display: "block", visibility: "hidden" },
          inert: true,
        });
        host.tabIndex = 0;
        host.focus();
        setTimeout(() => host.focus(), 0);
        if (focusAfter === "newer") {
          setTimeout(() => newer.focus(), 0);
        }
        return replacement;
      },
      "authoritative replay",
      new AbortController().signal,
    );

    expect(replaced).toBe(true);
    expect(target.controller).toBe(replacement);
    expect(target.host).not.toBe(previousHost);
    expect(new TextDecoder().decode(replacement.write.mock.calls[0]?.[0])).toBe(
      "authoritative replay",
    );
    expect(replacement.setReadOnly).toHaveBeenCalledWith(false);
    expect(target.host).toMatchObject({ isConnected: true, inert: false });
    expect(target.host.style).toMatchObject({ display: "none", visibility: "visible" });
    expect(previous.dispose).toHaveBeenCalledOnce();
    expect(root.activeElement).toBe(
      focusAfter === "replacement" ? target.host : focusAfter === "external" ? external : newer,
    );
  },
);

it("disposes an aborted replacement and restores stolen focus", async () => {
  const { external, previousHost, root } = terminalRoot();
  const previous = underlying;
  const replacement = terminalController();
  const target = { controller: previous, host: previousHost };
  const created = createDeferred<GhosttyTerminalController>();
  const abort = new AbortController();
  let stagedHost: HTMLElement | undefined;
  external.focus();

  const replacing = replaceTerminalController(
    target,
    async (host) => {
      stagedHost = host;
      host.tabIndex = 0;
      host.focus();
      previousHost.remove();
      return created.promise;
    },
    "must not publish",
    abort.signal,
  );
  await vi.waitFor(() => expect(stagedHost).toBeDefined());
  abort.abort();
  created.resolve(replacement);

  await expect(replacing).resolves.toBe(false);
  expect(target).toEqual({ controller: previous, host: previousHost });
  expect(previous.dispose).not.toHaveBeenCalled();
  expect(replacement.write).not.toHaveBeenCalled();
  expect(replacement.dispose).toHaveBeenCalledOnce();
  expect(stagedHost?.isConnected).toBe(false);
  expect(root.activeElement).toBe(external);
});
