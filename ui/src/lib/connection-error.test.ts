// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatConnectionError, formatConnectionErrorSummary } from "./connection-error.ts";

// mock-isolation: the connection must report failure even when offline asset loading fails.
vi.mock("./format-error.ts", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});

afterEach(() => vi.restoreAllMocks());

describe("connection errors without the optional formatter", () => {
  it("retains a redacted network failure when the formatter chunk cannot load", async () => {
    const error = new Error("Connection refused: token=synthetic-credential-value");
    expect(await formatConnectionError(error)).toBe("Connection refused: token=[redacted]");
    expect(formatConnectionErrorSummary(new TypeError("Failed to fetch"))).toBe("Failed to fetch");
  });

  it("keeps access guidance available offline without printing a protocol scope", async () => {
    const error = Object.assign(new Error("permission denied"), {
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.read",
        requiredScopes: ["operator.read"],
      },
    });
    expect(await formatConnectionError(error)).toBe(
      "Couldn’t complete this request. Ask an admin to grant read access.",
    );
  });

  it("keeps programming details in diagnostics and reports the failure once", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new TypeError("Cannot read properties of undefined");
    expect(await formatConnectionError(error)).toBe("Request failed");
    expect(formatConnectionErrorSummary(error)).toBe("Request failed");
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      "[control-ui] programming error hidden from the UI:",
      error,
    );
  });
});
