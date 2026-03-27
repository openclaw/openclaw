import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configModule from "../config/config.js";
import { fetchBrowserJson } from "./client-fetch.js";
import * as controlServiceModule from "./control-service.js";
import * as routeDispatcherModule from "./routes/dispatcher.js";

type MockDispatchResult = { status: number; body: unknown };

const mocks = {
  dispatch: vi.fn<() => Promise<MockDispatchResult>>(async () => ({
    status: 200,
    body: { ok: true },
  })),
};

describe("fetchBrowserJson error classification", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(configModule, "loadConfig").mockImplementation(
      () =>
        ({
          gateway: {
            auth: {
              token: "loopback-token",
            },
          },
        }) as ReturnType<typeof configModule.loadConfig>,
    );
    vi.spyOn(controlServiceModule, "startBrowserControlServiceFromConfig").mockResolvedValue(
      true as unknown as Awaited<
        ReturnType<typeof controlServiceModule.startBrowserControlServiceFromConfig>
      >,
    );
    vi.spyOn(controlServiceModule, "createBrowserControlContext").mockReturnValue(
      {} as ReturnType<typeof controlServiceModule.createBrowserControlContext>,
    );
    vi.spyOn(routeDispatcherModule, "createBrowserRouteDispatcher").mockReturnValue({
      dispatch: mocks.dispatch,
    } as ReturnType<typeof routeDispatcherModule.createBrowserRouteDispatcher>);
    mocks.dispatch.mockReset();
    mocks.dispatch.mockResolvedValue({ status: 200, body: { ok: true } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves local browser route errors without wrapping as service outage", async () => {
    mocks.dispatch.mockResolvedValueOnce({
      status: 500,
      body: { error: "TimeoutError: locator.click: Timeout 8000ms exceeded." },
    });

    let thrown: unknown;
    try {
      await fetchBrowserJson("/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "click", ref: "e1" }),
        timeoutMs: 200,
      });
    } catch (err) {
      thrown = err;
    }

    const message = String(thrown);
    expect(message).toContain("locator.click");
    expect(message).not.toContain("Can't reach the OpenClaw browser control service");
  });

  it("uses bounded-retry guidance for action-path timeouts", async () => {
    mocks.dispatch.mockImplementationOnce(
      () =>
        new Promise<never>(() => {
          // Intentionally unresolved to trigger fetchBrowserJson timeout path.
        }),
    );

    await expect(
      fetchBrowserJson("/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "click", ref: "e1" }),
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/Do NOT blindly retry in a loop/);
  });

  it("keeps strict non-retry guidance for non-action path timeouts", async () => {
    mocks.dispatch.mockImplementationOnce(
      () =>
        new Promise<never>(() => {
          // Intentionally unresolved to trigger fetchBrowserJson timeout path.
        }),
    );

    await expect(
      fetchBrowserJson("/tabs", {
        method: "GET",
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/Do NOT retry the browser tool — it will keep failing/);
  });

  it("preserves HTTP response errors from reachable browser service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("tab not found", {
            status: 404,
            headers: { "Content-Type": "text/plain" },
          }),
      ),
    );

    let thrown: unknown;
    try {
      await fetchBrowserJson("http://127.0.0.1:18888/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "click", ref: "e1" }),
        timeoutMs: 200,
      });
    } catch (err) {
      thrown = err;
    }

    const message = String(thrown);
    expect(message).toContain("tab not found");
    expect(message).not.toContain("Can't reach the OpenClaw browser control service");
  });
});
