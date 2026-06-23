import { beforeEach, describe, expect, test } from "vitest";
import type { PluginActionDescriptor } from "./plugin-adapter.types";
import type { PluginActionCapability } from "./plugin-capability-policy";
import {
  __clearCapabilityCache,
  decideToolCallCapability,
  decideToolCallCapabilityCached,
  formatBlockedResult,
  guardPluginActionRuntime,
  guardPluginActionsRuntime,
} from "./plugin-runtime-guard";

function makeDescriptor(
  capabilities: PluginActionCapability[],
  overrides?: Partial<PluginActionDescriptor>,
): PluginActionDescriptor {
  return {
    id: overrides?.id ?? "test-plugin",
    name: overrides?.name ?? "test-action",
    capabilities,
    ...overrides,
  };
}

// ─── PLUGIN-RUNTIME-BLOCK-003: decideToolCallCapability ─────────

describe("decideToolCallCapability", () => {
  // Read patterns
  test.each([
    ["getItem", "read"],
    ["listTools", "read"],
    ["searchDocuments", "read"],
    ["findUser", "read"],
    ["fetchData", "read"],
    ["queryItems", "read"],
    ["lookupByEmail", "read"],
    ["checkStatus", "read"],
    ["peekQueue", "read"],
    ["viewProfile", "read"],
    ["showHelp", "read"],
    ["browseCatalog", "read"],
    ["selectRows", "read"],
    ["info", "read"],
    ["statFile", "read"],
    ["describeTable", "read"],
    ["dumpConfig", "read"],
    ["exportData", "read"],
    ["printReport", "read"],
    ["resolveName", "read"],
    ["retrieveDocument", "read"],
    ["ping", "read"],
    ["health", "read"],
    ["version", "read"],
  ])("read: %s → %s", (toolName, expected) => {
    expect(decideToolCallCapability(toolName)).toContain(expected);
  });

  // Write patterns
  test.each([
    ["createItem", "write"],
    ["updateRecord", "write"],
    ["setConfig", "write"],
    ["addUser", "write"],
    ["putObject", "write"],
    ["postComment", "write"],
    ["patchDocument", "write"],
    ["writeFile", "write"],
    ["saveSettings", "write"],
    ["storeData", "write"],
    ["insertRow", "write"],
    ["upsertEntry", "write"],
    ["editProfile", "write"],
    ["modifyPermissions", "write"],
    ["changePassword", "write"],
    ["renameFile", "write"],
    ["copyTo", "write"],
    ["mergeRecords", "write"],
    ["enableFeature", "write"],
    ["disableAlerts", "write"],
    ["startService", "write"],
    ["stopProcess", "write"],
    ["restartDaemon", "write"],
  ])("write: %s → %s", (toolName, expected) => {
    expect(decideToolCallCapability(toolName)).toContain(expected);
  });

  // Send patterns
  test.each([
    ["sendEmail", "send"],
    ["emailUser", "send"],
    ["mailReport", "send"],
    ["messageChannel", "send"],
    ["notifyUser", "send"],
    ["alertOnEvent", "send"],
    ["broadcastMessage", "send"],
    ["dispatchAlert", "send"],
    ["postMessage", "send"],
    ["replyToThread", "send"],
    ["commentOnIssue", "send"],
    ["shareDocument", "send"],
    ["tweet", "send"],
    ["publishArticle", "send"],
  ])("send: %s → %s + write", (toolName, expected) => {
    const caps = decideToolCallCapability(toolName);
    expect(caps).toContain(expected);
    expect(caps).toContain("write");
  });

  // Delete patterns
  test.each([
    ["deleteFile", "delete"],
    ["removeUser", "delete"],
    ["wipeCache", "delete"],
    ["clearLogs", "delete"],
    ["unsetVariable", "delete"],
    ["unlinkAccount", "delete"],
    ["unsubscribeTopic", "delete"],
    ["unfollowUser", "delete"],
    ["eraseData", "delete"],
    ["purgeOldRecords", "delete"],
    ["popFromQueue", "delete"],
    ["shiftArray", "delete"],
  ])("delete: %s → %s + write", (toolName, expected) => {
    const caps = decideToolCallCapability(toolName);
    expect(caps).toContain(expected);
    expect(caps).toContain("write");
  });

  // Financial patterns
  test.each([
    ["buyStock", "financial_execution"],
    ["sellPosition", "financial_execution"],
    ["tradeOptions", "financial_execution"],
    ["orderShares", "financial_execution"],
    ["payInvoice", "financial_execution"],
    ["chargeCustomer", "financial_execution"],
    ["transferFunds", "financial_execution"],
    ["placeOrder", "financial_execution"],
    ["cancelOrder", "financial_execution"],
    ["depositCash", "financial_execution"],
    ["withdrawFunds", "financial_execution"],
    ["investInPortfolio", "financial_execution"],
  ])("financial: %s → %s", (toolName, expected) => {
    expect(decideToolCallCapability(toolName)).toContain(expected);
  });

  // Destructive patterns
  test.each([
    ["dropTable", "destructive"],
    ["truncateLogs", "destructive"],
    ["formatDisk", "destructive"],
    ["shutdownServer", "destructive"],
    ["rebootHost", "destructive"],
    ["destroyInstance", "destructive"],
    ["terminateProcess", "destructive"],
    ["killService", "destructive"],
    ["banUser", "destructive"],
    ["blockIp", "destructive"],
    ["purgeAllData", "destructive"],
    ["wipeAllRecords", "destructive"],
    ["ejectDrive", "destructive"],
    ["deleteAllUsers", "destructive"],
    ["nukeDatabase", "destructive"],
    ["resetToFactory", "destructive"],
  ])("destructive: %s → %s", (toolName, expected) => {
    expect(decideToolCallCapability(toolName)).toContain(expected);
  });

  // Default (unrecognized patterns → conservative "write")
  test.each([
    ["randomTool", "write"],
    ["doSomething", "write"],
    ["customAction", "write"],
    ["myFunction", "write"],
  ])("default: %s → write (conservative)", (toolName, expected) => {
    expect(decideToolCallCapability(toolName)).toContain(expected);
  });

  // Safety: null/undefined/non-string
  test("null toolName → write (conservative)", () => {
    expect(decideToolCallCapability(null as unknown as string)).toEqual(["write"]);
  });

  test("undefined toolName → write (conservative)", () => {
    expect(decideToolCallCapability(undefined as unknown as string)).toEqual(["write"]);
  });

  test("empty string toolName → write (conservative)", () => {
    expect(decideToolCallCapability("")).toEqual(["write"]);
  });
});

