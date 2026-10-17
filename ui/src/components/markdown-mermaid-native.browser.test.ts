import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import "../../../packages/mermaid-renderer/src/native.ts";
import { parsePassiveSvg, theme } from "./markdown-mermaid.test-support.ts";

type NativeReply = {
  id: string;
  success: boolean;
  svg?: string;
  widthCssPx?: number;
  heightCssPx?: number;
  error?: string;
  retryable?: boolean;
};

let replies: NativeReply[];
let diagram: HTMLElement;

const render = (id: string, source: string, widthCssPx = 320) =>
  window.renderMermaid({ id, source, widthCssPx, theme });
async function expectRecovery(source: string, index: number) {
  await render("recovered", source);
  expect(replies[index]).toMatchObject({ id: "recovered", success: true, widthCssPx: 320 });
  expect(diagram.querySelector("img")?.complete).toBe(true);
}

beforeEach(() => {
  replies = [];
  diagram = document.createElement("div");
  diagram.id = "diagram";
  document.body.append(diagram);
  window.ChatMermaidBridge = {
    postMessage(message) {
      replies.push(JSON.parse(message) as NativeReply);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.dispatchEvent(new PageTransitionEvent("pagehide"));
  delete window.ChatMermaidBridge;
  diagram.remove();
});

describe("native Mermaid document", () => {
  it("delivers ordered passive images at the requested viewport width", async () => {
    await Promise.all([
      render("first", "flowchart LR\nA[First] --> B[Diagram]", 512),
      render("second", "sequenceDiagram\nAlice->>Bob: Ready", 384),
    ]);
    expect(replies.map((reply) => [reply.id, reply.success, reply.widthCssPx])).toEqual([
      ["first", true, 512],
      ["second", true, 384],
    ]);
    for (const reply of replies) {
      expect(reply.heightCssPx).toBeGreaterThan(0);
      parsePassiveSvg(reply.svg!);
    }
    const image = diagram.querySelector("img")!;
    expect(image).toMatchObject({ complete: true, width: 384 });
    expect(image.naturalWidth).toBeGreaterThan(0);
    const frame = document.querySelector<HTMLIFrameElement>("iframe[sandbox='allow-scripts']")!;
    expect(frame.contentDocument).toBeNull();
  });

  it("keeps syntax and raster-limit failures permanent and renders the next request", async () => {
    const source = "flowchart TB\nA[One] --> B[Two] --> C[Three]";
    await render("oversized", source, 4_096);
    expect(replies).toEqual([
      { id: "oversized", success: false, error: "Diagram image is too large.", retryable: false },
    ]);
    expect(diagram.querySelector("img")).toBeNull();
    await render("invalid", "flowchart LR\nA -->");
    expect(replies[1]).toMatchObject({ id: "invalid", success: false, retryable: false });
    await expectRecovery(source, 2);
  });

  it.each(["engine load", "engine render", "image decode"])(
    "reports %s timeouts as retryable and recovers on the next request",
    async (boundary) => {
      const source = "flowchart LR\nA[Waiting] --> B[Ready]";
      const deadline = boundary === "image decode" ? 5_000 : 15_000;
      const stalled = createDeferred();
      const decoding = createDeferred();
      if (boundary === "engine load") {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc")!;
        vi.spyOn(HTMLIFrameElement.prototype, "srcdoc", "set").mockImplementation(function (
          this: HTMLIFrameElement,
        ) {
          descriptor.set!.call(this, "<!doctype html><html></html>");
          stalled.resolve();
        });
      } else if (boundary === "engine render") {
        // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves each port's receiver.
        const postMessage = MessagePort.prototype.postMessage;
        vi.spyOn(MessagePort.prototype, "postMessage").mockImplementation(function (
          this: MessagePort,
          ...args
        ) {
          if (asRecord(args[0]).source === source) {
            stalled.resolve();
          } else {
            Reflect.apply(postMessage, this, args);
          }
        });
      } else {
        vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementationOnce(() => {
          stalled.resolve();
          return decoding.promise;
        });
      }

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const schedule = vi.spyOn(window, "setTimeout");
      let settled = false;
      let pending: Promise<void> | undefined;
      try {
        pending = render("timeout", source).finally(() => {
          settled = true;
        });
        // Load/decode arm their watchdog after the intercepted call returns.
        // Awaiting the stall lets that synchronous registration finish.
        await stalled.promise;
        expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), deadline);
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(deadline - 1);
        expect(settled).toBe(false);
        expect(replies).toEqual([]);
        expect(diagram.querySelector("img")).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        await pending;
        expect(replies[0]).toMatchObject({ id: "timeout", success: false, retryable: true });
        expect(diagram.querySelector("img")).toBeNull();
      } finally {
        try {
          // A failed assertion must not strand the serialized native decode queue.
          decoding.resolve();
          if (pending && !settled) {
            window.dispatchEvent(new PageTransitionEvent("pagehide"));
            await pending;
          }
        } finally {
          vi.restoreAllMocks();
          vi.useRealTimers();
        }
      }
      await expectRecovery(source, 1);
    },
    30_000,
  );

  it("reports an unavailable image decoder as retryable without retaining the failure", async () => {
    vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValueOnce(
      new DOMException("Image decoder unavailable", "EncodingError"),
    );
    const source = "flowchart LR\nA --> B";
    await render("decode", source);
    expect(replies[0]).toMatchObject({ id: "decode", success: false, retryable: true });
    expect(diagram.querySelector("img")).toBeNull();
    await expectRecovery(source, 1);
  });

  it("keeps native error replies valid at a UTF-16 boundary", async () => {
    const prefix = "x".repeat(999);
    vi.spyOn(HTMLImageElement.prototype, "decode").mockRejectedValueOnce(new Error(`${prefix}🤖`));

    await render("unicode-error", "flowchart LR\nA --> B");

    expect(replies[0]).toMatchObject({
      id: "unicode-error",
      success: false,
      retryable: true,
      error: prefix,
    });
  });
});
