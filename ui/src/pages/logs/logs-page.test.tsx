/* @vitest-environment jsdom */

import { getQueriesForElement } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { downloadTextFile } from "../../lib/download.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { missingReadScopeErrorFixture } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { installLogsViewport } from "./logs-layout.test-support.ts";
import { renderSolid as LogsRoute } from "./logs-page.tsx";

vi.mock("../../lib/download.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/download.ts")>()),
  downloadTextFile: vi.fn(),
}));

type TestContext = ReturnType<typeof contextWithClient>;
const TRUNCATION_NOTICE = "Log output truncated; showing latest chunk.";

function contextWithClient(client: GatewayBrowserClient, connected = false, bootId?: string) {
  const { gateway, publish } = createApplicationGateway({
    client,
    phase: connected ? "connected" : "stopped",
    hello: bootId === undefined ? undefined : { server: { bootId } },
  } as ApplicationGatewaySnapshot);
  return { gateway: Object.assign(gateway, { publish }) };
}

function mountPage(initial: TestContext) {
  const [context, setContext] = createSignal(initial);
  const liveContext = {
    get gateway() {
      return context().gateway;
    },
  };
  const { container, unmount: dispose } = mountSolid(() => (
    <ApplicationProvider value={liveContext as unknown as ApplicationContext}>
      <LogsRoute />
    </ApplicationProvider>
  ));
  const query = (selector: string) => container.querySelector<HTMLElement>(selector);
  const lines = () =>
    Array.from(container.querySelectorAll(".log-message"), (row) => row.textContent);
  return {
    container,
    query,
    text: () => container.textContent,
    disabled: (name: string) =>
      getQueriesForElement(container).getByRole("button", { name }).hasAttribute("disabled"),
    expectRows(expected: (string | null)[], truncated?: boolean) {
      expect(lines()).toEqual(expected);
      if (truncated !== undefined) {
        expect(container.textContent?.includes(TRUNCATION_NOTICE)).toBe(truncated);
      }
    },
    replaceContext(next: TestContext) {
      setContext(next);
      flush();
    },
    dispose,
    lines,
    async refresh() {
      query(".settings-section__actions button")!.click();
      await settle();
    },
  };
}
async function setup<T>(request: T, connected = true, bootId?: string) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const client = { request } as unknown as GatewayBrowserClient;
  const context = contextWithClient(client, connected, bootId);
  const page = mountPage(context);
  await settle();
  return { client, context, page, request };
}
function tail(cursor: number, lines: string[], file?: string, truncated = false, reset = false) {
  return { cursor, lines, file, truncated, reset };
}
function responding(...payloads: ReturnType<typeof tail>[]) {
  return payloads.reduce((request, payload) => request.mockResolvedValueOnce(payload), vi.fn());
}
function pendingRequests() {
  const replies: Array<ReturnType<typeof deferred<ReturnType<typeof tail>>>> = [];
  const request = vi.fn((_method: string, _params: unknown, _options: { signal: AbortSignal }) => {
    const reply = deferred<ReturnType<typeof tail>>();
    replies.push(reply);
    return reply.promise;
  });
  return { request, replies };
}
function reconnect(context: TestContext, next = context.gateway.snapshot) {
  context.gateway.publish({ ...context.gateway.snapshot, phase: "reconnecting" });
  context.gateway.publish({ ...next, phase: "connected" });
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
async function deliver<T>(reply: { resolve(value: T): void }, value: T) {
  reply.resolve(value);
  await settle();
}
async function poll() {
  await vi.advanceTimersByTimeAsync(2_000);
  await settle();
}

beforeEach(installLogsViewport);

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("names the page with a level-one heading", async () => {
  const { page } = await setup(vi.fn().mockResolvedValue(tail(1, ["one"])));
  expect(getQueriesForElement(page.container).getByRole("heading", { level: 1 }).textContent).toBe(
    "Logs",
  );
});

it("exports the retained buffer and warns only after old rows are evicted", async () => {
  const lines = Array.from({ length: 2001 }, (_, index) => `line ${index + 1}`);
  let cursor = 0;
  const request = vi.fn(async () => {
    const pageLines = lines.slice(cursor, cursor + 500);
    cursor += pageLines.length;
    return tail(cursor, pageLines, "/tmp/buffer.log");
  });
  const { page } = await setup(request);
  const expectExport = (expected: string[]) => {
    page.container
      .querySelectorAll<HTMLButtonElement>(".settings-section__actions button")[1]!
      .click();
    expect(downloadTextFile).toHaveBeenLastCalledWith(
      expect.any(String),
      `${expected.join("\n")}\n`,
    );
  };
  for (const count of [1000, 1500, 2000]) {
    await poll();
    expectExport(lines.slice(0, count));
    expect(page.text()).not.toContain(TRUNCATION_NOTICE);
  }
  await poll();
  const retained = lines.slice(1);
  expectExport(retained);
  expect(page.text()).toContain(TRUNCATION_NOTICE);
  await poll();
  expectExport(retained);
  expect(page.text()).toContain(TRUNCATION_NOTICE);
});

it.each([false, true])("clears truncation on replacement (server reset: %s)", async (reset) => {
  const { request, page } = await setup(
    responding(
      tail(100, ["old tail"], "/log", true),
      tail(110, ["next line"], "/log"),
      tail(150, ["complete replacement"], "/log", false, reset),
    ),
  );
  page.expectRows(["old tail"], true);
  await poll();
  page.expectRows(["old tail", "next line"], true);
  await (reset ? poll() : page.refresh());
  page.expectRows(["complete replacement"], false);
  expect(request.mock.calls[2]?.[1]).toMatchObject({ cursor: reset ? 110 : undefined });
});

it("retains one initial request across metadata snapshots with empty logs", async () => {
  const { request, replies } = pendingRequests();
  const { client, context, page } = await setup(request, false);
  context.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
  await waitForSolid(() => expect(page.disabled("Loading…")).toBe(true));
  context.gateway.publish({ ...context.gateway.snapshot });
  expect(request.mock.calls.map((call) => call[2].signal.aborted)).toEqual([false]);
  await deliver(replies[0]!, tail(100, [], "/tmp/initial.log"));
  context.gateway.publish({ ...context.gateway.snapshot });
  expect(request).toHaveBeenCalledOnce();
  request.mockResolvedValueOnce(tail(110, ["poll"], "/tmp/initial.log"));
  await poll();
  expect(request.mock.calls[1]![1]).toMatchObject({ cursor: 100 });
  expect(page.lines()).toEqual(["poll"]);
});

it.each(["reconnect", "source replacement", "client replacement", "detach/reattach"])(
  "discards unfinished requests on %s",
  async (transition) => {
    const { request, replies } = pendingRequests();
    const { client, context, page: initialPage } = await setup(request);
    let page = initialPage;
    if (transition === "reconnect") {
      reconnect(context);
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
    expect(request.mock.calls.map((call) => call[2].signal.aborted)).toEqual([true, false]);
    await deliver(replies[1]!, tail(2, ["current"]));
    page.expectRows(["current"]);
    const requestFrame = vi.spyOn(window, "requestAnimationFrame");
    await deliver(replies[0]!, tail(1, ["stale"]));
    page.expectRows(["current"]);
    expect(requestFrame).not.toHaveBeenCalled();
  },
);

it.each(["same", "changed"])("resumes %s-boot logs and retries failures", async (boot) => {
  const changed = boot === "changed";
  const pending = deferred<ReturnType<typeof tail>>();
  const frames = captureFrames();
  const request = responding(tail(100, ["before"], "/tmp/gateway.log", true))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(tail(200, ["after"], "/tmp/gateway.log"));
  const { context, page } = await setup(request, true, "original-boot");
  const stream = page.query(".log-stream")!;
  Object.defineProperty(stream, "scrollHeight", { value: 500 });
  stream.scrollTop = 0;
  // SAFETY: This focused snapshot fixture supplies only the hello boot field read by LogsPage.
  reconnect(context, {
    ...context.gateway.snapshot,
    hello: { server: { bootId: changed ? "replacement-boot" : "original-boot" } },
  } as ApplicationGatewaySnapshot);
  frames.forEach((frame) => frame(0));
  expect(stream.scrollTop).toBe(0);
  await settle();
  expect(request.mock.calls[1]![1]).toMatchObject({ cursor: changed ? undefined : 100 });
  page.expectRows(["before"], true);
  if (changed) {
    pending.reject(new Error("replacement boot is not ready"));
    await settle();
    page.expectRows(["before"], true);
    expect(page.text()).toContain("Showing stale data");
    expect(page.text()).toContain("replacement boot is not ready");
    await poll();
    expect(request.mock.calls[2]![1]).toMatchObject({ cursor: undefined });
  } else {
    await deliver(pending, tail(110, ["after"], "/tmp/gateway.log"));
  }
  page.expectRows(changed ? ["after"] : ["before", "after"], !changed);
  expect(page.text()).not.toContain("replacement boot is not ready");
});

it("clears loaded rows, source, and cursor when the gateway provider changes", async () => {
  const { client, page, request } = await setup(responding(tail(42, ["old"], "/old")));
  page.expectRows(["old"]);
  expect(page.text()).toContain("/old");
  const replacement = contextWithClient(client);
  page.replaceContext(replacement);
  page.expectRows([]);
  expect(page.text()).not.toContain("/old");
  request.mockResolvedValueOnce(tail(1, ["new"], "/new"));
  replacement.gateway.publish({ client, phase: "connected" } as ApplicationGatewaySnapshot);
  await settle();
  expect(request.mock.calls[1]?.[1]).toMatchObject({ cursor: undefined });
  page.expectRows(["new"]);
});

it("serializes quiet polls so an older cursor cannot overwrite a newer one", async () => {
  const pending = deferred<ReturnType<typeof tail>>();
  const request = responding(tail(1, ["seed"])).mockReturnValue(pending.promise);
  const { page } = await setup(request);
  await poll();
  expect(page.disabled("Refresh")).toBe(true);
  await poll();
  expect(request).toHaveBeenCalledTimes(2);
  page.expectRows(["seed"]);
  await deliver(pending, tail(2, ["fresh"]));
  page.expectRows(["seed", "fresh"]);
  await poll();
  expect(request.mock.calls[2]![1]).toMatchObject({ cursor: 2 });
});

it("reloads a changed log file before publishing any rows from it", async () => {
  const reset = deferred<ReturnType<typeof tail>>();
  const request = responding(
    tail(6, ["A-one"], "/a", true),
    tail(18, ["B-tail"], "/b"),
  ).mockReturnValueOnce(reset.promise);
  const { page } = await setup(request);
  await poll();
  page.expectRows(["A-one"], true);
  expect(request.mock.calls[2]?.[1]).toMatchObject({ cursor: undefined });
  await deliver(reset, tail(18, ["B-one", "B-tail"], "/b"));
  page.expectRows(["B-one", "B-tail"], false);
  expect(page.text()).toContain("/b");
});

it.each([false, true])("recovers a logs error with previously loaded rows: %s", async (loaded) => {
  const pending = deferred<ReturnType<typeof tail>>();
  const request = responding(...(loaded ? [tail(1, ["old"], undefined, true)] : []))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(tail(2, ["recovered"], undefined, loaded, loaded))
    .mockRejectedValueOnce(missingReadScopeErrorFixture());
  const { context, page } = await setup(request);
  const input = page.container.querySelector<HTMLInputElement>(".settings-input")!;
  const stream = page.query(".log-stream");
  const expectRetainedControls = () => {
    expect(page.query(".log-stream")).toBe(stream);
    expect(page.query(".settings-input")).toBe(input);
    expect(document.activeElement).toBe(input);
  };
  input.focus();
  if (loaded) {
    await page.refresh();
    page.expectRows(["old"], true);
  }
  expect(page.disabled("Loading…")).toBe(true);
  expectRetainedControls();
  pending.reject(new Error("logs unavailable"));
  await waitForSolid(() => expect(page.disabled("Refresh")).toBe(false));
  if (loaded) {
    page.expectRows(["old"], true);
    expect(page.query(".logs-refresh-status")?.textContent).toContain("Showing stale data");
  } else {
    expect(page.text()).not.toContain("No log entries.");
    context.gateway.publish({ ...context.gateway.snapshot });
    expect(request).toHaveBeenCalledOnce();
    expect(page.query(".logs-refresh-status button")).toBeNull();
  }
  expect(page.query(".logs-refresh-status")?.textContent).toContain("logs unavailable");
  await (loaded ? page.refresh() : poll());
  await waitForSolid(() => expect(page.lines()).toEqual(["recovered"]));
  expect(page.query(".logs-refresh-status")).toBeNull();
  expectRetainedControls();
  if (loaded) {
    page.expectRows(["recovered"], true);
    await poll();
    page.expectRows([], false);
    expect(page.text()).toContain("You don't have permission to view logs.");
  }
});

it("keeps text and level filters active as quiet polls append rows", async () => {
  const line = (message: string, level: string) =>
    JSON.stringify({ message, _meta: { logLevelName: level } });
  const request = responding(
    tail(1, [line("alpha info", "INFO"), line("alpha error", "ERROR"), line("beta", "INFO")]),
    tail(2, [line("alpha next", "ERROR"), line("beta next", "ERROR")]),
  );
  const { page } = await setup(request);
  const filter = page.container.querySelector<HTMLInputElement>(".settings-input")!;
  filter.value = "alpha";
  filter.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  page.expectRows(["alpha info", "alpha error"]);
  page.query(".log-chip.info input")!.click();
  flush();
  page.expectRows(["alpha error"]);
  await poll();
  expect(filter.value).toBe("alpha");
  page.expectRows(["alpha error", "alpha next"]);
});

it("forces a scroll when auto-follow is re-enabled away from the bottom", async () => {
  const { page } = await setup(vi.fn().mockResolvedValue(tail(1, ["one"])));
  const stream = page.query(".log-stream")!;
  Object.defineProperties(stream, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
  const toggle = page.query(".settings-toggle input, input.settings-toggle")!;
  toggle.click();
  flush();
  stream.scrollTop = 0;
  stream.dispatchEvent(new Event("scroll"));
  const frames = captureFrames();
  toggle.click();
  flush();
  expect(frames).toHaveLength(1);
  frames[0]!(0);
  expect(stream.scrollHeight - stream.clientHeight - stream.scrollTop).toBe(0);
});
