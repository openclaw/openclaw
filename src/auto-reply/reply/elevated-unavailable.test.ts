import { describe, expect, it } from "vitest";
import { formatElevatedUnavailableMessage } from "./elevated-unavailable.js";

describe("formatElevatedUnavailableMessage", () => {
  it("explains sandboxed elevation failures with next-step guidance", () => {
    const text = formatElevatedUnavailableMessage({
      runtimeSandboxed: true,
      failures: [{ gate: "allowFrom", key: "tools.elevated.allowFrom.discord" }],
      sessionKey: "agent:trinity:discord:channel:123",
    });

    expect(text).toContain("blocked by policy + sandbox");
    expect(text).toContain("runtime=sandboxed");
    expect(text).toContain("Next:");
    expect(text).toContain("/workspace/memory/...");
    expect(text).toContain("Retryable: yes");
  });

  it("explains direct elevation failures as policy-gated", () => {
    const text = formatElevatedUnavailableMessage({
      runtimeSandboxed: false,
      failures: [],
      sessionKey: "agent:morpheus:main",
    });

    expect(text).toContain("blocked by policy");
    expect(text).toContain("runtime=direct");
    expect(text).toContain("Check session/channel policy or approval state");
    expect(text).toContain("Retryable: yes");
  });
});
