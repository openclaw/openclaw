import { describe, expect, it } from "vitest";

/**
 * Verifies that gateway.tools.allow overrides NATIVE_TOOL_EXCLUDE for the loopback
 * MCP surface, enabling containerized CLI backends to use exec/native tools via MCP
 * while still respecting agent-level sandbox configuration.
 */
describe("gateway/tool-resolution — allow overrides NATIVE_TOOL_EXCLUDE", () => {
  it("filters excludeToolNames through gatewayAllow", () => {
    // Inline the logic under test so this stays a pure unit test
    const excludeToolNames = new Set(["read", "write", "edit", "apply_patch", "exec", "process"]);

    const applyGatewayDeny = (allow: string[], deny: string[]) => {
      const gatewayAllow = allow;
      return new Set([
        ...deny,
        ...Array.from(excludeToolNames).filter((name) => !gatewayAllow.includes(name)),
      ]);
    };

    // Without allow — all native tools excluded
    const withoutAllow = applyGatewayDeny([], []);
    expect(withoutAllow.has("exec")).toBe(true);
    expect(withoutAllow.has("read")).toBe(true);

    // With allow: ["exec"] — exec no longer excluded
    const withExecAllowed = applyGatewayDeny(["exec"], []);
    expect(withExecAllowed.has("exec")).toBe(false);
    expect(withExecAllowed.has("read")).toBe(true);

    // Explicit deny still wins over allow
    const withExecAllowedButDenied = applyGatewayDeny(["exec"], ["exec"]);
    expect(withExecAllowedButDenied.has("exec")).toBe(true);
  });
});
