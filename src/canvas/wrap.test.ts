// Widget document wrapper: byte stability and the host-bridge contract it emits.
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { buildWidgetDocument } from "./wrap.js";

describe("buildWidgetDocument", () => {
  it("reports bounded runtime errors before widget code, deduplicating and limiting reports", () => {
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
      error: { message: "x".repeat(600) },
      message: "fallback",
      filename: `https://example.test/path/${"s".repeat(220)}.js?private=1`,
      lineno: 12,
      colno: 7,
    });
    error({ message: "x".repeat(600) });
    rejection({ reason: new Error("Rejected"), lineno: Infinity, colno: 1.5 });
    rejection({ reason: "Plain rejection" });
    error({ message: "Over budget" });
    expect(postMessage.mock.calls).toEqual([
      [
        {
          type: "openclaw:widget-runtime-error",
          message: "x".repeat(500),
          source: "s".repeat(200),
          line: 12,
          column: 7,
        },
        "*",
      ],
      [{ type: "openclaw:widget-runtime-error", message: "Rejected" }, "*"],
      [{ type: "openclaw:widget-runtime-error", message: "Plain rejection" }, "*"],
    ]);
  });
  it("keeps the wrapped document bytes stable", () => {
    const html = buildWidgetDocument(
      "Status <live>",
      '<SvG viewBox="0 0 10 10"><circle r="4" /></SvG>',
    );

    expect(Buffer.byteLength(html)).toBe(19352);
    expect(createHash("sha256").update(html).digest("hex")).toBe(
      "c324c9aa8664217fe6a1668eb08fb525b23b46e5c8e3798132be32f9c14f2ddf",
    );
    expect(html).toContain("openclaw:widget-host-init-ack");
    expect(html).toContain('request("host.open",{url})');
    // Widget links follow the Control UI activation contract: primary click and
    // middle-button auxclick, on bubble so a widget's preventDefault still wins.
    expect(html).toContain('listen("click",activate);listen("auxclick",activate);');
    expect(html).toContain('event.type==="auxclick"&&event.button===1');
    expect(html).toContain("event.defaultPrevented||event.shiftKey||event.altKey");
    expect(html).not.toContain("{capture:true}");
    expect(html).toContain("controlUiBaseUrl");
    expect(html).toContain('define(host,"controlUiBaseUrl"');
    expect(html).toContain("else push.call(waiting,{send,reject})");
    expect(html).toContain("else push.call(promptWaiting,{send,inline,reject})");
    expect(html).toContain("openclaw:widget-prompt-host-ready");
    expect(html).toContain("widget host capabilities unavailable");
    expect(html).toContain("widget prompt host unavailable");
    expect(html).toContain("openclaw:widget-chat-host");
    expect(html).toContain("openclaw:widget-board-host");
    expect(html).toContain("openclaw:widget-scroll");
    expect(html).toContain("event.isTrusted");
    expect(html).not.toContain("widget is not hosted on a board");
    const bridgeKeys = JSON.parse(html.match(/const keys=(\[[^\]]+\])/)?.[1] ?? "[]") as string[];
    expect(bridgeKeys).toEqual([
      "surface",
      "card",
      "elevated",
      "text",
      "text-strong",
      "muted",
      "border",
      "border-strong",
      "accent",
      "accent-fill",
      "accent-fg",
      "ok",
      "warn",
      "danger",
      "info",
      "radius",
      "radius-full",
      "scrollbar-size",
      "scrollbar-thumb-inset",
      "scrollbar-thumb",
      "scrollbar-thumb-hover",
      "font-body",
      "font-mono",
    ]);
  });
});
