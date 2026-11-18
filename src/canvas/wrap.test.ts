import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  readWidgetPreviewControls,
  type WidgetPreviewControl,
} from "../shared/widget-preview-controls.js";
import { buildWidgetDocument, WIDGET_SIZE_CONFIRMATION_HTML } from "./wrap.js";

it("confirms current widget height on each parent chat-host notification", () => {
  const postMessage = vi.fn();
  const parent = { postMessage };
  let height = 120;
  let receive: (event: unknown) => void = () => {};
  runInNewContext(WIDGET_SIZE_CONFIRMATION_HTML.slice(8, -9), {
    window: { parent },
    document: {
      body: {
        get scrollHeight() {
          return height;
        },
        get offsetHeight() {
          return height;
        },
        getBoundingClientRect: () => ({ height }),
      },
    },
    addEventListener: (_type: string, handler: typeof receive) => {
      receive = handler;
    },
  });
  receive({ source: parent, data: { type: "openclaw:widget-chat-host" } });
  expect(postMessage).not.toHaveBeenCalled();
  const data = { type: "openclaw:widget-chat-host", measure: true };
  receive({ source: {}, data });
  expect(postMessage).not.toHaveBeenCalled();
  receive({ source: parent, data });
  height = 80;
  receive({ source: parent, data });
  receive({ source: parent, data });
  expect(postMessage.mock.calls).toEqual(
    [120, 80, 80].map((reportedHeight) => [
      { type: "openclaw:widget-size", height: reportedHeight },
      "*",
    ]),
  );
});

