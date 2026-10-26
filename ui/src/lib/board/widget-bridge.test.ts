import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { dispatchWidgetPrompt } from "../../components/mcp-app-security.ts";
import { BoardWidgetBridgeOwner } from "./widget-bridge.ts";
vi.mock("../../components/mcp-app-security.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/mcp-app-security.ts")>()),
  dispatchWidgetPrompt: vi.fn(),
}));
beforeEach(() => {
  vi.useFakeTimers({ now: 1_000 });
  vi.mocked(dispatchWidgetPrompt).mockReset().mockResolvedValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const envelope = { type: "openclaw:widget-bridge-request" as const, ticket: "ticket" };
const active = { promptUserActivated: true };
const coalesced = { ok: true, appended: false, coalesced: true };
function setup(omitPromptDecision = false) {
  const client = {
    request: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(
      async (method) =>
        method === "board.prompt.authorize"
          ? omitPromptDecision
            ? {}
            : { confirmationRequired: false }
          : { ok: true },
    ),
  };
  const confirmPrompt = vi.fn(() => true);
  const dispatchPrompt = vi.mocked(dispatchWidgetPrompt);
  const controller = new BoardWidgetBridgeOwner({
    frame: document.createElement("iframe"),
    ticket: "ticket",
    client,
    rateKey: "widget",
    confirmPrompt,
  });
  const handle = (
    method: string,
    params: Record<string, unknown>,
    context?: Parameters<BoardWidgetBridgeOwner["handle"]>[1],
  ) => controller.handle({ ...envelope, id: crypto.randomUUID(), method, params }, context);
  const emit = (payload: unknown) => handle("state.emit", { payload });
  return { client, confirmPrompt, dispatchPrompt, handle, emit };
}
describe("board widget bridge", () => {
  it.each([
    ["https://example.com/path", false, null],
    ["javascript:alert(1)", false, "widget link url is invalid"],
    ["https://example.com/path", true, "widget link could not be opened"],
  ] as const)(
    "opens only safe links and reports browser blocking: %s (%s)",
    async (url, blocked, error) => {
      const open = vi.spyOn(window, "open").mockReturnValue(blocked ? null : ({} as Window));
      const { handle, client } = setup();
      const result = handle("host.open", { url });
      if (error) {
        await expect(result).rejects.toThrow(error);
      } else {
        await expect(result).resolves.toEqual({ ok: true });
      }
      if (url.startsWith("https:")) {
        expect(open).toHaveBeenCalledExactlyOnceWith(url, "_blank", "noopener,noreferrer");
      } else {
        expect(open).not.toHaveBeenCalled();
      }
      expect(client.request).not.toHaveBeenCalled();
    },
  );
  it("keeps confirmation when the authorization response omits its decision", async () => {
    const { handle, confirmPrompt, dispatchPrompt } = setup(true);
    await handle("prompt.send", { text: "Show details" }, active);
    expect(dispatchPrompt).toHaveBeenCalledWith(
      expect.any(HTMLIFrameElement),
      "Show details",
      "widget",
      confirmPrompt,
      undefined,
    );
  });
  it("rejects a forged prompt bridge request without trusted user activation", async () => {
    const { handle, client, dispatchPrompt } = setup();
    await expect(handle("prompt.send", { text: "Forged" })).rejects.toThrow(
      "active user interaction",
    );
    expect(client.request).not.toHaveBeenCalled();
    expect(dispatchPrompt).not.toHaveBeenCalled();
  });
  it("cancels prompt dispatch when the widget identity changes during authorization", async () => {
    const { handle, client, dispatchPrompt } = setup();
    const authorization = createDeferred<unknown>();
    client.request.mockReturnValueOnce(authorization.promise);
    let current = true;
    const handling = handle(
      "prompt.send",
      { text: "Stale prompt" },
      { ...active, isCurrent: () => current },
    );
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());
    current = false;
    authorization.resolve({ confirmationRequired: false });
    await expect(handling).rejects.toThrow("no longer current");
    expect(dispatchPrompt).not.toHaveBeenCalled();
  });
  it.each(["expiry", "interleaved"])("coalesces repeated state across %s", async (mode) => {
    const { emit, client } = setup();
    await emit({ count: 1 });
    if (mode === "interleaved") {
      await emit({ count: 2 });
    }
    expect(await emit({ count: 1 })).toEqual(coalesced);
    if (mode === "expiry") {
      vi.advanceTimersByTime(5_000);
      await emit({ count: 1 });
    }
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).toHaveBeenNthCalledWith(1, "board.event", {
      ticket: "ticket",
      payload: { count: 1 },
    });
  });
  it("rejects state payloads above 8KB before the gateway call", async () => {
    const { emit, client } = setup();
    await expect(emit("x".repeat(8_193))).rejects.toThrow("exceeds 8192");
    expect(client.request).not.toHaveBeenCalled();
  });
  it("allows a state payload to retry after delivery fails", async () => {
    const { emit, client } = setup();
    client.request.mockRejectedValueOnce(new Error("offline"));
    await expect(emit({ count: 1 })).rejects.toThrow("offline");
    await expect(emit({ count: 1 })).resolves.toEqual({ ok: true });
    expect(client.request).toHaveBeenCalledTimes(2);
  });
  it("rate-limits varying state payloads at the trusted host", async () => {
    const { emit, client } = setup();
    for (let count = 0; count < 12; count += 1) {
      await emit({ count });
    }
    await expect(emit({ count: 12 })).rejects.toThrow("rate limit exceeded");
    vi.advanceTimersByTime(60_000);
    await expect(emit({ count: 13 })).resolves.toEqual({ ok: true });
    expect(client.request).toHaveBeenCalledTimes(13);
  });
  it("maps read, action, and cron requests to ticket-bound board RPCs", async () => {
    const { handle, client } = setup();
    await handle("data.read", { bindingId: "health", params: { probe: false } });
    await handle("action.run", { action: "example.resolve", params: { eventId: "event-1" } });
    await handle("cron.trigger", { jobId: "job-1" });
    expect(client.request.mock.calls).toEqual([
      ["board.data.read", { ticket: "ticket", bindingId: "health", params: { probe: false } }],
      [
        "board.action",
        { ticket: "ticket", action: "example.resolve", params: { eventId: "event-1" } },
      ],
      ["board.action", { ticket: "ticket", action: "cron.trigger", jobId: "job-1" }],
    ]);
  });
  it("rejects non-object action params", async () => {
    const { handle, client } = setup();
    await expect(
      handle("action.run", { action: "example.resolve", params: "bad" }),
    ).rejects.toThrow("widget action params are invalid");
    expect(client.request).not.toHaveBeenCalled();
  });
});
