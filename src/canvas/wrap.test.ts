// Widget document wrapper: byte stability and the host-bridge contract it emits.
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildWidgetDocument } from "./wrap.js";

describe("buildWidgetDocument", () => {
  it.each([
    {
      label: "ASCII limits",
      message: "x".repeat(600),
      expectedMessage: "x".repeat(500),
      source: `${"s".repeat(220)}.js`,
      expectedSource: "s".repeat(200),
    },
    {
      label: "short Unicode",
      message: "Ready 😀",
      expectedMessage: "Ready 😀",
      source: "ready😀.js",
      expectedSource: "ready😀.js",
    },
    {
      label: "surrogate message and source boundaries",
      message: `${"x".repeat(499)}😀tail`,
      expectedMessage: "x".repeat(499),
      source: `${"s".repeat(199)}😀.js`,
      expectedSource: "s".repeat(199),
    },
  ])(
    "reports bounded runtime errors with $label before widget code, deduplicating and limiting reports",
    ({ message, expectedMessage, source, expectedSource }) => {
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
      expect(() =>
        rejection({
          reason: {
            get message() {
              throw new Error("getter");
            },
          },
        }),
      ).not.toThrow();
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
      expect(postMessage.mock.calls).toEqual([
        [
          {
            type: "openclaw:widget-runtime-error",
            message: expectedMessage,
            source: expectedSource,
            line: 12,
            column: 7,
          },
          "*",
        ],
        [{ type: "openclaw:widget-runtime-error", message: "Rejected" }, "*"],
        [{ type: "openclaw:widget-runtime-error", message: "Plain rejection" }, "*"],
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
});
