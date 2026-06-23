import { describe, expect, test } from "vitest";
import type { PluginActionCapability } from "./plugin-capability-policy";
import { decidePluginActionPolicy } from "./plugin-capability-policy";

function decide(capabilities: readonly PluginActionCapability[]) {
  return decidePluginActionPolicy({
    pluginId: "test-plugin",
    actionId: "test-action",
    capabilities,
  });
}

describe("decidePluginActionPolicy", () => {
  test("allows read capability only", () => {
    expect(decide(["read"]).kind).toBe("allow");
  });

  test("requires approval for write capability", () => {
    expect(decide(["write"]).kind).toBe("approval_required");
  });

  test("requires approval for send and private_data capabilities", () => {
    expect(decide(["send", "private_data"]).kind).toBe("approval_required");
  });

  test("requires approval for delete capability", () => {
    expect(decide(["delete"]).kind).toBe("approval_required");
  });

  test("requires approval for costly capability", () => {
    expect(decide(["costly"]).kind).toBe("approval_required");
  });

  test("requires approval for secret_access capability", () => {
    expect(decide(["secret_access"]).kind).toBe("approval_required");
  });

  test("denies financial_execution capability", () => {
    expect(decide(["financial_execution"]).kind).toBe("deny");
  });

  test("denies destructive capability", () => {
    expect(decide(["destructive"]).kind).toBe("deny");
  });

  test("requires approval for mixed read and write capabilities", () => {
    expect(decide(["read", "write"]).kind).toBe("approval_required");
  });

  test("denies mixed read and financial_execution capabilities", () => {
    expect(decide(["read", "financial_execution"]).kind).toBe("deny");
  });

  test("denies empty capabilities", () => {
    expect(decide([]).kind).toBe("deny");
  });

  test("populates requiredCapabilities for approval_required decisions", () => {
    const decision = decide(["read", "send"]);

    expect(decision.kind).toBe("approval_required");
    if (decision.kind === "approval_required") {
      expect(decision.requiredCapabilities).toEqual(["send"]);
    }
  });
});
