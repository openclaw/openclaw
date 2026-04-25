import { describe, expect, it } from "vitest";
import { resolveCoreToolProfilePolicy } from "./tool-catalog.js";

describe("tool-catalog", () => {
  it("readonly profile allows only non-mutating tools", () => {
    const policy = resolveCoreToolProfilePolicy("readonly");
    expect(policy).toBeDefined();
    const allowed = policy!.allow!;

    // Read-only tools that should be present
    expect(allowed).toContain("read");
    expect(allowed).toContain("web_search");
    expect(allowed).toContain("web_fetch");
    expect(allowed).toContain("x_search");
    expect(allowed).toContain("memory_search");
    expect(allowed).toContain("memory_get");
    expect(allowed).toContain("sessions_list");
    expect(allowed).toContain("sessions_history");
    expect(allowed).toContain("session_status");
    expect(allowed).toContain("image");
    expect(allowed).toContain("agents_list");

    // Mutating tools that must NOT be present
    expect(allowed).not.toContain("write");
    expect(allowed).not.toContain("edit");
    expect(allowed).not.toContain("exec");
    expect(allowed).not.toContain("process");
    expect(allowed).not.toContain("message");
    expect(allowed).not.toContain("cron");
    expect(allowed).not.toContain("gateway");
    expect(allowed).not.toContain("browser");
    expect(allowed).not.toContain("sessions_spawn");
    expect(allowed).not.toContain("sessions_send");
    expect(allowed).not.toContain("sessions_yield");
    expect(allowed).not.toContain("subagents");
    expect(allowed).not.toContain("nodes");
    expect(allowed).not.toContain("canvas");
    expect(allowed).not.toContain("apply_patch");
    expect(allowed).not.toContain("code_execution");
    expect(allowed).not.toContain("tts");
  });

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
    expect(policy!.allow).not.toContain("browser");
  });

  it("includes bundle MCP tools in coding and messaging profile policies", () => {
    expect(resolveCoreToolProfilePolicy("coding")?.allow).toContain("bundle-mcp");
    expect(resolveCoreToolProfilePolicy("messaging")?.allow).toContain("bundle-mcp");
    expect(resolveCoreToolProfilePolicy("minimal")?.allow).not.toContain("bundle-mcp");
  });
});
