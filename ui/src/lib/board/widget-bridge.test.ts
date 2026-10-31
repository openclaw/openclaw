import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { dispatchWidgetPrompt } from "../../components/mcp-app-security.ts";
import { BoardWidgetBridgeOwner } from "./widget-bridge.ts";
vi.mock("../../components/mcp-app-security.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/mcp-app-security.ts")>()),
  dispatchWidgetPrompt: vi.fn(),
}));
beforeEach(() => {
  vi.useFakeTimers({ now: 1_000 });
  dispatchPrompt.mockReset().mockResolvedValue(true);
  client.request.mockReset().mockResolvedValue({ ok: true });
  widgetActivated.mockReset().mockResolvedValue(true);
  controller = owner();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const envelope = { type: "openclaw:widget-bridge-request" as const, ticket: "ticket" };
const client = {
  request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(),
};
const confirmPrompt = () => true;
const widgetActivated = vi.fn<() => Promise<boolean>>();
// Native link budgets belong to a dashboard document; a fresh one per test
// keeps an earlier test's open from spending this test's budget.
const owner = (dashboard = document.implementation.createHTMLDocument()) =>
  new BoardWidgetBridgeOwner({
    frame: dashboard.createElement("iframe"),
    ticket: "ticket",
    client,
    rateKey: "widget",
    confirmPrompt,
    widgetActivated,
  });
const dispatchPrompt = vi.mocked(dispatchWidgetPrompt);
let controller: BoardWidgetBridgeOwner;
const handle = (
  method: string,
  params: Record<string, unknown>,
  context?: Parameters<BoardWidgetBridgeOwner["handle"]>[1],
) => controller.handle({ ...envelope, id: crypto.randomUUID(), method, params }, context);
const emit = (payload: unknown) => handle("state.emit", { payload });
const stubUserActivation = (isActive: boolean) => {
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive } });
  onTestFinished(() => {
    Reflect.deleteProperty(navigator, "userActivation");
  });
};
it.each([
  ["https://example.com/path", false, null],
  ["javascript:alert(1)", false, "widget link url is invalid"],
  ["https://example.com/path", true, "widget link could not be opened"],
] as const)("opens safe links or reports failure: %s (%s)", async (url, blocked, error) => {
  const open = vi.spyOn(window, "open").mockReturnValue(blocked ? null : ({} as Window));
  const result = handle("host.open", { url });
  if (error) {
    await expect(result).rejects.toThrow(error);
  } else {
    await expect(result).resolves.toEqual({ ok: true });
  }
  expect(open.mock.calls).toEqual(
    url.startsWith("https:") ? [[url, "_blank", "noopener,noreferrer"]] : [],
  );
  expect(client.request).not.toHaveBeenCalled();
});
it("hands widget links to the native link owner instead of a WebKit popup", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });
  stubUserActivation(true);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await expect(handle("host.open", { url: "https://example.com/path" })).resolves.toEqual({
    ok: true,
  });
  await expect(handle("host.open", { url: "javascript:alert(1)" })).rejects.toThrow(
    "widget link url is invalid",
  );
  expect(postMessage.mock.calls).toEqual([
    [{ type: "open-link", url: "https://example.com/path", target: "external" }],
  ]);
  expect(open).not.toHaveBeenCalled();
});
it("keeps widget links without user activation away from the native link owner", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });
  stubUserActivation(false);
  // WebKit's popup blocker refuses the fallback open, as it does on main.
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await expect(handle("host.open", { url: "https://example.com/path" })).rejects.toThrow(
    "widget link could not be opened",
  );
  expect(postMessage).not.toHaveBeenCalled();
  expect(open.mock.calls).toEqual([["https://example.com/path", "_blank", "noopener,noreferrer"]]);
});
it("opens at most one native widget link per second of user activation", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });
  stubUserActivation(true);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const link = (path: string) => handle("host.open", { url: `https://example.com/${path}` });
  await expect(link("first")).resolves.toEqual({ ok: true });
  await expect(link("burst")).rejects.toThrow("widget link could not be opened");
  vi.advanceTimersByTime(1_000);
  await expect(link("later")).resolves.toEqual({ ok: true });
  expect(postMessage.mock.calls).toEqual([
    [{ type: "open-link", url: "https://example.com/first", target: "external" }],
    [{ type: "open-link", url: "https://example.com/later", target: "external" }],
  ]);
  expect(open.mock.calls).toEqual([["https://example.com/burst", "_blank", "noopener,noreferrer"]]);
});
it("opens native widget links only while that widget's own frame holds user activation", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });
  // Dashboard activation from a click or keystroke outside this widget.
  stubUserActivation(true);
  widgetActivated.mockResolvedValue(false);
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await expect(handle("host.open", { url: "https://example.com/elsewhere" })).rejects.toThrow(
    "widget link could not be opened",
  );
  expect(widgetActivated).toHaveBeenCalledOnce();
  expect(postMessage).not.toHaveBeenCalled();
  expect(open.mock.calls).toEqual([
    ["https://example.com/elsewhere", "_blank", "noopener,noreferrer"],
  ]);
  widgetActivated.mockResolvedValue(true);
  await expect(handle("host.open", { url: "https://example.com/inside" })).resolves.toEqual({
    ok: true,
  });
  expect(postMessage.mock.calls).toEqual([
    [{ type: "open-link", url: "https://example.com/inside", target: "external" }],
  ]);
});
it("shares one native link budget across the widgets of a dashboard", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });
  stubUserActivation(true);
  vi.spyOn(window, "open").mockReturnValue(null);
  const dashboard = document.implementation.createHTMLDocument();
  const [first, second] = [owner(dashboard), owner(dashboard)];
  const link = (target: BoardWidgetBridgeOwner, path: string) =>
    target.handle({
      ...envelope,
      id: crypto.randomUUID(),
      method: "host.open",
      params: { url: `https://example.com/${path}` },
    });
  await expect(link(first, "first")).resolves.toEqual({ ok: true });
  await expect(link(second, "second")).rejects.toThrow("widget link could not be opened");
  await expect(link(owner(), "other-dashboard")).resolves.toEqual({ ok: true });
  expect(postMessage.mock.calls.map(([message]) => message.url)).toEqual([
    "https://example.com/first",
    "https://example.com/other-dashboard",
  ]);
});
it("spaces native widget links on the monotonic clock", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });
  stubUserActivation(true);
  vi.spyOn(window, "open").mockReturnValue(null);
  let monotonic = 50_000;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  await expect(handle("host.open", { url: "https://example.com/first" })).resolves.toEqual({
    ok: true,
  });
  // A wall-clock jump is not elapsed time.
  vi.setSystemTime(Date.now() + 60_000);
  await expect(handle("host.open", { url: "https://example.com/jump" })).rejects.toThrow(
    "widget link could not be opened",
  );
  monotonic += 1_000;
  await expect(handle("host.open", { url: "https://example.com/later" })).resolves.toEqual({
    ok: true,
  });
  expect(postMessage.mock.calls.map(([message]) => message.url)).toEqual([
    "https://example.com/first",
    "https://example.com/later",
  ]);
});
it("opens one native widget link when requests race the activation check", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });
  stubUserActivation(true);
  vi.spyOn(window, "open").mockReturnValue(null);
  const activation = createDeferred<boolean>();
  widgetActivated.mockReturnValue(activation.promise);
  const links = ["a", "b"].map((path) =>
    handle("host.open", { url: `https://example.com/${path}` }).then(
      () => "opened",
      () => "refused",
    ),
  );
  activation.resolve(true);
  expect(await Promise.all(links)).toEqual(["opened", "refused"]);
  expect(postMessage).toHaveBeenCalledOnce();
});
it.each([
  ["javascript:alert(1)", "widget link url is invalid"],
  ["JavaScript:alert(1)", "widget link url is invalid"],
  ["data:text/html,<script>alert(1)</script>", "widget link url is invalid"],
  ["blob:https://example.com/0", "widget link url is invalid"],
  ["file:///etc/hosts", "widget link url is invalid"],
  ["mailto:someone@example.com", "widget link url is invalid"],
  ["tel:+15555550100", "widget link url is invalid"],
  ["//example.com/path", "widget link url is invalid"],
  [" https://example.com/path", "widget link url is invalid"],
  ["https:example.com", "widget link url is invalid"],
  ["https://", "widget link could not be opened"],
] as const)(
  "never opens a non-HTTP(S) widget link natively or by popup: %s",
  async (url, error) => {
    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    await expect(handle("host.open", { url })).rejects.toThrow(error);
    expect(postMessage).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  },
);
it("never opens widget links for a forged or retired view ticket", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });
  stubUserActivation(true);
  const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
  const link = (ticket: string) =>
    controller.handle({
      ...envelope,
      ticket,
      id: crypto.randomUUID(),
      method: "host.open",
      params: { url: "https://example.com/path" },
    });
  await expect(link("forged")).rejects.toThrow("widget view ticket does not match");
  controller.updateIdentity(document.createElement("iframe"), "renewed");
  await expect(link("ticket")).rejects.toThrow("widget view ticket does not match");
  expect(postMessage).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  await expect(link("renewed")).resolves.toEqual({ ok: true });
  expect(postMessage).toHaveBeenCalledOnce();
});
it("keeps confirmation when the authorization response omits its decision", async () => {
  client.request.mockResolvedValueOnce({});
  await handle("prompt.send", { text: "Show details" }, { promptUserActivated: true });
  expect(dispatchPrompt.mock.calls[0]?.[3]).toBe(confirmPrompt);
});
it.each([
  ["prompt.send", { text: "Forged" }, "active user interaction"],
  ["state.emit", { payload: "x".repeat(8_193) }, "exceeds 8192"],
  ["action.run", { action: "example.resolve", params: "bad" }, "widget action params are invalid"],
] as const)("rejects invalid %s before dispatch", async (method, params, error) => {
  await expect(handle(method, params)).rejects.toThrow(error);
  expect(client.request).not.toHaveBeenCalled();
  expect(dispatchPrompt).not.toHaveBeenCalled();
});
it("cancels prompt dispatch when the widget identity changes during authorization", async () => {
  const authorization = createDeferred<unknown>();
  client.request.mockReturnValueOnce(authorization.promise);
  let current = true;
  const handling = handle(
    "prompt.send",
    { text: "Stale prompt" },
    { promptUserActivated: true, isCurrent: () => current },
  );
  await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());
  current = false;
  authorization.resolve({ confirmationRequired: false });
  await expect(handling).rejects.toThrow("no longer current");
  expect(dispatchPrompt).not.toHaveBeenCalled();
});
it.each(["expiry", "interleaved"])("coalesces repeated state across %s", async (mode) => {
  await emit({ count: 1 });
  if (mode === "interleaved") {
    await emit({ count: 2 });
  }
  expect(await emit({ count: 1 })).toEqual({ ok: true, appended: false, coalesced: true });
  if (mode === "expiry") {
    vi.advanceTimersByTime(5_000);
    await emit({ count: 1 });
  }
  expect(client.request).toHaveBeenCalledTimes(2);
});
it("allows a state payload to retry after delivery fails", async () => {
  client.request.mockRejectedValueOnce(new Error("offline"));
  await expect(emit({ count: 1 })).rejects.toThrow("offline");
  await expect(emit({ count: 1 })).resolves.toEqual({ ok: true });
});
it("rate-limits varying state payloads at the trusted host", async () => {
  for (let count = 0; count < 12; count += 1) {
    await emit({ count });
  }
  await expect(emit({ count: 12 })).rejects.toThrow("rate limit exceeded");
  vi.advanceTimersByTime(60_000);
  await expect(emit({ count: 13 })).resolves.toEqual({ ok: true });
});
it.each([
  ["data.read", { bindingId: "health", params: { probe: false } }, "board.data.read"],
  ["action.run", { action: "example.resolve", params: { eventId: "event-1" } }, "board.action"],
  ["cron.trigger", { jobId: "job-1" }, "board.action"],
] as const)("maps %s to a ticket-bound board RPC", async (method, params, rpc) => {
  await handle(method, params);
  expect(client.request).toHaveBeenCalledExactlyOnceWith(rpc, {
    ticket: "ticket",
    ...params,
    ...(method === "cron.trigger" ? { action: "cron.trigger" } : {}),
  });
});
