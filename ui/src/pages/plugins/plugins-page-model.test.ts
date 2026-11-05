import { describe, expect, it } from "vitest";
import { pluginMutationBlockedReason } from "./plugins-page-model.ts";

describe("plugin mutation access copy", () => {
  it("distinguishes a member restriction from a browser missing admin access", () => {
    const access = { connected: true, hasAdminAccess: false, mutationAllowed: true };
    expect(pluginMutationBlockedReason({ ...access, actorKind: "member" })).toBe(
      "You need admin access to change plugins.",
    );
    expect(pluginMutationBlockedReason({ ...access, actorKind: "browser" })).toBe(
      "This browser doesn’t have admin access. Reconnect with admin access to change plugins.",
    );
  });

  it("prioritizes reconnecting and preserves server mutation policy", () => {
    const access = {
      connected: false,
      hasAdminAccess: true,
      mutationAllowed: false,
      actorKind: "browser" as const,
    };
    expect(pluginMutationBlockedReason(access)).toBe("Reconnect to change plugins.");
    expect(pluginMutationBlockedReason({ ...access, connected: true })).toBe(
      "Plugin changes are disabled.",
    );
    expect(
      pluginMutationBlockedReason({ ...access, connected: true, mutationAllowed: true }),
    ).toBeNull();
  });
});
