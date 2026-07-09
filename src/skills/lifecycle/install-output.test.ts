/**
 * Install output tests — UTF-16 safe truncation verification.
 */
import { describe, expect, it } from "vitest";
import { formatInstallFailureMessage } from "./install-output.js";

describe("formatInstallFailureMessage", () => {
  it("keeps bounded install failure messages UTF-16 safe", () => {
    const prefix = "e".repeat(199);
    const msg = `${prefix}\u{1F600}tail`;
    const result = formatInstallFailureMessage({
      code: 1,
      stdout: "",
      stderr: msg,
    });
    expect(result).toContain("…");
    expect(result).not.toContain("\u{1F600}");
  });

  it("truncates long stderr output to ~200 chars", () => {
    const result = formatInstallFailureMessage({
      code: 1,
      stdout: "",
      stderr: "error: " + "x".repeat(300),
    });
    expect(result).toContain("…");
  });

  it("uses stdout when stderr is empty", () => {
    const result = formatInstallFailureMessage({
      code: 1,
      stdout: "error: something failed",
      stderr: "",
    });
    expect(result).toContain("error: something failed");
  });
});
