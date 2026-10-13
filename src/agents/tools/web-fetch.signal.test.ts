import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { WebFetchProviderToolDefinition } from "../../plugin-sdk/provider-web-fetch.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { createWebFetchTool } from "./web-fetch.js";
import * as webGuardedFetch from "./web-guarded-fetch.js";

const { resolveWebFetchDefinition } = vi.hoisted(() => ({
  resolveWebFetchDefinition: vi.fn(),
}));
vi.mock("../../web-fetch/runtime.js", () => ({ resolveWebFetchDefinition }));
vi.mock("../../web-fetch/content-extractors.runtime.js", () => ({
  extractReadableContent: vi.fn(async () => null),
}));

describe("web_fetch provider cancellation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resolveWebFetchDefinition.mockReset();
  });

  it.each([
    { fallback: "network-error", completion: "success" },
    { fallback: "http-error", completion: "failure" },
    { fallback: "empty-readability", completion: "failure" },
    { fallback: "disabled-readability", completion: "failure" },
  ])(
    "rejects late provider $completion without caching after $fallback",
    async ({ fallback, completion }) => {
      vi.stubGlobal(
        "fetch",
        withFetchPreconnect(
          vi.fn(async () => {
            if (fallback === "network-error") {
              throw new Error("network failed");
            }
            return new Response("<html><body>Upstream content</body></html>", {
              status: fallback === "http-error" ? 503 : 200,
              headers: { "content-type": "text/html" },
            });
          }),
        ),
      );
      const controller = new AbortController();
      const reason = new Error("parent run cancelled");
      const started = createDeferred();
      const pending = createDeferred<Record<string, unknown>>();
      const execute = vi
        .fn<WebFetchProviderToolDefinition["execute"]>()
        .mockImplementationOnce(async () => {
          started.resolve();
          return pending.promise;
        })
        .mockResolvedValue({ text: "fresh provider body" });
      resolveWebFetchDefinition.mockReturnValue({
        provider: { id: "test-fetch" },
        definition: { execute },
      });
      const tool = createWebFetchTool({
        config: {
          tools: {
            web: {
              fetch: { cacheTtlMinutes: 1, readability: fallback !== "disabled-readability" },
            },
          },
        },
      })!;
      const args = { url: `https://example.com/cancel-provider-${fallback}-${completion}` };
      const outcome = Promise.allSettled([tool.execute("cancelled", args, controller.signal)]);
      await started.promise;
      controller.abort(reason);
      if (completion === "success") {
        pending.resolve({ text: "stale provider body" });
      } else {
        pending.reject(new Error("provider cleanup failed"));
      }
      const [cancelled] = await outcome;
      const fresh = await tool.execute("fresh", args);
      const cached = await tool.execute("cached", args);

      // Soft assertions retain both the late-success and cache-poisoning evidence.
      expect.soft(cancelled).toEqual({ status: "rejected", reason });
      expect.soft(fresh.details).not.toHaveProperty("cached");
      expect
        .soft(fresh.details)
        .toMatchObject({ text: expect.stringContaining("fresh provider body") });
      expect.soft(execute).toHaveBeenCalledTimes(2);
      expect
        .soft(execute.mock.calls[0])
        .toEqual([
          { ...args, extractMode: "markdown", maxChars: 20_000 },
          { signal: controller.signal },
        ]);
      expect(cached.details).toMatchObject({
        cached: true,
        text: expect.stringContaining("fresh provider body"),
      });
    },
  );

  it("rejects a pre-aborted cache hit without invalidating it", async () => {
    const fetch = vi.fn(async () => {
      return new Response("fresh direct body", { headers: { "content-type": "text/plain" } });
    });
    vi.stubGlobal("fetch", withFetchPreconnect(fetch));
    const execute = vi.fn(async () => ({ text: "fresh provider body" }));
    resolveWebFetchDefinition.mockReturnValue({
      provider: { id: "test-fetch" },
      definition: { execute },
    });
    const tool = createWebFetchTool({
      config: { tools: { web: { fetch: { cacheTtlMinutes: 1 } } } },
    })!;
    const args = { url: "https://example.com/pre-aborted-cache-direct" };
    const fresh = await tool.execute("seed", args);
    const reason = new Error("parent already cancelled");
    const outcome = await Promise.allSettled([
      tool.execute("cancelled", args, AbortSignal.abort(reason)),
    ]);
    const cached = await tool.execute("cached", args);

    expect.soft(outcome).toEqual([{ status: "rejected", reason }]);
    assert(isRecord(fresh.details));
    expect(cached.details).toEqual({ ...fresh.details, cached: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("does not publish content if cancelled during guard release", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("fresh direct body", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    vi.stubGlobal("fetch", withFetchPreconnect(fetch));
    const execute = vi.fn(async () => ({ text: "fresh provider body" }));
    resolveWebFetchDefinition.mockReturnValue({
      provider: { id: "test-fetch" },
      definition: { execute },
    });
    const started = createDeferred();
    const released = createDeferred();
    const realGuard = webGuardedFetch.fetchWithWebToolsNetworkGuard;
    vi.spyOn(webGuardedFetch, "fetchWithWebToolsNetworkGuard").mockImplementationOnce(
      async (params) => {
        const result = await realGuard(params);
        return {
          ...result,
          release: async () => {
            await result.release();
            started.resolve();
            await released.promise;
          },
        };
      },
    );
    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: {
              cacheTtlMinutes: 1,
              readability: true,
            },
          },
        },
      },
    })!;
    const args = { url: "https://example.com/cancel-during-release-direct" };
    const controller = new AbortController();
    const reason = new Error("cancelled during release");
    const outcome = Promise.allSettled([tool.execute("cancelled", args, controller.signal)]);
    await started.promise;
    controller.abort(reason);
    released.resolve();
    const [cancelled] = await outcome;
    const fresh = await tool.execute("fresh", args);
    const cached = await tool.execute("cached", args);

    expect.soft(cancelled).toEqual({ status: "rejected", reason });
    expect.soft(fresh.details).not.toHaveProperty("cached");
    expect.soft(fetch).toHaveBeenCalledTimes(2);
    expect.soft(execute).toHaveBeenCalledTimes(0);
    assert(isRecord(fresh.details));
    expect(cached.details).toEqual({ ...fresh.details, cached: true });
  });
});