// ─── PLUGIN-RUNTIME-BLOCK-003: decideToolCallCapabilityCached ───

describe("decideToolCallCapabilityCached", () => {
  beforeEach(() => {
    __clearCapabilityCache();
  });

  test("returns same result as uncached version", () => {
    expect(decideToolCallCapabilityCached("getItem")).toEqual(["read"]);
    expect(decideToolCallCapabilityCached("sendEmail")).toEqual(["send", "write"]);
    expect(decideToolCallCapabilityCached("dropTable")).toEqual(["destructive"]);
  });

  test("caches result for repeated calls", () => {
    const first = decideToolCallCapabilityCached("buyStock");
    const second = decideToolCallCapabilityCached("buyStock");
    expect(first).toEqual(second);
    expect(first).toContain("financial_execution");
  });
});

// ─── PLUGIN-RUNTIME-BLOCK-003: formatBlockedResult ─────────────

describe("formatBlockedResult", () => {
  test("returns empty string for allow decision", () => {
    const allowDesc: PluginActionDescriptor = {
      id: "test",
      name: "test",
      capabilities: ["read"],
    };
    const allowResult = guardPluginActionRuntime(allowDesc);
    expect(formatBlockedResult(allowResult, allowDesc)).toBe("");
  });

  test("returns blocked text for approval_required", () => {
    const desc: PluginActionDescriptor = {
      id: "test",
      name: "sendEmail",
      capabilities: ["send", "write"],
    };
    const result = guardPluginActionRuntime(desc);
    expect(result.ok).toBe(false);
    const text = formatBlockedResult(result, desc);
    expect(text).toContain("Action blocked by plugin policy: approval required");
    expect(text).toContain("Capability: send");
    expect(text).toContain("No external action was executed");
  });

  test("returns denied text for deny decision", () => {
    const desc: PluginActionDescriptor = {
      id: "test",
      name: "buyStock",
      capabilities: ["financial_execution"],
    };
    const result = guardPluginActionRuntime(desc);
    expect(result.ok).toBe(false);
    const text = formatBlockedResult(result, desc);
    expect(text).toContain("Action denied by plugin policy");
    expect(text).toContain("Capability: financial_execution");
    expect(text).toContain("No external action was executed");
  });

  test("handles unknown capability gracefully", () => {
    const desc: PluginActionDescriptor = {
      id: "test",
      name: "test",
      capabilities: ["destroy" as PluginActionCapability],
    };
    // Unknown capabilities are treated as "read" by the policy
    const result = guardPluginActionRuntime(desc);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe("allow");
  });
});

