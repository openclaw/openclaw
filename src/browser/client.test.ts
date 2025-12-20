import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserClickRef,
  browserDom,
  browserOpenTab,
  browserQuery,
  browserScreenshot,
  browserSnapshot,
  browserStatus,
  browserTabs,
} from "./client.js";

describe("browser client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps connection failures with a gateway hint", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), {
      code: "ECONNREFUSED",
    });
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
      cause: refused,
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed));

    await expect(browserStatus("http://127.0.0.1:18791")).rejects.toThrow(
      /Start .*gateway/i,
    );
  });

  it("adds useful timeout messaging for abort-like failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    await expect(browserStatus("http://127.0.0.1:18791")).rejects.toThrow(
      /timed out/i,
    );
  });

  it("surfaces non-2xx responses with body text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: async () => "conflict",
      } as unknown as Response),
    );

    await expect(
      browserDom("http://127.0.0.1:18791", { format: "text", maxChars: 1 }),
    ).rejects.toThrow(/409: conflict/i);
  });

  it("uses the expected endpoints + methods for common calls", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/tabs") && (!init || init.method === undefined)) {
          return {
            ok: true,
            json: async () => ({
              running: true,
              tabs: [{ targetId: "t1", title: "T", url: "https://x" }],
            }),
          } as unknown as Response;
        }
        if (url.endsWith("/tabs/open")) {
          return {
            ok: true,
            json: async () => ({
              targetId: "t2",
              title: "N",
              url: "https://y",
            }),
          } as unknown as Response;
        }
        if (url.includes("/screenshot")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              path: "/tmp/a.png",
              targetId: "t1",
              url: "https://x",
            }),
          } as unknown as Response;
        }
        if (url.includes("/query?")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              targetId: "t1",
              url: "https://x",
              matches: [{ index: 0, tag: "a" }],
            }),
          } as unknown as Response;
        }
        if (url.includes("/dom?")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              targetId: "t1",
              url: "https://x",
              format: "text",
              text: "hi",
            }),
          } as unknown as Response;
        }
        if (url.includes("/snapshot?")) {
          return {
            ok: true,
            json: async () => ({
              ok: true,
              format: "aria",
              targetId: "t1",
              url: "https://x",
              nodes: [],
            }),
          } as unknown as Response;
        }
        if (url.endsWith("/click")) {
          return {
            ok: true,
            json: async () => ({ ok: true, targetId: "t1", url: "https://x" }),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({
            enabled: true,
            controlUrl: "http://127.0.0.1:18791",
            running: true,
            pid: 1,
            cdpPort: 18792,
            chosenBrowser: "chrome",
            userDataDir: "/tmp",
            color: "#FF4500",
            headless: false,
            attachOnly: false,
          }),
        } as unknown as Response;
      }),
    );

    await expect(
      browserStatus("http://127.0.0.1:18791"),
    ).resolves.toMatchObject({
      running: true,
      cdpPort: 18792,
    });

    await expect(browserTabs("http://127.0.0.1:18791")).resolves.toHaveLength(
      1,
    );
    await expect(
      browserOpenTab("http://127.0.0.1:18791", "https://example.com"),
    ).resolves.toMatchObject({ targetId: "t2" });

    await expect(
      browserScreenshot("http://127.0.0.1:18791", { fullPage: true }),
    ).resolves.toMatchObject({ ok: true, path: "/tmp/a.png" });
    await expect(
      browserQuery("http://127.0.0.1:18791", { selector: "a", limit: 1 }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      browserDom("http://127.0.0.1:18791", { format: "text", maxChars: 10 }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      browserSnapshot("http://127.0.0.1:18791", { format: "aria", limit: 1 }),
    ).resolves.toMatchObject({ ok: true, format: "aria" });
    await expect(
      browserClickRef("http://127.0.0.1:18791", { ref: "1" }),
    ).resolves.toMatchObject({ ok: true });

    expect(calls.some((c) => c.url.endsWith("/tabs"))).toBe(true);
    const open = calls.find((c) => c.url.endsWith("/tabs/open"));
    expect(open?.init?.method).toBe("POST");
  });
});
