/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { LogsPage } from "./logs-page.tsx";

type TestGateway = ApplicationContext["gateway"] & {
  publish: (snapshot: ApplicationGatewaySnapshot) => void;
};
type TestContext = ApplicationContext & { gateway: TestGateway };

function contextWithClient(client: GatewayBrowserClient, connected = false): TestContext {
  let snapshot = {
    client,
    phase: connected ? "connected" : "stopped",
  } as ApplicationGatewaySnapshot;
  const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  return {
    basePath: "",
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      publish: (next: ApplicationGatewaySnapshot) => {
        snapshot = next;
        for (const listener of listeners) {
          listener(next);
        }
      },
    },
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as TestContext;
}

const disposers = new Set<() => void>();
function mountPage(initial: TestContext) {
  const container = document.createElement("div");
  document.body.append(container);
  const [context, setContext] = createSignal(initial);
  const liveContext = {
    ...initial,
    get gateway() {
      return context().gateway;
    },
  };
  const { unmount: dispose } = mountSolid(
    () => (
      <ApplicationProvider value={liveContext}>
        <LogsPage />
      </ApplicationProvider>
    ),
    { container },
  );
  disposers.add(dispose);
  return {
    container,
    replaceContext(next: TestContext) {
      setContext(next);
      flush();
    },
    dispose() {
      dispose();
      disposers.delete(dispose);
      container.remove();
    },
    lines: () => Array.from(container.querySelectorAll(".log-message"), (row) => row.textContent),
    refresh: () =>
      container.querySelector<HTMLButtonElement>(".settings-section__actions button")!.click(),
  };
}
async function settle() {
  await Promise.resolve();
  flush();
  await Promise.resolve();
  flush();
}
async function poll() {
  await vi.advanceTimersByTimeAsync(2_000);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});
