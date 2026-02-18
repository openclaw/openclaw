import { describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";

vi.mock("./index.js", () => {
  return {
    registerBrowserRoutes(app: { get: (path: string, handler: unknown) => void }) {
      app.get(
        "/slow",
        async (req: { signal?: AbortSignal }, res: { json: (body: unknown) => void }) => {
          const signal = req.signal;
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
              reject(signal.reason ?? new Error("aborted"));
              return;
            }
            const onAbort = () => reject(signal?.reason ?? new Error("aborted"));
            signal?.addEventListener("abort", onAbort, { once: true });
            setTimeout(resolve, 50);
          });
          res.json({ ok: true });
        },
      );
    },
  };
});

describe("browser route dispatcher (abort)", () => {
  it("propagates AbortSignal and lets handlers observe abort", async () => {
    const { createBrowserRouteDispatcher } = await import("./dispatcher.js");
    const dispatcher = createBrowserRouteDispatcher({} as BrowserRouteContext);

    const ctrl = new AbortController();
    const promise = dispatcher.dispatch({
      method: "GET",
      path: "/slow",
      signal: ctrl.signal,
    });

    ctrl.abort(new Error("timed out"));

    await expect(promise).resolves.toMatchObject({
      status: 500,
      body: { error: expect.stringContaining("timed out") },
    });
  });
});
