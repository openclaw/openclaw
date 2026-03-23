import { describe, expect, it } from "vitest";
import { ToolsSchema } from "./zod-schema.agent-runtime.js";

/**
 * Tests for tools.exec.allowedHosts validation (superRefine rules).
 */
describe("tools.exec.allowedHosts Zod validation", () => {
  function parseExecConfig(exec: Record<string, unknown>) {
    return ToolsSchema.safeParse({ exec });
  }

  it("accepts allowedHosts: [gateway, sandbox] when host=gateway", () => {
    const result = parseExecConfig({ host: "gateway", allowedHosts: ["gateway", "sandbox"] });
    expect(result.success).toBe(true);
  });

  it("accepts allowedHosts: [sandbox] when host=sandbox (same host, no elevation)", () => {
    const result = parseExecConfig({ host: "sandbox", allowedHosts: ["sandbox"] });
    expect(result.success).toBe(true);
  });

  it("rejects allowedHosts with gateway when host=sandbox (container escape)", () => {
    const result = parseExecConfig({ host: "sandbox", allowedHosts: ["sandbox", "gateway"] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error)).toContain("allowedHosts");
    }
  });

  it("rejects allowedHosts with node when host=sandbox (container escape)", () => {
    const result = parseExecConfig({ host: "sandbox", allowedHosts: ["sandbox", "node"] });
    expect(result.success).toBe(false);
  });

  it("rejects allowedHosts with node when host=gateway (unknown trust boundary)", () => {
    const result = parseExecConfig({ host: "gateway", allowedHosts: ["gateway", "node"] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error)).toContain("allowedHosts");
    }
  });

  it("rejects allowedHosts with non-node when host=node", () => {
    const result = parseExecConfig({ host: "node", allowedHosts: ["node", "gateway"] });
    expect(result.success).toBe(false);
  });

  it("accepts absent allowedHosts (backward-compatible)", () => {
    const result = parseExecConfig({ host: "gateway", security: "allowlist" });
    expect(result.success).toBe(true);
  });

  it("accepts allowedHosts: [node] when host=node", () => {
    const result = parseExecConfig({ host: "node", allowedHosts: ["node"] });
    expect(result.success).toBe(true);
  });

  it("accepts allowedHosts without host (host inherited from global config)", () => {
    // An agent-only block with allowedHosts but no host is valid — host is
    // inherited from global tools.exec.host at runtime. Validation must not
    // assume the default sandbox host in this case.
    const result = parseExecConfig({ allowedHosts: ["gateway", "sandbox"] });
    expect(result.success).toBe(true);
  });

  it("accepts allowedHosts: [gateway, sandbox] without host", () => {
    const result = parseExecConfig({ allowedHosts: ["gateway", "sandbox"], security: "allowlist" });
    expect(result.success).toBe(true);
  });
});