const messagePrefix = "x".repeat(499);
const sourcePrefix = "s".repeat(199);
it.each([
  ["ASCII limits", "x".repeat(600), "x".repeat(500), `${"s".repeat(220)}.js`, "s".repeat(200)],
  ["short Unicode", "Ready 😀", "Ready 😀", "ready😀.js", "ready😀.js"],
  ["surrogates", `${messagePrefix}😀tail`, messagePrefix, `${sourcePrefix}😀.js`, sourcePrefix],
])(
  "reports bounded runtime errors with %s before widget code, deduplicating and limiting reports",
  (_label, message, expectedMessage, source, expectedSource) => {
    const html = buildWidgetDocument("Failure", '<script>throw new Error("Broken")</script>');
    const bridge = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find((match) =>
      match[1]?.includes("openclaw:widget-runtime-error"),
    );
    if (!bridge?.[1]) {
      throw new Error("Runtime error bridge missing");
    }
    expect(bridge.index).toBeLessThan(html.indexOf('throw new Error("Broken")'));
    const handlers = new Map<string, (event: unknown) => void>();
    const postMessage = vi.fn();
    runInNewContext(bridge[1], {
      window: {
        parent: { postMessage },
        addEventListener: (type: string, handler: (event: unknown) => void, capture: boolean) => {
          expect(capture).toBe(true);
          handlers.set(type, handler);
        },
      },
    });
    const error = handlers.get("error")!;
    const rejection = handlers.get("unhandledrejection")!;
    error({ type: "error" }); // Resource-load Events have no script message or error.
    const reason = {
      get message() {
        throw new Error("getter");
      },
    };
    expect(() => rejection({ reason })).not.toThrow();
    error({
      error: { message },
      message: "fallback",
      filename: `https://example.test/path/${source}?private=1`,
      lineno: 12,
      colno: 7,
    });
    rejection({ reason: new Error(message) });
    rejection({ reason: new Error("Rejected"), lineno: Infinity, colno: 1.5 });
    rejection({ reason: "Plain rejection" });
    error({ message: "Over budget" });
    const report = (data: Record<string, unknown>) => [
      { type: "openclaw:widget-runtime-error", ...data },
      "*",
    ];
    expect(postMessage.mock.calls).toEqual([
      report({ message: expectedMessage, source: expectedSource, line: 12, column: 7 }),
      report({ message: "Rejected" }),
      report({ message: "Plain rejection" }),
    ]);
  },
);
it("keeps the wrapped document bytes stable", () => {
  const html = buildWidgetDocument(
    "Status <live>",
    '<SvG viewBox="0 0 10 10"><circle r="4" /></SvG>',
  );

  expect(html).toContain("--scrollbar-thumb-near:color-mix(in srgb,var(--muted) 16%,transparent)");
  expect(html).toContain("border:var(--scrollbar-thumb-inset,calc(var(--scrollbar-size)/4))");
  expect(Buffer.byteLength(html)).toBe(22932);
  expect(createHash("sha256").update(html).digest("hex")).toBe(
    "42f1cedcb7be244b69d9637f2e12db1f2589b8f7fefb67be6f044a28a74aaa03",
  );
});
// The host side reads port data through the pristine getter, so a widget
// override of MessageEvent.prototype.data only ever sees the wrapper's reads.
const messageData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")!;
async function bootWrappedWidget(
  body: string,
  prepare?: (frame: Window & typeof globalThis) => void,
) {
  // jsdom has no MessageChannel and drops transferred ports, so the real wrapper
  // gets Node's channel (and its MessageEvent) and the parent's postMessage
  // records its port offers.
  const dom = new JSDOM("<iframe></iframe>", { runScripts: "dangerously" });
  onTestFinished(() => dom.window.close());
  const offers: Array<{ type: string; port?: MessagePort; [key: string]: unknown }> = [];
  dom.window.postMessage = ((data: { type: string }, _origin: string, ports?: MessagePort[]) =>
    offers.push({ ...data, port: ports?.[0] })) as Window["postMessage"];
  const frame = dom.window.document.querySelector("iframe")!.contentWindow! as Window &
    typeof globalThis;
  Object.assign(frame, {
    MessageChannel,
    MessageEvent,
    CanvasRenderingContext2D: function CanvasRenderingContext2D() {},
    ResizeObserver: class {
      observe() {}
    },
  });
  const hostListeners: Array<(event: MessageEvent) => void> = [];
  const listen = frame.addEventListener.bind(frame);
  frame.addEventListener = ((type: string, handler: EventListener, options?: boolean) => {
    if (type === "message") {
      hostListeners.push(handler);
    }
    listen(type, handler, options);
  }) as typeof frame.addEventListener;
  prepare?.(frame);
  frame.document.open();
  frame.document.write(buildWidgetDocument("Links", body));
  frame.document.close();
  const port = offers.find((offer) => offer.type === "openclaw:widget-bridge-port-offer")!.port!;
  onTestFinished(() => port.close());
  const received: Array<{ type: string; method?: string }> = [];
  port.addEventListener("message", (event) => received.push(messageData.get!.call(event)));
  port.start();
  port.postMessage({ type: "openclaw:widget-host-init", ticket: "ticket" });
  await vi.waitFor(() => expect(received[0]?.type).toBe("openclaw:widget-host-init-ack"));
  const sendHostMessage = (data: unknown, source: unknown = frame.parent) => {
    const event = new MessageEvent("message", { data });
    Object.defineProperty(event, "source", { value: source });
    for (const handler of hostListeners) {
      handler(event);
    }
  };
  return { frame, port, received, offers, sendHostMessage };
}
it("never turns script-dispatched link clicks into host.open", async () => {
  const { frame, received } = await bootWrappedWidget(
    ["https://example.com/a", "javascript:alert(1)", "data:text/html,x"]
      .map((href, index) => `<a id="l${index}" target="_blank" href="${href}">${index}</a>`)
      .join(""),
  );
  const events: Event[] = [];
  for (const anchor of frame.document.querySelectorAll("a")) {
    anchor.click();
    for (const [type, button] of [
      ["click", 0],
      ["auxclick", 1],
    ] as const) {
      const event = new frame.MouseEvent(type, { bubbles: true, cancelable: true, button });
      anchor.dispatchEvent(event);
      events.push(event);
    }
  }
  // The same port stays live: a granted API request still reaches the host.
  void (
    frame as unknown as { openclaw: { state: { emit: (payload: unknown) => unknown } } }
  ).openclaw.state.emit({ live: true });
  await vi.waitFor(() => expect(received.at(-1)?.method).toBe("state.emit"));
  expect(received.map((message) => message.method ?? message.type)).toEqual([
    "openclaw:widget-host-init-ack",
    "state.emit",
  ]);
  expect(events.map((event) => event.defaultPrevented)).toEqual(events.map(() => false));
});
it("keeps its private bridge port from a widget's MessageEvent data override", async () => {
  const original = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")!;
  onTestFinished(() => {
    Object.defineProperty(MessageEvent.prototype, "data", original);
  });
  const { frame, port, received } = await bootWrappedWidget(
    "<script>window.stolen=[];" +
      'const original=Object.getOwnPropertyDescriptor(MessageEvent.prototype,"data");' +
      'Object.defineProperty(MessageEvent.prototype,"data",{configurable:true,' +
      "get(){const data=original.get.call(this);" +
      // Node's worker RPC shares this MessageEvent; keep only bridge traffic.
      'if(String(data?.type).startsWith("openclaw:"))window.stolen.push(this.target);return data;}});</script>',
  );
  const widget = frame as unknown as {
    stolen: unknown[];
    openclaw: { state: { emit: (payload: unknown) => Promise<unknown> } };
  };
  const emitted = widget.openclaw.state.emit({ live: true });
  await vi.waitFor(() => expect(received.at(-1)?.method).toBe("state.emit"));
  const { id } = received.at(-1) as unknown as { id: string };
  port.postMessage({ type: "openclaw:widget-bridge-response", id, ok: true, result: { ok: true } });
  await expect(emitted).resolves.toEqual({ ok: true });
  // The override is live in the widget realm, yet never saw the wrapper's port.
  const control = { type: "openclaw:control" };
  expect(new MessageEvent("message", { data: control }).data).toBe(control);
  expect(widget.stolen).toHaveLength(1);
  expect(widget.stolen[0]).toBeNull();
});

