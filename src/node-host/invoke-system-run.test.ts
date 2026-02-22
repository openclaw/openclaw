import { describe, expect, it } from "vitest";
import { formatSystemRunAllowlistMissMessage } from "./invoke-system-run.js";

describe("formatSystemRunAllowlistMissMessage", () => {
  it("returns legacy allowlist miss message by default", () => {
    expect(formatSystemRunAllowlistMissMessage()).toBe("SYSTEM_RUN_DENIED: allowlist miss");
  });

  it("adds Windows shell-wrapper guidance when blocked by cmd.exe policy", () => {
    expect(
      formatSystemRunAllowlistMissMessage({
        windowsShellWrapperBlocked: true,
      }),
    ).toContain("Windows shell wrappers like cmd.exe /c require approval");
  });
});
