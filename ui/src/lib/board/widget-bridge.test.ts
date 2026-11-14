import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  controller = new BoardWidgetBridgeOwner({
    frame: document.createElement("iframe"),
    ticket: "ticket",
    client,
    rateKey: "widget",
    confirmPrompt,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const envelope = { type: "openclaw:widget-bridge-request" as const, ticket: "ticket" };
const client = {
  request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(),
};
const confirmPrompt = () => true;
const dispatchPrompt = vi.mocked(dispatchWidgetPrompt);
let controller: BoardWidgetBridgeOwner;
const handle = (
  method: string,
  params: Record<string, unknown>,
  context?: Parameters<BoardWidgetBridgeOwner["handle"]>[1],
) => controller.handle({ ...envelope, id: crypto.randomUUID(), method, params }, context);
const emit = (payload: unknown) => handle("state.emit", { payload });
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
