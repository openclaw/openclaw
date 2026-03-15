import { describe, expect, it } from "vitest";
import { buildOutboundMediaLoadOptions, resolveOutboundMediaLocalRoots } from "./load-options.js";

describe("media load options", () => {
  it("returns undefined localRoots when mediaLocalRoots is empty", () => {
    expect(resolveOutboundMediaLocalRoots(undefined)).toBeUndefined();
    expect(resolveOutboundMediaLocalRoots([])).toBeUndefined();
  });

  it("keeps trusted mediaLocalRoots entries", () => {
    expect(resolveOutboundMediaLocalRoots(["/tmp/workspace"])).toEqual(["/tmp/workspace"]);
  });

  it("builds loadWebMedia options from maxBytes and mediaLocalRoots", () => {
    expect(
      buildOutboundMediaLoadOptions({
        maxBytes: 1024,
        mediaLocalRoots: ["/tmp/workspace"],
      }),
    ).toEqual({
      maxBytes: 1024,
      localRoots: ["/tmp/workspace"],
    });
  });

  it("preserves custom fetch transport options", () => {
    const fetchImpl = (() => Promise.resolve(new Response())) as typeof fetch;
    const dispatcherPolicy = { mode: "direct" } as const;
    const fallbackDispatcherPolicy = { mode: "env-proxy" } as const;
    const shouldRetryFetchError = () => true;

    expect(
      buildOutboundMediaLoadOptions({
        fetchImpl,
        dispatcherPolicy,
        fallbackDispatcherPolicy,
        shouldRetryFetchError,
      }),
    ).toEqual({
      fetchImpl,
      dispatcherPolicy,
      fallbackDispatcherPolicy,
      shouldRetryFetchError,
    });
  });
});