const previewControls: WidgetPreviewControl[] = [
  {
    id: "viewport",
    label: "Viewport",
    value: "desktop",
    options: [
      { value: "desktop", label: "Desktop" },
      { value: "mobile", label: "Mobile" },
    ],
  },
];
it("validates bounded preview selections at the host trust boundary", () => {
  expect(readWidgetPreviewControls([])).toEqual([]);
  expect(readWidgetPreviewControls(previewControls)).toEqual(previewControls);
  const bounded = Array.from({ length: 4 }, (_, index) => ({
    id: String(index).repeat(40),
    label: "l".repeat(80),
    value: "0".repeat(40),
    options: Array.from({ length: 8 }, (_value, option) => ({
      value: String(option).repeat(40),
      label: "l".repeat(80),
    })),
  }));
  expect(readWidgetPreviewControls(bounded)).toEqual(bounded);
  const control = previewControls[0]!;
  for (const invalid of [
    null,
    {},
    Array(5).fill(control),
    [control, control],
    [{ ...control, id: " " }],
    [{ ...control, id: "i".repeat(41) }],
    [{ ...control, label: "l".repeat(81) }],
    [{ ...control, value: "missing" }],
    [{ ...control, options: [] }],
    [{ ...control, options: Array(9).fill(control.options[0]) }],
    [{ ...control, options: [control.options[0], control.options[0]] }],
    [{ ...control, options: [{ value: "v".repeat(41), label: "Long value" }] }],
    [{ ...control, options: [{ value: "desktop", label: "l".repeat(81) }] }],
    [{ ...control, options: [{ value: "desktop", label: null }] }],
  ]) {
    expect(readWidgetPreviewControls(invalid)).toBeUndefined();
  }
});
it("keeps preview controls local, validates changes, and republishes retained selections", async () => {
  const { frame, offers, received, sendHostMessage } = await bootWrappedWidget("<p>Preview</p>");
  const widget = frame as unknown as {
    openclaw: {
      preview: {
        setControls: (
          controls: WidgetPreviewControl[],
          onChange: (change: { id: string; value: string }) => void,
        ) => void;
      };
    };
  };
  const onChange = vi.fn();
  const controls = structuredClone(previewControls);
  expect(Object.isFrozen(widget.openclaw.preview)).toBe(true);
  widget.openclaw.preview.setControls(controls, onChange);
  expect(offers.at(-1)).toMatchObject({
    type: "openclaw:widget-preview-controls",
    controls: previewControls,
  });
  // Mutating the caller's array cannot expand the published choices.
  controls[0]!.options.push({ value: "forged", label: "Forged" });
  const change = { type: "openclaw:widget-preview-change", id: "viewport", value: "mobile" };
  sendHostMessage(change, {});
  sendHostMessage({ ...change, id: "unknown" });
  sendHostMessage({ ...change, value: "forged" });
  expect(onChange).not.toHaveBeenCalled();
  const publications = offers.length;
  sendHostMessage(change);
  expect(offers).toHaveLength(publications + 1);
  expect(offers.at(-1)?.controls).toEqual([{ ...previewControls[0], value: "mobile" }]);
  expect(onChange.mock.calls).toEqual([[{ id: "viewport", value: "mobile" }]]);
  sendHostMessage({ type: "openclaw:widget-chat-host" });
  expect(offers.at(-1)?.controls).toEqual([{ ...previewControls[0], value: "mobile" }]);
  expect(received.map((message) => message.type)).toEqual(["openclaw:widget-host-init-ack"]);
  expect(() =>
    widget.openclaw.preview.setControls([{ ...previewControls[0]!, value: "missing" }], onChange),
  ).toThrow("invalid widget preview controls");
  widget.openclaw.preview.setControls([], onChange);
  sendHostMessage(change);
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(offers.at(-1)?.controls).toEqual([]);
});

