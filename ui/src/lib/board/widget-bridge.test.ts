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
  ) =>
    controller.handle(
      {
        type: "openclaw:widget-bridge-request",
        id: crypto.randomUUID(),
        ticket: "ticket",
        method,
        params,
      },
      context,
    );
  const emit = (payload: unknown) => handle("state.emit", { payload });
  return { client, confirmPrompt, dispatchPrompt, handle, emit };
}

describe("board widget bridge", () => {
  it("opens HTTPS widget links in a new tab without opener or referrer access", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    const { handle, client } = setup();

    await expect(handle("host.open", { url: "https://example.com/path" })).resolves.toEqual({
      ok: true,
    });

    expect(open).toHaveBeenCalledWith("https://example.com/path", "_blank", "noopener,noreferrer");
    expect(client.request).not.toHaveBeenCalled();
  });

  it.each(["javascript:alert(1)"])(
    "rejects unsafe widget link destinations without opening %s",
    async (url) => {
      const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
      const { handle } = setup();

      await expect(handle("host.open", { url })).rejects.toThrow("widget link url is invalid");
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("reports when the browser blocks a widget link", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { handle } = setup();

    await expect(handle("host.open", { url: "https://example.com/path" })).rejects.toThrow(
      "widget link could not be opened",
    );
    expect(open).toHaveBeenCalledOnce();
  });

  it("keeps confirmation when the authorization response omits its decision", async () => {
    const { handle, confirmPrompt, dispatchPrompt } = setup(true);

    await handle("prompt.send", { text: "Show details" }, { promptUserActivated: true });

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
      {
        promptUserActivated: true,
        isCurrent: () => current,
      },
    );
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());

    current = false;
    authorization.resolve({ confirmationRequired: false });

    await expect(handling).rejects.toThrow("no longer current");
    expect(dispatchPrompt).not.toHaveBeenCalled();
  });

  it("coalesces identical state payloads for five seconds", async () => {
    const { emit, client } = setup();

    await emit({ count: 1 });
    expect(await emit({ count: 1 })).toEqual(coalesced);
    vi.advanceTimersByTime(5_000);
    await emit({ count: 1 });

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).toHaveBeenNthCalledWith(1, "board.event", {
      ticket: "ticket",
      payload: { count: 1 },
    });
  });

  it("coalesces an identical state payload across interleaved emissions", async () => {
    const { emit, client } = setup();

    await emit({ status: "first" });
    await emit({ status: "second" });
    expect(await emit({ status: "first" })).toEqual(coalesced);

    expect(client.request).toHaveBeenCalledTimes(2);
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

    expect(client.request).toHaveBeenNthCalledWith(1, "board.data.read", {
      ticket: "ticket",
      bindingId: "health",
      params: { probe: false },
    });
    expect(client.request).toHaveBeenNthCalledWith(2, "board.action", {
      ticket: "ticket",
      action: "example.resolve",
      params: { eventId: "event-1" },
    });
    expect(client.request).toHaveBeenNthCalledWith(3, "board.action", {
      ticket: "ticket",
      action: "cron.trigger",
      jobId: "job-1",
    });
  });

  it("rejects non-object action params", async () => {
    const { handle, client } = setup();

    await expect(
      handle("action.run", { action: "example.resolve", params: "bad" }),
    ).rejects.toThrow("widget action params are invalid");
    expect(client.request).not.toHaveBeenCalled();
  });
});
