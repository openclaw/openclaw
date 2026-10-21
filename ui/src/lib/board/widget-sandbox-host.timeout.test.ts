import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardWidget } from "./types.ts";
import { BoardWidgetSandboxHost } from "./widget-sandbox-host.ts";

const SANDBOX_URL = "https://sandbox.example/mcp-app-sandbox";

function widget(viewGeneration = "a".repeat(32)): BoardWidget {
  return {
    name: "weather",
    tabId: "main",
    contentKind: "html",
    sizeW: 6,
    sizeH: 4,
    position: 0,
    grantState: "granted",
    revision: 2,
    viewTicket: "ticket",
    viewGeneration,
  };
}

function createHost(waitForRender = false, deferReady = false) {
  const frame = document.createElement("iframe");
  if (deferReady) {
    frame.src = SANDBOX_URL;
  }
  document.body.append(frame);
  const onError = vi.fn();
  const onLoadFailed = deferReady ? onError : vi.fn();
  const onLoaded = vi.fn();
  const options = {
    frame,
    widget: widget(),
    documentActive: true,
    sandboxOrigin: "https://sandbox.example",
    sandboxUrl: SANDBOX_URL,
    sourceOrigin: "https://gateway.example",
    resolveFrameUrl: () => (deferReady ? "/widget" : "/widget?generation=first"),
    confirmPrompt: () => true,
    onFrameUrl: vi.fn(),
    onLoadFailed,
    onUnauthorized: deferReady ? onError : vi.fn(),
    onReadyTimeout: deferReady ? onError : vi.fn(),
    onLoaded,
    onRendered: waitForRender ? vi.fn() : undefined,
    onPending: deferReady ? vi.fn() : undefined,
    onError,
  };
  const host = new BoardWidgetSandboxHost(options);
  const notify = (method: string, params: Record<string, unknown>) =>
    host.handleMessage(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "https://sandbox.example",
        data: { method: `ui/notifications/sandbox-${method}`, params },
      }),
    );
  const ready = () => notify("proxy-ready", { sandboxUrl: SANDBOX_URL });
  if (!deferReady) {
    ready();
  }
  return { host, onLoadFailed, onLoaded, options, frame, ready, notify };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("BoardWidgetSandboxHost document timeout", () => {
  it.each(["headers", "body", "render"] as const)(
    "times out stalled %s delivery",
    async (phase) => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          if (phase === "render") {
            return Promise.resolve(new Response("<!doctype html><p>Waiting for a resource</p>"));
          }
          const signal = init?.signal;
          if (phase === "headers") {
            return new Promise<Response>((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("request aborted")));
            });
          }
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("<!doctype html>"));
                  signal?.addEventListener("abort", () =>
                    controller.error(new Error("body aborted")),
                  );
                },
              }),
            ),
          );
        }),
      );
      const { host, onLoadFailed, onLoaded, options } = createHost(phase === "render");

      await vi.advanceTimersByTimeAsync(30_000);

      if (phase === "render") {
        expect(onLoadFailed).not.toHaveBeenCalled();
        expect(options.onError).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining("did not finish loading") }),
        );
      } else {
        expect(onLoadFailed).toHaveBeenCalledWith(widget());
        expect(onLoadFailed).toHaveBeenCalledOnce();
      }
      expect(onLoaded).toHaveBeenCalledTimes(phase === "render" ? 1 : 0);
      host.dispose();
    },
  );

  it.each(["document", "proxy", "render"] as const)(
    "keeps a slow %s load alive beyond the notice threshold",
    async (phase) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async () => {
        if (phase === "document") {
          await new Promise((resolve) => {
            window.setTimeout(resolve, 15_000);
          });
        }
        return new Response("<p>Slow success</p>");
      });
      vi.stubGlobal("fetch", fetchMock);
      const { host, frame, ready, notify, onLoaded, options } = createHost(
        phase === "render",
        true,
      );
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      if (phase !== "proxy") {
        ready();
      }
      const reload = vi.spyOn(frame, "src", "set");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(options.onPending).toHaveBeenCalled();
      expect(options.onError).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5_000);
      if (phase === "proxy") {
        ready();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(onLoaded).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
      if (phase === "render") {
        const delivery = post.mock.calls.find(
          ([data]) => data.method === "ui/notifications/sandbox-resource-ready",
        )![0];
        notify("resource-loaded", { renderId: delivery.params.renderId });
        expect(options.onRendered).toHaveBeenCalledOnce();
      }
      expect(reload).not.toHaveBeenCalled();
      host.dispose();
    },
  );

  it.each(["generation", "client"] as const)(
    "keeps a replacement document after a %s change cancels a stalled load",
    async (change) => {
      vi.useFakeTimers();
      let firstSignal: AbortSignal | undefined;
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (fetchMock.mock.calls.length === 1) {
          firstSignal = init?.signal ?? undefined;
          return new Promise<Response>((_resolve, reject) => {
            firstSignal?.addEventListener("abort", () => reject(new Error("request aborted")));
          });
        }
        return Promise.resolve(new Response("<!doctype html><p>replacement</p>"));
      });
      vi.stubGlobal("fetch", fetchMock);
      const { host, onLoadFailed, onLoaded, options } = createHost();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

      host.update({
        ...options,
        ...(change === "generation"
          ? { widget: widget("b".repeat(32)) }
          : { client: { request: vi.fn(async () => ({ ok: true })) } }),
        resolveFrameUrl: () => "/widget?generation=replacement",
      });
      await vi.waitFor(() => expect(onLoaded).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(10_000);

      expect(firstSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onLoadFailed).not.toHaveBeenCalled();
      expect(onLoaded).toHaveBeenCalledOnce();
      host.dispose();
    },
  );
});