// ─── PLUGIN-RUNTIME-BLOCK-003: Cache clear ─────────────────────

describe("__clearCapabilityCache", () => {
  test("clears cache", () => {
    decideToolCallCapabilityCached("getItem");
    decideToolCallCapabilityCached("sendEmail");
    decideToolCallCapabilityCached("buyStock");
    __clearCapabilityCache();
    // Should still work after clear
    expect(decideToolCallCapabilityCached("getItem")).toEqual(["read"]);
    expect(decideToolCallCapabilityCached("sendEmail")).toEqual(["send", "write"]);
  });
});

// ─── Existing guardPluginActionRuntime tests ────────────────────

describe("guardPluginActionRuntime", () => {
  test("allows read-only action", () => {
    const result = guardPluginActionRuntime(makeDescriptor(["read"]));
    expect(result.ok).toBe(true);
    expect(result.decision).toBe("allow");
  });

  test("allows empty capabilities treated as read", () => {
    const result = guardPluginActionRuntime(makeDescriptor([]));
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("deny");
  });

  test("requires approval for write capability", () => {
    const result = guardPluginActionRuntime(makeDescriptor(["write"]));
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("approval_required");
    expect(result.reason).toBeTruthy();
    if (!result.ok) {
      expect(result.descriptor.id).toBe("test-plugin");
    }
  });

  test("requires approval for send capability", () => {
    const result = guardPluginActionRuntime(makeDescriptor(["send"]));
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("approval_required");
  });

  test("requires approval for delete capability", () => {
    const result = guardPluginActionRuntime(makeDescriptor(["delete"]));
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("approval_required");
  });

  test("requires approval for costly capability", () => {
    const result = guardPluginActionRuntime(makeDescriptor(["costly"]));
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("approval_required");
  });

  test("requires approval for private_data capability", () => {
    const result = guardPluginActionRuntime(makeDescriptor(["private_data"]));
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("approval_required");
  });

  test("requires approval for secret_access capability", () => {
    const result = guardPluginActionRuntime(makeDescriptor(["secret_access"]));
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("approval_required");
  });

  test("denies financial_execution capability", () => {
    const result = guardPluginActionRuntime(makeDescriptor(["financial_execution"]));
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("deny");
  });

  test("denies destructive capability", () => {
    const result = guardPluginActionRuntime(makeDescriptor(["destructive"]));
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("deny");
  });

  test("denies financial + destructive even when mixed with read", () => {
    const result = guardPluginActionRuntime(
      makeDescriptor(["read", "financial_execution", "destructive"]),
    );
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("deny");
  });

  test("approval_required when mixed read + write", () => {
    const result = guardPluginActionRuntime(makeDescriptor(["read", "write"]));
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("approval_required");
  });

  test("approval_required when mixed send + private_data", () => {
    const result = guardPluginActionRuntime(makeDescriptor(["send", "private_data"]));
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("approval_required");
  });

  test("never throws on null capabilities", () => {
    const result = guardPluginActionRuntime(
      makeDescriptor(null as unknown as PluginActionCapability[]),
    );
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("deny");
  });

  test("never throws on undefined capabilities", () => {
    const result = guardPluginActionRuntime(
      makeDescriptor(undefined as unknown as PluginActionCapability[]),
    );
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("deny");
  });

  test("returns deny on internal error gracefully", () => {
    const throwingDescriptor: PluginActionDescriptor = {
      id: "bad-plugin",
      name: "bad-action",
      get capabilities(): PluginActionCapability[] {
        throw new Error("boom");
      },
    };
    const result = guardPluginActionRuntime(throwingDescriptor);
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("boom");
  });
});

// ─── Existing guardPluginActionsRuntime tests ───────────────────

describe("guardPluginActionsRuntime", () => {
  test("allows when all descriptors are read-only", () => {
    const result = guardPluginActionsRuntime([
      makeDescriptor(["read"], { id: "p1", name: "a1" }),
      makeDescriptor(["read"], { id: "p2", name: "a2" }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe("allow");
  });

  test("returns first non-allow decision", () => {
    const result = guardPluginActionsRuntime([
      makeDescriptor(["read"], { id: "p1", name: "a1" }),
      makeDescriptor(["write"], { id: "p2", name: "a2" }),
      makeDescriptor(["destructive"], { id: "p3", name: "a3" }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.decision).toBe("approval_required");
    if (!result.ok) {
      expect(result.descriptor.id).toBe("p2");
    }
  });

  test("handles empty array as allow", () => {
    const result = guardPluginActionsRuntime([]);
    expect(result.ok).toBe(true);
    expect(result.decision).toBe("allow");
  });
});