it.each([false, true])(
  "captures live form/canvas state with optional element metadata (%s)",
  async (includeElements) => {
    let snapshotSvg = "";
    const { frame, offers, sendHostMessage } = await bootWrappedWidget(
      '<button id="target" class="one two three four" role="switch" aria-label="  Current   preview  ">Button</button>' +
        '<input id="entry" value="initial"><input id="check" type="checkbox" checked>' +
        '<input id="new-check" type="checkbox"><textarea>initial text</textarea>' +
        "<select><option selected>First</option><option>Second</option></select>" +
        '<canvas id="chart" width="40" height="20"></canvas>' +
        '<div style="display:none">Hidden</div><div id="zero">Empty box</div>' +
        "<style>.not-a-target { color: red }</style>" +
        "<span>Item</span>".repeat(510),
      (target) => {
        Object.defineProperties(target, { scrollX: { value: 20 }, scrollY: { value: 30 } });
        target.Element.prototype.getBoundingClientRect = function () {
          return new target.DOMRect(-4, 10, this.id === "zero" ? 0 : 40, 20);
        };
        const context = new target.CanvasRenderingContext2D();
        Object.defineProperty(target.CanvasRenderingContext2D.prototype, "fillStyle", { set() {} });
        target.CanvasRenderingContext2D.prototype.fillRect = vi.fn();
        target.CanvasRenderingContext2D.prototype.drawImage = vi.fn();
        vi.spyOn(target.HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
        vi.spyOn(target.HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (
          this: HTMLCanvasElement,
        ) {
          return this.id === "chart"
            ? "data:image/png;base64,Y2hhcnQ="
            : "data:image/png;base64,c25hcHNob3Q=";
        });
        const src = Object.getOwnPropertyDescriptor(target.HTMLImageElement.prototype, "src")!;
        Object.defineProperty(target.HTMLImageElement.prototype, "src", {
          ...src,
          set(value: string) {
            src.set!.call(this, value);
            if (value.startsWith("data:image/svg+xml;")) {
              snapshotSvg = decodeURIComponent(value.slice(value.indexOf(",") + 1));
              queueMicrotask(() => this.dispatchEvent(new target.Event("load")));
            }
          },
        });
      },
    );
    Object.defineProperties(frame.document.body, {
      scrollWidth: { value: 640 },
      scrollHeight: { value: 480 },
    });
    frame.document.querySelector<HTMLInputElement>("#entry")!.value = "typed <value>";
    frame.document.querySelector<HTMLInputElement>("#check")!.checked = false;
    frame.document.querySelector<HTMLInputElement>("#new-check")!.checked = true;
    frame.document.querySelector("textarea")!.value = "edited <text>";
    frame.document.querySelector("select")!.selectedIndex = 1;
    const request = { type: "openclaw:widget-snapshot-request", id: "capture", includeElements };
    sendHostMessage(request, {});
    expect(snapshotSvg).toBe("");
    sendHostMessage(request);
    await vi.waitFor(() => expect(offers.at(-1)?.type).toBe("openclaw:widget-snapshot"));
    expect(offers.at(-1)).toMatchObject({
      id: "capture",
      width: 640,
      height: 480,
      dataUrl: "data:image/png;base64,c25hcHNob3Q=",
    });
    const captured = new frame.DOMParser().parseFromString(snapshotSvg, "image/svg+xml");
    expect(captured.querySelector("parsererror")).toBeNull();
    expect(captured.querySelector("#entry")?.getAttribute("value")).toBe("typed <value>");
    expect(captured.querySelector("#check")?.hasAttribute("checked")).toBe(false);
    expect(captured.querySelector("#new-check")?.hasAttribute("checked")).toBe(true);
    expect(captured.querySelector("textarea")?.textContent).toBe("edited <text>");
    expect(
      [...captured.querySelectorAll("option")].map((option) => option.hasAttribute("selected")),
    ).toEqual([false, true]);
    expect(captured.querySelector("img#chart")?.getAttribute("src")).toBe(
      "data:image/png;base64,Y2hhcnQ=",
    );
    expect(captured.querySelector("canvas,script")).toBeNull();
    if (includeElements) {
      const elements = offers.at(-1)?.elements as Array<{ id: string; tag: string }>;
      expect(elements).toHaveLength(500);
      expect(elements[0]).toEqual({
        tag: "button",
        id: "target",
        classes: ["one", "two", "three"],
        name: "Current preview",
        role: "switch",
        focusable: true,
        rect: { x: 16, y: 40, width: 40, height: 20 },
      });
      expect(
        elements.some(
          (element) => ["script", "style"].includes(element.tag) || element.id === "zero",
        ),
      ).toBe(false);
    } else {
      expect(offers.at(-1)).not.toHaveProperty("elements");
    }
  },
);
