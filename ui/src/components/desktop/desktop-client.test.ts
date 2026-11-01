/* @vitest-environment jsdom */

import { createRoot, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { DesktopClient } from "./desktop-client.ts";
import { createDesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";

class FakeSocket extends EventTarget {
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }
}

function createFakeRfb() {
  const instances: FakeRfb[] = [];
  class FakeRfb extends EventTarget {
    background = "";
    viewOnly = false;
    scaleViewport = false;
    resizeSession = false;
    readonly disconnect = vi.fn();
    readonly sendKey = vi.fn();

    // Match noVNC's EventTargetMixin, which accepts no listener options.
    override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null) {
      super.addEventListener(type, callback);
    }

    constructor(
      readonly target: HTMLElement,
      readonly channel: string | WebSocket,
      readonly options?: { credentials?: { username?: string; password?: string } },
    ) {
      super();
      instances.push(this);
    }
  }
  return { Rfb: FakeRfb, instances };
}

function mockDesktopClient(
  rfb: ReturnType<typeof createFakeRfb>["Rfb"] | Promise<ReturnType<typeof createFakeRfb>["Rfb"]>,
  createSocket: (url: string) => FakeSocket = (url) => new FakeSocket(url),
) {
  // mock-isolation: Replace the external RFB module, including its pending lazy initialization.
  vi.doMock("@novnc/novnc", async () => ({ default: await rfb }));
  vi.stubGlobal(
    "WebSocket",
    vi.fn(function (url: string) {
      return createSocket(url);
    }),
  );
  return new DesktopClient();
}

function setupClient() {
  const { Rfb, instances } = createFakeRfb();
  const client = mockDesktopClient(Rfb);
  const target = document.createElement("div");
  const canvas = document.createElement("canvas");
  target.append(canvas);
  const connect = (options: Partial<Parameters<DesktopClient["connect"]>[0]> = {}) =>
    client.connect({
      target,
      wsUrl: "ws://control.example.test/desktop/observe",
      viewOnly: false,
      isCurrent: () => true,
      ...options,
    });
  return { instances, target, canvas, connect };
}

afterEach(() => {
  vi.doUnmock("@novnc/novnc");
  vi.unstubAllGlobals();
});

