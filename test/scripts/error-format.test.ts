import { describe, expect, it } from "vitest";
import { formatErrorMessageWithCauses } from "../../scripts/lib/error-format.mts";

describe("formatErrorMessageWithCauses", () => {
  it("renders the nested transport cause attached by a read owner", () => {
    const transport = new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    const readback = new TypeError("fetch failed", { cause: transport });
    const failure = new Error(
      "https://registry.npmjs.org/openclaw: readback failed. Retry readback, not publication.",
      { cause: readback },
    );

    expect(formatErrorMessageWithCauses(failure)).toBe(
      "https://registry.npmjs.org/openclaw: readback failed. Retry readback, not publication.\n" +
        "Caused by: fetch failed\n" +
        "Caused by: getaddrinfo ENOTFOUND registry.npmjs.org",
    );
  });

  it("bounds cyclic cause chains", () => {
    const failure = new Error("outer");
    failure.cause = failure;

    expect(formatErrorMessageWithCauses(failure)).toBe("outer");
  });
});
