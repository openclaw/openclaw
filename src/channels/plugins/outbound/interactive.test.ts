import { describe, expect, it } from "vitest";
import { reduceInteractiveReply } from "./interactive.js";

describe("reduceInteractiveReply", () => {
  it("walks authored blocks in order", () => {
    const order = reduceInteractiveReply(
      {
        blocks: [
          { type: "text", text: "first" },
          { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
          { type: "select", options: [{ label: "Alpha", value: "alpha" }] },
        ],
      },
      [] as string[],
      (state, block) => {
        state.push(block.type);
        return state;
      },
    );

    expect(order).toEqual(["text", "buttons", "select"]);
  });

  it("returns the initial state when interactive payload is missing", () => {
    expect(reduceInteractiveReply(undefined, 3, (value) => value + 1)).toBe(3);
  });
});