describe("DesktopClient", () => {
  it("retires noVNC callbacks after its permanent disconnect", async () => {
    const { instances, connect } = setupClient();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    const onSecurityFailure = vi.fn();
    await connect({ onConnect, onDisconnect, onSecurityFailure });
    const rfb = instances[0]!;
    rfb.dispatchEvent(new Event("connect"));
    rfb.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: true } }));
    rfb.dispatchEvent(new Event("connect"));
    rfb.dispatchEvent(new CustomEvent("securityfailure", { detail: { status: 1 } }));
    rfb.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: true } }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledExactlyOnceWith({ clean: true });
    expect(onSecurityFailure).not.toHaveBeenCalled();
  });

  it.each([
    { trusted: true, held: false },
    { trusted: true, held: true },
    { trusted: false, held: false },
  ])(
    "reconciles keyboard focus snapshots only when trusted=$trusted, held=$held",
    async ({ trusted, held }) => {
      const { canvas, connect } = setupClient();
      const handle = await connect();
      const input = document.createElement("textarea");
      const [keyboard, dispose] = createRoot(
        (disposeRoot) => [createDesktopMobileKeyboard(() => handle), disposeRoot] as const,
      );
      flush();
      keyboard.inputRef(input);
      input.addEventListener("input", (event) => keyboard.handleInput(event as InputEvent));
      const events: string[] = [];
      for (const type of ["keydown", "keyup"]) {
        canvas.addEventListener(type, (event) => {
          events.push(`${event.type}:${(event as KeyboardEvent).key}`);
        });
      }
      try {
        keyboard.reset();
        keyboard.handleKeyboardEvent(
          new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true }),
        );
        const snapshot = new MouseEvent("click", { shiftKey: held });
        keyboard.focus(
          new Proxy(snapshot, {
            get(snapshotEvent, key) {
              if (key === "isTrusted") {
                return trusted;
              }
              if (key === "getModifierState") {
                return snapshotEvent.getModifierState.bind(snapshotEvent);
              }
              return Reflect.get(snapshotEvent, key);
            },
          }),
        );
        input.value += "p";
        input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data: "p" }));
        // noVNC turns the Unidentified text keydown into a balanced wire press.
        expect(events).toEqual([
          "keydown:Shift",
          "keyup:Shift",
          "keydown:p",
          ...(trusted && !held ? [] : ["keydown:Shift"]),
        ]);
      } finally {
        dispose();
        handle.disconnect();
      }
    },
  );

  it.each(["blur", "reset", "replacement", "view-only"])(
    "does not restore old keyboard modifiers after %s",
    async (transition) => {
      const { canvas, connect } = setupClient();
      const original = await connect();
      let handle = original;
      let controlling = true;
      const input = document.createElement("textarea");
      const [keyboard, dispose] = createRoot(
        (disposeRoot) =>
          [createDesktopMobileKeyboard(() => (controlling ? handle : null)), disposeRoot] as const,
      );
      flush();
      keyboard.inputRef(input);
      input.addEventListener("input", (event) => keyboard.handleInput(event as InputEvent));
      const keys: string[] = [];
      canvas.addEventListener("keydown", (event) => keys.push(event.key));
      try {
        keyboard.reset();
        keyboard.handleKeyboardEvent(
          new KeyboardEvent("keydown", {
            key: "Control",
            code: "ControlLeft",
            ctrlKey: true,
            location: 1,
          }),
        );
        if (transition === "blur") {
          window.dispatchEvent(new Event("blur"));
        } else if (transition === "reset") {
          keyboard.reset();
        } else if (transition === "replacement") {
          original.disconnect();
          handle = await connect();
        } else {
          controlling = false;
        }
        input.value += "p";
        input.dispatchEvent(new InputEvent("input", { inputType: "insertFromPaste", data: "p" }));
        expect(keys).toEqual(transition === "view-only" ? ["Control"] : ["Control", "p"]);
      } finally {
        dispose();
        handle.disconnect();
      }
    },
  );

  it.each([false, true])(
    "opens a socket after the RFB loader only while the operation remains current (%s)",
    async (remainsCurrent) => {
      const { Rfb, instances } = createFakeRfb();
      const loaded = createDeferred<typeof Rfb>();
      const createSocket = vi.fn((url: string) => new FakeSocket(url));
      const client = mockDesktopClient(loaded.promise, createSocket);
      let current = true;
      const pending = client.connect({
        wsUrl: "ws://control.example.test/desktop/observe",
        viewOnly: false,
        target: document.createElement("div"),
        isCurrent: () => current,
      });
      const result = pending.then(
        (handle) => ({ handle, error: undefined }),
        (error: unknown) => ({ handle: undefined, error }),
      );
      try {
        expect(createSocket).not.toHaveBeenCalled();
        current = remainsCurrent;
        loaded.resolve(Rfb);
        const outcome = await result;
        expect(createSocket).toHaveBeenCalledTimes(remainsCurrent ? 1 : 0);
        if (remainsCurrent) {
          expect(outcome.error).toBeUndefined();
          expect(instances).toHaveLength(1);
        } else {
          expect(outcome.error).toMatchObject({ name: "AbortError" });
          expect(instances).toHaveLength(0);
        }
      } finally {
        loaded.resolve(Rfb);
        (await result).handle?.disconnect();
      }
    },
  );

  it.each([
    ["http://control.example.test/chat", "ws://control.example.test/desktop/observe?token=abc"],
    ["https://control.example.test/chat", "wss://control.example.test/desktop/observe?token=abc"],
  ])("resolves relative observer URLs against %s", async (gatewayUrl, expectedUrl) => {
    const { Rfb, instances } = createFakeRfb();
    const sockets: FakeSocket[] = [];
    const client = mockDesktopClient(Rfb, (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    });
    const target = document.createElement("div");

    await client.connect({
      gatewayUrl,
      isCurrent: () => true,
      wsUrl: "/desktop/observe?token=abc",
      credentials: { password: "secret" },
      viewOnly: true,
      target,
    });

    expect(sockets[0]?.url).toBe(expectedUrl);
    expect(target.contains(instances[0]!.target)).toBe(true);
    expect(instances[0]?.channel).toBe(sockets[0]);
  });

  it("propagates RFB options and disconnects through the returned handle", async () => {
    const { instances, canvas, connect } = setupClient();
    const onKeyDown = vi.fn();
    canvas.addEventListener("keydown", onKeyDown);
    const handle = await connect({
      gatewayUrl: "ws://control.example.test",
      wsUrl: "/desktop/observe",
      credentials: { username: "operator", password: "secret" },
      background: "rgb(8, 8, 8)",
      sizingMode: "actual",
    });

    expect(instances[0]).toMatchObject({
      background: "rgb(8, 8, 8)",
      viewOnly: false,
      scaleViewport: false,
    });
    expect(instances[0]?.options).toEqual({
      credentials: { username: "operator", password: "secret" },
    });

    handle.setSizingMode("fit");
    expect(instances[0]?.scaleViewport).toBe(true);
    handle.sendKeyboardEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK" }));
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect((onKeyDown.mock.calls[0]?.[0] as KeyboardEvent | undefined)?.key).toBe("k");
    handle.sendText("m");
    handle.sendBackspace();
    expect(onKeyDown.mock.calls.map((call) => (call[0] as KeyboardEvent | undefined)?.key)).toEqual(
      ["k", "m"],
    );
    expect(instances[0]?.sendKey).toHaveBeenCalledExactlyOnceWith(0xff08, "Backspace");

    handle.disableInput();
    expect(instances[0]?.viewOnly).toBe(true);
    handle.disconnect();
    handle.disconnect();
    expect(instances[0]?.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    { canResize: true, viewOnly: false, resizes: true },
    { canResize: true, viewOnly: true, resizes: false },
    { canResize: false, viewOnly: false, resizes: false },
    { canResize: undefined, viewOnly: false, resizes: false },
  ])(
    "gates Match at the authenticated controller boundary ($canResize/$viewOnly)",
    async ({ canResize, viewOnly, resizes }) => {
      // JSDOM has no layout; this case covers the RFB resize permission boundary.
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          disconnect() {}
        },
      );
      const { instances, connect } = setupClient();
      const handle = await connect({
        canResize,
        viewOnly,
        sizingMode: "match",
      });
      const rfb = instances[0]!;
      expect(rfb.scaleViewport).toBe(true);
      expect(rfb.resizeSession).toBe(false);
      rfb.dispatchEvent(new Event("connect"));
      expect(rfb.resizeSession).toBe(resizes);
      handle.setPresented(false);
      expect([rfb.viewOnly, rfb.resizeSession]).toEqual([true, false]);
      handle.setSizingMode("match");
      expect(rfb.resizeSession).toBe(false);
      handle.setPresented(true);
      expect([rfb.viewOnly, rfb.resizeSession]).toEqual([viewOnly, resizes]);
      handle.setSizingMode("actual");
      expect([rfb.scaleViewport, rfb.resizeSession]).toEqual([false, false]);
      for (const mode of ["fit-height", "fit-width"] as const) {
        handle.setSizingMode(mode);
        expect([rfb.scaleViewport, rfb.resizeSession]).toEqual([true, false]);
      }
      handle.setSizingMode("match");
      expect([rfb.scaleViewport, rfb.resizeSession]).toEqual([true, resizes]);
      handle.setSizingMode("fit");
      expect([rfb.scaleViewport, rfb.resizeSession]).toEqual([true, false]);
      handle.disconnect();
    },
  );

  it.each(["disableInput", "disconnect", "securityfailure", "stale", "onConnect"] as const)(
    "never re-enables resizing after %s",
    async (transition) => {
      const { instances, connect } = setupClient();
      let current = true;
      const handle = await connect({
        isCurrent: () => current,
        canResize: true,
        sizingMode: "match",
        onConnect: transition === "onConnect" ? () => handle.disconnect() : undefined,
      });
      const rfb = instances[0]!;
      rfb.dispatchEvent(new Event("connect"));
      if (transition === "stale") {
        current = false;
      } else if (transition === "securityfailure") {
        rfb.dispatchEvent(new CustomEvent("securityfailure", { detail: { status: 1 } }));
      } else if (transition !== "onConnect") {
        handle[transition]();
        expect(rfb.resizeSession).toBe(false);
      }
      handle.setSizingMode("match");
      handle.setPresented(false);
      handle.setPresented(true);
      rfb.dispatchEvent(new Event("connect"));
      expect(rfb.resizeSession).toBe(false);
      handle.disconnect();
    },
  );

  it.each([
    { clean: true, close: { code: 4000, reason: "control-taken" } },
    { clean: false, close: undefined },
  ])("preserves RFB clean=$clean with socket close $close", async ({ clean, close }) => {
    const { Rfb, instances } = createFakeRfb();
    const socket = new FakeSocket("ws://control.example.test/desktop/observe");
    const onDisconnect = vi.fn();
    const client = mockDesktopClient(Rfb, () => socket);

    const handle = await client.connect({
      wsUrl: "ws://control.example.test/desktop/observe",
      isCurrent: () => true,
      viewOnly: true,
      target: document.createElement("div"),
      onDisconnect,
    });
    onDisconnect.mockImplementation(() => handle.disconnect());
    if (close) {
      socket.dispatchEvent(new CloseEvent("close", close));
    }
    instances[0]?.dispatchEvent(new CustomEvent("disconnect", { detail: { clean } }));

    expect(onDisconnect).toHaveBeenCalledExactlyOnceWith({ ...close, clean });
    handle.disconnect();
    expect(instances[0]?.disconnect).not.toHaveBeenCalled();
    if (!close) {
      socket.dispatchEvent(new CloseEvent("close", { code: 1000 }));
      expect(onDisconnect).toHaveBeenCalledExactlyOnceWith({ clean });
    }
  });

  it.each([
    ["LF", "é\nΩ", ["é", "Enter", "Ω"]],
    ["CRLF", "é\r\nΩ", ["é", "Enter", "Ω"]],
    ["CR", "é\rΩ", ["é", "Enter", "Ω"]],
    ["blank lines", "\n\r\n\r", ["Enter", "Enter", "Enter"]],
  ] as const)("sends %s text line breaks as single Enter presses", async (_name, text, keys) => {
    const { canvas, connect } = setupClient();
    const events: KeyboardEvent[] = [];
    const onKey = (event: KeyboardEvent) => events.push(event);
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("keyup", onKey);
    const handle = await connect();

    handle.sendText(text);

    expect(events.map(({ type, key, code }) => ({ type, key, code }))).toEqual(
      keys.map((key) => ({ type: "keydown", key, code: "Unidentified" })),
    );
    handle.disconnect();
  });
});
