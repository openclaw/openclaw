import { describe, expect, it } from "vitest";
import { normalizeChannelIngressMiddlewareEntry, runChannelIngressMiddlewares } from "./runtime.js";

describe("channel ingress runtime", () => {
  it("normalizes string and object entries", () => {
    expect(normalizeChannelIngressMiddlewareEntry("file:///tmp/a.mjs", 0)).toEqual({
      name: "middleware-1",
      module: "file:///tmp/a.mjs",
      exportName: "runIngressMiddleware",
    });
    expect(
      normalizeChannelIngressMiddlewareEntry(
        { name: "custom", module: "file:///tmp/b.mjs", exportName: "run" },
        1,
      ),
    ).toEqual({
      name: "custom",
      module: "file:///tmp/b.mjs",
      exportName: "run",
    });
  });

  it("runs middleware functions in order and reports outcomes", async () => {
    const calls: string[] = [];
    const result = await runChannelIngressMiddlewares({
      entries: ["unused"],
      args: { ping: true },
      resolveFns: async () => [
        {
          name: "first",
          fn: async () => {
            calls.push("first");
            return { handled: true, reason: "first" };
          },
        },
        {
          name: "second",
          fn: async () => {
            calls.push("second");
            return { handled: true, reason: "second" };
          },
        },
      ],
    });

    expect(calls).toEqual(["first", "second"]);
    expect(result.middlewareCount).toBe(2);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes[1]?.result).toEqual({ handled: true, reason: "second" });
  });
});
