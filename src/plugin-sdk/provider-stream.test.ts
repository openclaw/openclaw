import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { composeProviderStreamWrappers } from "./provider-stream.js";

describe("composeProviderStreamWrappers", () => {
  it("applies wrappers left to right", async () => {
    const order: string[] = [];
    const baseStreamFn: StreamFn = (_model, _context, _options) => {
      order.push("base");
      return {} as never;
    };

    const wrap =
      (label: string) =>
      (streamFn: StreamFn | undefined): StreamFn =>
      (model, context, options) => {
        order.push(`${label}:before`);
        const result = (streamFn ?? baseStreamFn)(model, context, options);
        order.push(`${label}:after`);
        return result;
      };

    const composed = composeProviderStreamWrappers(baseStreamFn, wrap("a"), undefined, wrap("b"));

    expect(typeof composed).toBe("function");
    void composed?.({} as never, {} as never, {});

    expect(order).toEqual(["b:before", "a:before", "base", "a:after", "b:after"]);
  });

  it("returns the original stream when no wrappers are provided", () => {
    const baseStreamFn: StreamFn = () => ({}) as never;
    expect(composeProviderStreamWrappers(baseStreamFn)).toBe(baseStreamFn);
  });
});
