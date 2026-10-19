/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { LogsPage } from "./logs-page.tsx";

type TestGateway = ApplicationContext["gateway"] & {
  publish: (snapshot: ApplicationGatewaySnapshot) => void;
};
type TestContext = ApplicationContext & { gateway: TestGateway };

function contextWithClient(
  client: GatewayBrowserClient,
  connected = false,
  bootId?: string,
): TestContext {
  const { gateway, publish } = createApplicationGateway({
    client,
    phase: connected ? "connected" : "stopped",
    hello: bootId === undefined ? undefined : { server: { bootId } },
  } as ApplicationGatewaySnapshot);
  return {
    basePath: "",
    gateway: Object.assign(gateway, { publish }),
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as TestContext;
}

function mountPage(initial: TestContext) {
  const [context, setContext] = createSignal(initial);
  const liveContext = {
    ...initial,
    get gateway() {
      return context().gateway;
    },
  };
  const { container, unmount: dispose } = mountSolid(() => (
    <ApplicationProvider value={liveContext}>
      <LogsPage />
    </ApplicationProvider>
  ));
  const query = <T extends Element = HTMLElement>(selector: string) =>
    container.querySelector<T>(selector);
  return {
    container,
    query,
    replaceContext(next: TestContext) {
      setContext(next);
      flush();
    },
    dispose,
    lines: () => Array.from(container.querySelectorAll(".log-message"), (row) => row.textContent),
    refresh: () => query<HTMLButtonElement>(".settings-section__actions button")!.click(),
  };
}
function setup<T>(request: T, connected = true, bootId?: string) {
  const client = { request } as unknown as GatewayBrowserClient;
  const context = contextWithClient(client, connected, bootId);
  return { client, context, page: mountPage(context) };
}
function tail(cursor: number, lines: string[], file?: string) {
  return { cursor, lines, file };
}
function responding(...payloads: ReturnType<typeof tail>[]) {
  return payloads.reduce((request, payload) => request.mockResolvedValueOnce(payload), vi.fn());
}
function captureFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
  return frames;
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
  cleanupSolid();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("LogsPage lifecycle", () => {
  it("retains one initial request across metadata snapshots with empty logs", async () => {
    const pending = deferred<ReturnType<typeof tail>>();
    const request = vi.fn(
      (_method: string, _params: unknown, _options: { signal: AbortSignal }) => pending.promise,
    );
    const { client, context, page } = setup(request, false);
    await settle();
    context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    expect(request).toHaveBeenCalledOnce();
    const signal = request.mock.calls[0]![2].signal;
    context.gateway.publish({ ...context.gateway.snapshot });
    expect(request).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);

    pending.resolve(tail(100, [], "/tmp/initial.log"));
    await settle();
    expect(page.lines()).toEqual([]);
    context.gateway.publish({ ...context.gateway.snapshot });
    expect(request).toHaveBeenCalledOnce();

    request.mockResolvedValueOnce(tail(110, ["poll"], "/tmp/initial.log"));
    await poll();
    expect(request.mock.calls[1]![1]).toMatchObject({ cursor: 100 });
    expect(page.lines()).toEqual(["poll"]);

    request.mockResolvedValueOnce(tail(120, ["manual"], "/tmp/initial.log"));
    page.refresh();
    await settle();
    expect(page.lines()).toEqual(["manual"]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]![1]).toMatchObject({ cursor: undefined });
  });

  it.each(["reconnect", "source replacement", "client replacement", "detach/reattach"])(
    "replaces an unfinished initial request on %s and discards its response",
    async (transition) => {
      const replies: Array<ReturnType<typeof deferred<ReturnType<typeof tail>>>> = [];
      const request = vi.fn(
        (_method: string, _params: unknown, _options: { signal: AbortSignal }) => {
          const reply = deferred<ReturnType<typeof tail>>();
          replies.push(reply);
          return reply.promise;
        },
      );
      const { client, context, page: initialPage } = setup(request);
      let page = initialPage;
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

      replies[1]!.resolve(tail(2, ["current"]));
      await settle();
      expect(page.lines()).toEqual(["current"]);
      const requestFrame = vi.spyOn(window, "requestAnimationFrame");
      replies[0]!.resolve(tail(1, ["stale"]));
      await settle();
      expect(page.lines()).toEqual(["current"]);
      expect(requestFrame).not.toHaveBeenCalled();
    },
  );

  it("resumes the loaded cursor after a same-gateway reconnect", async () => {
    const request = responding(
      tail(100, ["before"], "/tmp/gateway.log"),
      tail(110, ["after"], "/tmp/gateway.log"),
    );
    const { context, page } = setup(request, true, "same-boot");
    await settle();
    expect(page.lines()).toEqual(["before"]);

    context.gateway.publish({ ...context.gateway.snapshot, phase: "reconnecting" });
    context.gateway.publish({ ...context.gateway.snapshot, phase: "connected" });
    await settle();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![1]).toMatchObject({ cursor: 100 });
    expect(page.lines()).toEqual(["before", "after"]);
  });

  it("retries a changed boot from the start while retaining stale rows until replacement", async () => {
    const pending = deferred<ReturnType<typeof tail>>();
    const request = responding(tail(100, ["before"], "/tmp/gateway.log"))
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(tail(200, ["restarted"], "/tmp/gateway.log"));
    const { context, page } = setup(request, true, "original-boot");
    await settle();

    context.gateway.publish({ ...context.gateway.snapshot, phase: "reconnecting" });
    // SAFETY: This focused snapshot fixture supplies only the hello boot field read by LogsPage.
    context.gateway.publish({
      ...context.gateway.snapshot,
      phase: "connected",
      hello: { server: { bootId: "replacement-boot" } },
    } as ApplicationGatewaySnapshot);
    await settle();
    expect(request.mock.calls[1]![1]).toMatchObject({ cursor: undefined });
    expect(page.lines()).toEqual(["before"]);

    pending.reject(new Error("replacement boot is not ready"));
    await settle();
    expect(page.lines()).toEqual(["before"]);
    expect(page.container.textContent).toContain("replacement boot is not ready");

    await poll();
    expect(request.mock.calls[2]![1]).toMatchObject({ cursor: undefined });
    expect(page.lines()).toEqual(["restarted"]);
    expect(page.container.textContent).not.toContain("replacement boot is not ready");
  });

  it("clears loaded rows, source, and cursor when the gateway provider changes", async () => {
    const request = vi.fn().mockResolvedValue(tail(42, ["old provider"], "/old/provider.log"));
    const { client, page } = setup(request);
    await settle();
    expect(page.lines()).toEqual(["old provider"]);
    expect(page.container.textContent).toContain("/old/provider.log");
    const replacement = contextWithClient(client);
    page.replaceContext(replacement);
    expect(page.lines()).toEqual([]);
    expect(page.container.textContent).not.toContain("/old/provider.log");
    request.mockResolvedValueOnce(tail(1, ["new provider"], "/new/provider.log"));
    replacement.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
    await settle();
    expect(request.mock.calls[1]?.[1]).toMatchObject({ cursor: undefined });
    expect(page.lines()).toEqual(["new provider"]);
  });

  it("keeps an initial error visible until the next poll succeeds", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("logs unavailable"));
    const { context, page } = setup(request);
    await settle();
    expect(page.container.textContent).toContain("logs unavailable");
    expect(page.container.textContent).not.toContain("No log entries.");
    context.gateway.publish({ ...context.gateway.snapshot });
    expect(request).toHaveBeenCalledOnce();
    expect(page.query(".logs-refresh-status button")).toBeNull();
    request.mockResolvedValueOnce(tail(1, ["recovered"], "/tmp/retry.log"));
    await poll();
    expect(page.lines()).toEqual(["recovered"]);
    expect(page.container.textContent).not.toContain("logs unavailable");
  });

  it("pauses polling while hidden and catches up once on reveal", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const request = vi.fn().mockResolvedValue(tail(1, []));
    const { page } = setup(request);
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
    const pending = deferred<ReturnType<typeof tail>>();
    const request = responding(tail(1, ["seed"])).mockReturnValue(pending.promise);
    const { page } = setup(request);
    await settle();
    await poll();
    await poll();
    expect(request).toHaveBeenCalledTimes(2);
    expect(page.lines()).toEqual(["seed"]);
    pending.resolve(tail(2, ["fresh"]));
    await settle();
    expect(page.lines()).toEqual(["seed", "fresh"]);
    await poll();
    expect(request.mock.calls[2]![1]).toMatchObject({ cursor: 2 });
  });

  it("reloads a changed log file before publishing any rows from it", async () => {
    const reset = deferred<ReturnType<typeof tail>>();
    const request = responding(
      tail(6, ["A-one"], "/tmp/source-a.log"),
      tail(18, ["B-tail"], "/tmp/source-b.log"),
    ).mockReturnValueOnce(reset.promise);
    const { page } = setup(request);
    await settle();
    await poll();
    expect(page.lines()).toEqual(["A-one"]);
    expect(request.mock.calls[1]?.[1]).toMatchObject({ cursor: 6 });
    expect(request.mock.calls[2]?.[1]).toMatchObject({ cursor: undefined });
    reset.resolve(tail(18, ["B-one", "B-tail"], "/tmp/source-b.log"));
    await settle();
    expect(page.lines()).toEqual(["B-one", "B-tail"]);
    expect(page.container.textContent).toContain("/tmp/source-b.log");
  });

  it("retains loaded rows as stale after failure and clears the marker after retry", async () => {
    const request = responding(tail(1, ["old"]))
      .mockRejectedValueOnce(new Error("logs unavailable"))
      .mockResolvedValueOnce({ ...tail(2, ["fresh"]), reset: true });
    const { page } = setup(request);
    await settle();
    page.refresh();
    await settle();
    expect(page.lines()).toEqual(["old"]);
    const status = page.query(".logs-refresh-status")?.textContent;
    expect(status).toContain("logs unavailable");
    expect(status).toContain("Showing stale data");
    page.refresh();
    await settle();
    expect(page.lines()).toEqual(["fresh"]);
    expect(page.query(".logs-refresh-status")).toBeNull();
  });

  it("keeps text and level filters active as quiet polls append rows", async () => {
    const line = (message: string, level: string) =>
      JSON.stringify({ message, _meta: { logLevelName: level } });
    const request = responding(
      tail(1, [line("alpha info", "INFO"), line("alpha error", "ERROR"), line("beta", "INFO")]),
      tail(2, [line("alpha next", "ERROR"), line("beta next", "ERROR")]),
    );
    const { page } = setup(request);
    await settle();
    const filter = page.query<HTMLInputElement>(".settings-input")!;
    filter.value = "alpha";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(page.lines()).toEqual(["alpha info", "alpha error"]);
    page.query<HTMLInputElement>(".log-chip.info input")!.click();
    flush();
    expect(page.lines()).toEqual(["alpha error"]);
    await poll();
    expect(filter.value).toBe("alpha");
    expect(page.lines()).toEqual(["alpha error", "alpha next"]);
  });

  it("forces a scroll when auto-follow is re-enabled away from the bottom", async () => {
    const { page } = setup(vi.fn().mockResolvedValue(tail(1, ["one"])));
    await settle();
    const stream = page.query(".log-stream")!;
    Object.defineProperties(stream, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
    const toggle = page.query<HTMLInputElement>(".settings-toggle input, input.settings-toggle")!;
    toggle.click();
    flush();
    stream.scrollTop = 0;
    stream.dispatchEvent(new Event("scroll"));
    const frames = captureFrames();
    toggle.click();
    flush();
    expect(frames).toHaveLength(1);
    frames[0]!(0);
    expect(stream.scrollTop).toBe(500);
  });

  it("drops queued scroll work after a same-client reconnect", async () => {
    const request = responding(tail(1, ["one"])).mockReturnValue(new Promise(() => {}));
    const { client, context, page } = setup(request);
    const frames = captureFrames();
    await settle();
    const stream = page.query(".log-stream")!;
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
