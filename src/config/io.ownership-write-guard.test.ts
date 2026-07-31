import { describe, expect, it } from "vitest";
import { assertAutomaticBindingsWriteAllowed } from "./io.ownership-write-guard.js";

const binding = { agentId: "ops", match: { channel: "telegram" } };

describe("automatic ownership binding write guard", () => {
  it("allows include-owned bindings when no append is required", () => {
    expect(() =>
      assertAutomaticBindingsWriteAllowed({
        bindingsIncludeOwned: true,
        ownershipPaths: [["bindings", "0"]],
        sourceBindings: [binding],
        nextBindings: [binding],
      }),
    ).not.toThrow();
  });

  it("treats key-order permutations as the same binding", () => {
    expect(() =>
      assertAutomaticBindingsWriteAllowed({
        bindingsIncludeOwned: true,
        ownershipPaths: [["bindings", "0"]],
        sourceBindings: [
          {
            match: { accountId: "*", channel: "telegram" },
            agentId: "ops",
          },
        ],
        nextBindings: [
          {
            agentId: "ops",
            match: { channel: "telegram", accountId: "*" },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("treats omitted and undefined optional fields as the same binding", () => {
    expect(() =>
      assertAutomaticBindingsWriteAllowed({
        bindingsIncludeOwned: true,
        ownershipPaths: [["bindings", "0"]],
        sourceBindings: [{ agentId: "ops", match: { channel: "telegram" } }],
        nextBindings: [
          {
            agentId: "ops",
            comment: undefined,
            match: { channel: "telegram", accountId: undefined },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects an automatic append into include-owned bindings", () => {
    expect(() =>
      assertAutomaticBindingsWriteAllowed({
        bindingsIncludeOwned: true,
        ownershipPaths: [["bindings"]],
        sourceBindings: [],
        nextBindings: [binding],
      }),
    ).toThrow("cannot append to $include-owned bindings");
  });
});
