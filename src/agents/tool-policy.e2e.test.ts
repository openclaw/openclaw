import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./tools/common.js";
import { TOOL_POLICY_CONFORMANCE } from "./tool-policy.conformance.js";
import {
  applyOwnerOnlyToolPolicy,
  expandToolGroups,
  isOwnerOnlyToolName,
  normalizeToolName,
  resolveToolProfilePolicy,
  TOOL_GROUPS,
} from "./tool-policy.js";

describe("tool-policy", () => {
  it("expands groups and normalizes aliases", () => {
    const expanded = expandToolGroups(["group:runtime", "BASH", "apply-patch", "group:fs"]);
    const set = new Set(expanded);
    expect(set.has("exec")).toBe(true);
    expect(set.has("process")).toBe(true);
    expect(set.has("bash")).toBe(false);
    expect(set.has("apply_patch")).toBe(true);
    expect(set.has("read")).toBe(true);
    expect(set.has("write")).toBe(true);
    expect(set.has("edit")).toBe(true);
  });

  it("resolves known profiles and ignores unknown ones", () => {
    const coding = resolveToolProfilePolicy("coding");
    expect(coding?.allow).toContain("group:fs");
    expect(resolveToolProfilePolicy("nope")).toBeUndefined();
  });

  it("includes core tool groups in group:openclaw", () => {
    const group = TOOL_GROUPS["group:openclaw"];
    expect(group).toContain("browser");
    expect(group).toContain("message");
    expect(group).toContain("subagents");
    expect(group).toContain("session_status");
  });

  it("normalizes tool names and aliases", () => {
    expect(normalizeToolName(" BASH ")).toBe("exec");
    expect(normalizeToolName("apply-patch")).toBe("apply_patch");
    expect(normalizeToolName("READ")).toBe("read");
  });

  it("identifies owner-only tools", () => {
    expect(isOwnerOnlyToolName("whatsapp_login")).toBe(true);
    expect(isOwnerOnlyToolName("read")).toBe(false);
  });

  it("strips owner-only tools for non-owner senders", async () => {
    const tools = [
      {
        name: "read",
        // oxlint-disable-next-line typescript/no-explicit-any
        execute: async () => ({ content: [], details: {} }) as any,
      },
      {
        name: "whatsapp_login",
        // oxlint-disable-next-line typescript/no-explicit-any
        execute: async () => ({ content: [], details: {} }) as any,
      },
    ] as unknown as AnyAgentTool[];

    const filtered = applyOwnerOnlyToolPolicy(tools, false);
    expect(filtered.map((t) => t.name)).toEqual(["read"]);
  });

  it("keeps owner-only tools for the owner sender", async () => {
    const tools = [
      {
        name: "read",
        // oxlint-disable-next-line typescript/no-explicit-any
        execute: async () => ({ content: [], details: {} }) as any,
      },
      {
        name: "whatsapp_login",
        // oxlint-disable-next-line typescript/no-explicit-any
        execute: async () => ({ content: [], details: {} }) as any,
      },
    ] as unknown as AnyAgentTool[];

    const filtered = applyOwnerOnlyToolPolicy(tools, true);
    expect(filtered.map((t) => t.name)).toEqual(["read", "whatsapp_login"]);
  });
});

describe("TOOL_POLICY_CONFORMANCE", () => {
  it("matches exported TOOL_GROUPS exactly", () => {
    expect(TOOL_POLICY_CONFORMANCE.toolGroups).toEqual(TOOL_GROUPS);
  });

  it("is JSON-serializable", () => {
    expect(() => JSON.stringify(TOOL_POLICY_CONFORMANCE)).not.toThrow();
  });
});