afterEach(() => {
  for (const dispose of disposers) {
    dispose();
  }
  disposers.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("LogsPage lifecycle", () => {
  it.each([{ lines: [] }, { lines: ["initial log"] }])(
    "retains one initial request across metadata snapshots with $lines",
    async ({ lines }) => {
      const pending = deferred<{ cursor: number; file: string; lines: string[] }>();
      const request = vi.fn(
        (_method: string, _params: unknown, _options: { signal: AbortSignal }) => pending.promise,
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const context = contextWithClient(client);
      const page = mountPage(context);
      await settle();
      context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
      expect(request).toHaveBeenCalledOnce();
      const signal = request.mock.calls[0]![2].signal;
      context.gateway.publish({ ...context.gateway.snapshot });
      expect(request).toHaveBeenCalledOnce();
      expect(signal.aborted).toBe(false);

      pending.resolve({ cursor: 100, file: "/tmp/initial.log", lines });
      await settle();
      expect(page.lines()).toEqual(lines);
      context.gateway.publish({ ...context.gateway.snapshot });
      expect(request).toHaveBeenCalledOnce();

      request.mockResolvedValueOnce({ cursor: 110, file: "/tmp/initial.log", lines: ["poll"] });
      await poll();
      expect(request.mock.calls[1]![1]).toMatchObject({ cursor: 100 });
      expect(page.lines()).toEqual([...lines, "poll"]);

      request.mockResolvedValueOnce({ cursor: 120, file: "/tmp/initial.log", lines: ["manual"] });
      page.refresh();
      await settle();
      expect(page.lines()).toEqual(["manual"]);
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls[2]![1]).toMatchObject({ cursor: undefined });
    },
  );

  it.each(["reconnect", "source replacement", "client replacement", "detach/reattach"])(
    "replaces an unfinished initial request on %s and discards its response",
    async (transition) => {
      const replies: Array<ReturnType<typeof deferred<{ cursor: number; lines: string[] }>>> = [];
      const request = vi.fn(
        (_method: string, _params: unknown, _options: { signal: AbortSignal }) => {
          const reply = deferred<{ cursor: number; lines: string[] }>();
          replies.push(reply);
          return reply.promise;
        },
      );
      const client = { request } as unknown as GatewayBrowserClient;
      const context = contextWithClient(client, true);
      let page = mountPage(context);
      await settle();
      expect(request).toHaveBeenCalledOnce();
      const firstSignal = request.mock.calls[0]![2].signal;
      if (transition === "reconnect") {
        context.gateway.publish({ client, phase: "reconnecting" } as ApplicationGatewaySnapshot);
        context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
      } else if (transition === "client replacement") {
        context.gateway.publish({
          ...context.gateway.snapshot,
          client: { request } as unknown as GatewayBrowserClient,
        });
      } else if (transition === "source replacement") {
        page.replaceContext(contextWithClient(client, true));
      } else {
        page.dispose();
        page = mountPage(context);
      }
      await settle();
      expect(firstSignal.aborted).toBe(true);
      expect(request).toHaveBeenCalledTimes(2);
      context.gateway.publish({ ...context.gateway.snapshot });
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]![2].signal.aborted).toBe(false);

      replies[1]!.resolve({ cursor: 2, lines: ["current"] });
      await settle();
      expect(page.lines()).toEqual(["current"]);
      const requestFrame = vi.spyOn(window, "requestAnimationFrame");
      replies[0]!.resolve({ cursor: 1, lines: ["stale"] });
      await settle();
      expect(page.lines()).toEqual(["current"]);
      expect(requestFrame).not.toHaveBeenCalled();
    },
  );

  it("clears loaded rows, source, and cursor when the gateway provider changes", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ cursor: 42, file: "/old/provider.log", lines: ["old provider"] });
    const client = { request } as unknown as GatewayBrowserClient;
    const page = mountPage(contextWithClient(client, true));
    await settle();
    expect(page.lines()).toEqual(["old provider"]);
    expect(page.container.textContent).toContain("/old/provider.log");
    const replacement = contextWithClient(client);
    page.replaceContext(replacement);
    expect(page.lines()).toEqual([]);
    expect(page.container.textContent).not.toContain("/old/provider.log");
    request.mockResolvedValueOnce({
      cursor: 1,
      file: "/new/provider.log",
      lines: ["new provider"],
    });
    replacement.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    await settle();
    expect(request.mock.calls[1]?.[1]).toMatchObject({ cursor: undefined });
    expect(page.lines()).toEqual(["new provider"]);
  });

  it("keeps an initial error visible until the next poll succeeds", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("logs unavailable"));
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, true);
    const page = mountPage(context);
    await settle();
    expect(page.container.textContent).toContain("logs unavailable");
    expect(page.container.textContent).not.toContain("No log entries.");
    context.gateway.publish({ ...context.gateway.snapshot });
    expect(request).toHaveBeenCalledOnce();
    expect(page.container.querySelector(".logs-refresh-status button")).toBeNull();
    request.mockResolvedValueOnce({ cursor: 1, file: "/tmp/retry.log", lines: ["recovered"] });
    await poll();
    expect(page.lines()).toEqual(["recovered"]);
    expect(page.container.textContent).not.toContain("logs unavailable");
  });

  it.each(["detach", "disconnect", "source replacement"])(
    "discards a response after %s without scheduling scroll work",
    async (transition) => {
      const pending = deferred<{ cursor: number; lines: string[] }>();
      const request = vi.fn().mockReturnValue(pending.promise);
      const client = { request } as unknown as GatewayBrowserClient;
      const context = contextWithClient(client, true);
      const page = mountPage(context);
      await settle();
      if (transition === "detach") {
        page.dispose();
      } else if (transition === "disconnect") {
        context.gateway.publish({ client, phase: "stopped" } as ApplicationGatewaySnapshot);
      } else {
        page.replaceContext(contextWithClient(client));
      }
      const requestFrame = vi.spyOn(window, "requestAnimationFrame");
      pending.resolve({ cursor: 1, lines: ["stale"] });
      await settle();
      expect(page.lines()).toEqual([]);
      expect(requestFrame).not.toHaveBeenCalled();
    },
  );

  it("pauses polling while hidden and catches up once on reveal", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const request = vi.fn().mockResolvedValue({ cursor: 1, lines: [] });
    const page = mountPage(contextWithClient({ request } as unknown as GatewayBrowserClient, true));
    await settle();
    expect(request).toHaveBeenCalledOnce();
    await poll();
    expect(request).toHaveBeenCalledOnce();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await poll();
    expect(request).toHaveBeenCalledTimes(2);
    page.dispose();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await poll();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("serializes quiet polls so an older cursor cannot overwrite a newer one", async () => {
    const pending = deferred<{ cursor: number; lines: string[] }>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 1, lines: ["seed"] })
      .mockReturnValue(pending.promise);
    const page = mountPage(contextWithClient({ request } as unknown as GatewayBrowserClient, true));
    await settle();
    await poll();
    await poll();
    expect(request).toHaveBeenCalledTimes(2);
    expect(page.lines()).toEqual(["seed"]);
    pending.resolve({ cursor: 2, lines: ["fresh"] });
    await settle();
    expect(page.lines()).toEqual(["seed", "fresh"]);
    await poll();
    expect(request.mock.calls[2]![1]).toMatchObject({ cursor: 2 });
  });

  it("reloads a changed log file before publishing any rows from it", async () => {
    const reset = deferred<{ cursor: number; file: string; lines: string[] }>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 6, file: "/tmp/source-a.log", lines: ["A-one"] })
      .mockResolvedValueOnce({ cursor: 18, file: "/tmp/source-b.log", lines: ["B-tail"] })
      .mockReturnValueOnce(reset.promise);
    const page = mountPage(contextWithClient({ request } as unknown as GatewayBrowserClient, true));
    await settle();
    await poll();
    expect(page.lines()).toEqual(["A-one"]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ cursor: 6 });
    expect(request.mock.calls[2]?.[1]).toMatchObject({ cursor: undefined });
    reset.resolve({ cursor: 18, file: "/tmp/source-b.log", lines: ["B-one", "B-tail"] });
    await settle();
    expect(page.lines()).toEqual(["B-one", "B-tail"]);
    expect(page.container.textContent).toContain("/tmp/source-b.log");
  });

  it("retains loaded rows as stale after failure and clears the marker after retry", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 1, lines: ["old"] })
      .mockRejectedValueOnce(new Error("logs unavailable"))
      .mockResolvedValueOnce({ cursor: 2, lines: ["fresh"], reset: true });
    const page = mountPage(contextWithClient({ request } as unknown as GatewayBrowserClient, true));
    await settle();
    page.refresh();
    await settle();
    expect(page.lines()).toEqual(["old"]);
    expect(page.container.querySelector(".logs-refresh-status")?.textContent).toContain(
      "logs unavailable",
    );
    expect(page.container.querySelector(".logs-refresh-status")?.textContent).toContain(
      "Showing stale data",
    );
    page.refresh();
    await settle();
    expect(page.lines()).toEqual(["fresh"]);
    expect(page.container.querySelector(".logs-refresh-status")).toBeNull();
  });

  it("keeps text and level filters active as quiet polls append rows", async () => {
    const line = (message: string, level: string) =>
      JSON.stringify({
        message,
        _meta: { logLevelName: level },
      });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        cursor: 1,
        lines: [line("alpha info", "INFO"), line("alpha error", "ERROR"), line("beta", "INFO")],
      })
      .mockResolvedValueOnce({
        cursor: 2,
        lines: [line("alpha next", "ERROR"), line("beta next", "ERROR")],
      });
    const page = mountPage(contextWithClient({ request } as unknown as GatewayBrowserClient, true));
    await settle();
    const filter = page.container.querySelector<HTMLInputElement>(".settings-input")!;
    filter.value = "alpha";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(page.lines()).toEqual(["alpha info", "alpha error"]);
    page.container.querySelector<HTMLInputElement>(".log-chip.info input")!.click();
    flush();
    expect(page.lines()).toEqual(["alpha error"]);
    await poll();
    expect(filter.value).toBe("alpha");
    expect(page.lines()).toEqual(["alpha error", "alpha next"]);
  });

  it("forces a scroll when auto-follow is re-enabled away from the bottom", async () => {
    const request = vi.fn().mockResolvedValue({ cursor: 1, lines: ["one"] });
    const page = mountPage(contextWithClient({ request } as unknown as GatewayBrowserClient, true));
    await settle();
    const stream = page.container.querySelector<HTMLElement>(".log-stream")!;
    Object.defineProperties(stream, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
    const toggle = page.container.querySelector<HTMLInputElement>(
      ".settings-toggle input, input.settings-toggle",
    )!;
    toggle.click();
    flush();
    stream.scrollTop = 0;
    stream.dispatchEvent(new Event("scroll"));
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    toggle.click();
    flush();
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    expect(stream.scrollTop).toBe(500);
  });

  it("drops queued scroll work after a same-client reconnect", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 1, lines: ["one"] })
      .mockReturnValue(new Promise(() => {}));
    const client = { request } as unknown as GatewayBrowserClient;
    const context = contextWithClient(client, true);
    const page = mountPage(context);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    await settle();
    const stream = page.container.querySelector<HTMLElement>(".log-stream")!;
    Object.defineProperty(stream, "scrollHeight", { value: 500 });
    stream.scrollTop = 0;
    context.gateway.publish({ client, phase: "stopped" } as ApplicationGatewaySnapshot);
    context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    for (const frame of frames) {
      frame(0);
    }
    expect(stream.scrollTop).toBe(0);
  });
});
