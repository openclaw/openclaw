import { describe, expect, it } from "vitest";
import { matchesExecAllowlistPattern } from "./exec-allowlist-pattern.js";

describe("matchesExecAllowlistPattern", () => {
  it("does not let ? cross path separators", () => {
    expect(matchesExecAllowlistPattern("/tmp/a?b", "/tmp/a/b")).toBe(false);
    expect(matchesExecAllowlistPattern("/tmp/a?b", "/tmp/acb")).toBe(true);
  });

  it.runIf(process.platform !== "win32")("preserves case sensitivity on POSIX", () => {
    expect(matchesExecAllowlistPattern("/tmp/Allowed-Tool", "/tmp/allowed-tool")).toBe(false);
    expect(matchesExecAllowlistPattern("/tmp/Allowed-Tool", "/tmp/Allowed-Tool")).toBe(true);
  });
});
