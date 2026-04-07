import { describe, expect, it } from "vitest";
import {
  createPrefixedOutputWriter,
  runNodeStepsInParallel,
} from "../../scripts/prepare-extension-package-boundary-artifacts.mjs";

describe("prepare-extension-package-boundary-artifacts", () => {
  it("prefixes each completed line and flushes the trailing partial line", () => {
    let output = "";
    const writer = createPrefixedOutputWriter("boundary", {
      write(chunk: string) {
        output += chunk;
      },
    });

    writer.write("first line\nsecond");
    writer.write(" line\nthird");
    writer.flush();

    expect(output).toBe("[boundary] first line\n[boundary] second line\n[boundary] third");
  });

  it("aborts sibling steps after the first failure", async () => {
    const startedAt = Date.now();

    await expect(
      runNodeStepsInParallel([
        {
          label: "fail-fast",
          args: ["--eval", "setTimeout(() => process.exit(2), 10)"],
          timeoutMs: 5_000,
        },
        {
          label: "slow-step",
          args: ["--eval", "setTimeout(() => {}, 10_000)"],
          timeoutMs: 5_000,
        },
      ]),
    ).rejects.toThrow("fail-fast failed with exit code 2");

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
