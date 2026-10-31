import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { expect, it, onTestFinished, vi } from "vitest";
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

  expect(Buffer.byteLength(html)).toBe(17895);
  expect(createHash("sha256").update(html).digest("hex")).toBe(
    "d24f2ef46f994f7c099512e4b17b03d79cd539b0e11a66e68604c245f9d7be24",
  );
});
// The host side reads port data through the pristine getter, so a widget
// override of MessageEvent.prototype.data only ever sees the wrapper's reads.
const messageData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data")!;
async function bootWrappedWidget(body: string) {
  // jsdom has no MessageChannel and drops transferred ports, so the real wrapper
  // gets Node's channel (and its MessageEvent) and the parent's postMessage
  // records its port offers.
  const dom = new JSDOM("<iframe></iframe>", { runScripts: "dangerously" });
  onTestFinished(() => dom.window.close());
  const offers: Array<{ type: string; port?: MessagePort }> = [];
  dom.window.postMessage = ((data: { type: string }, _origin: string, ports?: MessagePort[]) =>
    offers.push({ type: data.type, port: ports?.[0] })) as Window["postMessage"];
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
  return { frame, port, received };
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
