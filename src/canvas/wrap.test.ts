import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
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

  expect(Buffer.byteLength(html)).toBe(17765);
  expect(createHash("sha256").update(html).digest("hex")).toBe(
    "e8c709f66c308ddf94d310ad2a29375a1edff39b9d82328464146045640e72f0",
  );
});
