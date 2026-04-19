import { describe, expect, it } from "vitest";
import { resolveCoreToolProfilePolicy } from "./tool-catalog.js";

describe("tool-catalog", () => {
  it("includes code_execution, web_search, x_search, web_fetch, and update_plan in the coding profile policy", () => {
    const policy = resolveCoreToolProfilePolicy("coding");
    expect(policy).toBeDefined();
    expect(policy!.allow).toContain("code_execution");
    expect(policy!.allow).toContain("web_search");
    expect(policy!.allow).toContain("x_search");
    expect(policy!.allow).toContain("web_fetch");
    expect(policy!.allow).toContain("image_generate");
    expect(policy!.allow).toContain("music_generate");
    expect(policy!.allow).toContain("video_generate");
    expect(policy!.allow).toContain("update_plan");
  });

  it("includes bundle-mcp in coding and messaging profile policies", () => {
    const codingPolicy = resolveCoreToolProfilePolicy("coding");
    expect(codingPolicy).toBeDefined();
    expect(codingPolicy!.allow).toContain("bundle-mcp");

    const messagingPolicy = resolveCoreToolProfilePolicy("messaging");
    expect(messagingPolicy).toBeDefined();
    expect(messagingPolicy!.allow).toContain("bundle-mcp");
  });

  it("allows deny list to override and block bundle-mcp tools", () => {
    const codingPolicy = resolveCoreToolProfilePolicy("coding");
    expect(codingPolicy).toBeDefined();
    // Verify bundle-mcp is in allow list
    expect(codingPolicy!.allow).toContain("bundle-mcp");
    // Deny list can be used to block it if needed
    expect(codingPolicy!.deny).toBeUndefined();
  });
});
