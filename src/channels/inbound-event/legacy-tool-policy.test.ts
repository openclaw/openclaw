import { expect, it, vi } from "vitest";
import { resolveLegacyConversationToolPolicy } from "./legacy-tool-policy.js";

it("retains an external request policy and warns once with its lifetime and migration", () => {
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  try {
    expect(resolveLegacyConversationToolPolicy(undefined)).toBeUndefined();
    expect(warning).not.toHaveBeenCalled();
    const policy = { allow: ["read"] };
    expect(resolveLegacyConversationToolPolicy(policy)).toBe(policy);
    expect(resolveLegacyConversationToolPolicy(policy)).toBe(policy);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toContain("security.resolveDirectToolPolicy");
    expect(warning.mock.calls[0]?.[0]).toContain("original request, including its queued turn");
    expect(warning.mock.calls[0]?.[0]).toContain("announced deprecation window");
    expect(warning.mock.calls[0]?.[0]).toContain("explicit maintainer approval");
    expect(warning.mock.calls[0]?.[0]).toContain("no removal date is set");
  } finally {
    warning.mockRestore();
  }
});
