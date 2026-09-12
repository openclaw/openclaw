/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { DesktopClient } from "./desktop-client.ts";
import { DesktopMobileKeyboard } from "./desktop-mobile-keyboard.ts";

type RfbConstructor = NonNullable<ConstructorParameters<typeof DesktopClient>[0]>;
type RfbClient = InstanceType<RfbConstructor>;

class FakeSocket extends EventTarget {
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }
}

function createFakeRfb() {
  const instances: FakeRfb[] = [];
  class FakeRfb extends EventTarget implements RfbClient {
    background = "";
    viewOnly = false;
    scaleViewport = false;
    resizeSession = false;
    readonly disconnect = vi.fn();
    readonly sendKey = vi.fn();

    constructor(
      readonly target: HTMLElement,
      readonly channel: string | WebSocket,
      readonly options?: { credentials?: { username?: string; password?: string } },
    ) {
      super();
      instances.push(this);
    }
  }
  return { Rfb: FakeRfb as RfbConstructor, instances };
}

describe("DesktopClient", () => {
  it.each([
    { trusted: true, held: false },
    { trusted: true, held: true },
    { trusted: false, held: false },
  ])(
    "reconciles keyboard focus snapshots only when trusted=$trusted, held=$held",
    async ({ trusted, held }) => {
      const { Rfb } = createFakeRfb();
      const client = new DesktopClient(Rfb, (url) => new FakeSocket(url) as unknown as WebSocket);
      const target = document.createElement("div");
      const canvas = document.createElement("canvas");
      target.append(canvas);
      const handle = await client.connect({
        target,
        wsUrl: "ws://control.example.test/desktop/observe",
        viewOnly: false,
        isCurrent: () => true,
      });
      const input = document.createElement("textarea");
      const keyboard = new DesktopMobileKeyboard({
        connection: () => handle,
        controlling: () => true,
        input: () => input,
      });
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
        keyboard.reset();
        handle.disconnect();
      }
    },
  );

  it.each(["blur", "reset", "replacement", "view-only"])(
    "does not restore old keyboard modifiers after %s",
    async (transition) => {
      const { Rfb } = createFakeRfb();
      const client = new DesktopClient(Rfb, (url) => new FakeSocket(url) as unknown as WebSocket);
      const target = document.createElement("div");
      const canvas = document.createElement("canvas");
      target.append(canvas);
      const connect = () =>
        client.connect({
          target,
          wsUrl: "ws://control.example.test/desktop/observe",
          viewOnly: false,
          isCurrent: () => true,
        });
      const original = await connect();
      let handle = original;
      let controlling = true;
      const input = document.createElement("textarea");
      const keyboard = new DesktopMobileKeyboard({
        connection: () => handle,
        controlling: () => controlling,
        input: () => input,
      });
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
        keyboard.reset();
        handle.disconnect();
      }
    },
  );

  it.each([false, true])(
    "opens a socket after the RFB loader only while the operation remains current (%s)",
    async (remainsCurrent) => {
      const { Rfb, instances } = createFakeRfb();
      const loaded = createDeferred<RfbConstructor>();
      const createSocket = vi.fn((url: string) => new FakeSocket(url) as unknown as WebSocket);
      const client = new DesktopClient(undefined, createSocket, () => loaded.promise);
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
    const client = new DesktopClient(Rfb, (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
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
    expect(instances[0]?.target).toBe(target);
    expect(instances[0]?.channel).toBe(sockets[0]);
  });

  it("propagates RFB options and disconnects through the returned handle", async () => {
    const { Rfb, instances } = createFakeRfb();
    const socket = new FakeSocket("ws://control.example.test/desktop/observe");
    const client = new DesktopClient(Rfb, () => socket as unknown as WebSocket);
    const target = document.createElement("div");
    const canvas = document.createElement("canvas");
    const onKeyDown = vi.fn();
    canvas.addEventListener("keydown", onKeyDown);
    target.append(canvas);

    const handle = await client.connect({
      gatewayUrl: "ws://control.example.test",
      isCurrent: () => true,
      wsUrl: "/desktop/observe",
      credentials: { username: "operator", password: "secret" },
      background: "rgb(8, 8, 8)",
      viewOnly: false,
      sizingMode: "actual",
      target,
    });

    expect(instances[0]?.background).toBe("rgb(8, 8, 8)");
    expect(instances[0]?.viewOnly).toBe(false);
    expect(instances[0]?.scaleViewport).toBe(false);
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
      const { Rfb, instances } = createFakeRfb();
      const client = new DesktopClient(Rfb, (url) => new FakeSocket(url) as unknown as WebSocket);
      const handle = await client.connect({
        target: document.createElement("div"),
        wsUrl: "ws://control.example.test/desktop/observe",
        isCurrent: () => true,
        canResize,
        viewOnly,
        sizingMode: "match",
      });
      const rfb = instances[0]!;
      expect(rfb.scaleViewport).toBe(true);
      expect(rfb.resizeSession).toBe(false);
      rfb.dispatchEvent(new Event("connect"));
      expect(rfb.resizeSession).toBe(resizes);
      handle.setSizingMode("actual");
      expect([rfb.scaleViewport, rfb.resizeSession]).toEqual([false, false]);
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
      const { Rfb, instances } = createFakeRfb();
      const client = new DesktopClient(Rfb, (url) => new FakeSocket(url) as unknown as WebSocket);
      let current = true;
      const handle = await client.connect({
        target: document.createElement("div"),
        wsUrl: "ws://control.example.test/desktop/observe",
        isCurrent: () => current,
        canResize: true,
        viewOnly: false,
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
      rfb.dispatchEvent(new Event("connect"));
      expect(rfb.resizeSession).toBe(false);
      handle.disconnect();
    },
  );

  it.each([
    { clean: true, close: { code: 4000, reason: "control-taken" } },
    { clean: false, close: { code: 1008, reason: "authentication rejected" } },
    { clean: false, close: { code: 1006, reason: "" } },
    { clean: false, close: undefined },
    { clean: true, close: undefined },
  ])("preserves RFB clean=$clean with socket close $close", async ({ clean, close }) => {
    const { Rfb, instances } = createFakeRfb();
    const socket = new FakeSocket("ws://control.example.test/desktop/observe");
    const onDisconnect = vi.fn();
    const client = new DesktopClient(Rfb, () => socket as unknown as WebSocket);

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
    const { Rfb } = createFakeRfb();
    const socket = new FakeSocket("ws://control.example.test/desktop/observe");
    const client = new DesktopClient(Rfb, () => socket as unknown as WebSocket);
    const target = document.createElement("div");
    const canvas = document.createElement("canvas");
    const events: KeyboardEvent[] = [];
    const onKey = (event: KeyboardEvent) => events.push(event);
    canvas.addEventListener("keydown", onKey);
    canvas.addEventListener("keyup", onKey);
    target.append(canvas);
    const handle = await client.connect({
      wsUrl: "ws://control.example.test/desktop/observe",
      isCurrent: () => true,
      viewOnly: false,
      target,
    });

    handle.sendText(text);

    expect(events.map(({ type, key, code }) => ({ type, key, code }))).toEqual(
      keys.map((key) => ({ type: "keydown", key, code: "Unidentified" })),
    );
    handle.disconnect();
  });
});
