// Command descriptor utilities retain the shared first-wins grouping contract.
import { describe, expect, it } from "vitest";
import { collectUniqueCommandDescriptors } from "./command-descriptor-utils.js";

describe("command-descriptor-utils", () => {
  it("collects unique descriptors across groups in order", () => {
    expect(
      collectUniqueCommandDescriptors([
        [
          { name: "alpha", description: "Alpha" },
          { name: "beta", description: "Beta" },
        ],
        [
          { name: "beta", description: "Ignored duplicate" },
          { name: "gamma", description: "Gamma" },
        ],
      ]),
    ).toEqual([
      { name: "alpha", description: "Alpha" },
      { name: "beta", description: "Beta" },
      { name: "gamma", description: "Gamma" },
    ]);
  });
});
