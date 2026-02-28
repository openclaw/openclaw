/**
 * ULS Prompt Injection — Unit Tests
 */

import { describe, expect, it } from "vitest";
import { formatRetrievedMemory } from "./prompt-inject.js";
import type { UlsRetrieveResult } from "./types.js";

describe("formatRetrievedMemory", () => {
  it("returns empty string for no records", () => {
    const result: UlsRetrieveResult = { records: [] };
    expect(formatRetrievedMemory(result)).toBe("");
  });

  it("formats records with provenance and section boundaries", () => {
    const result: UlsRetrieveResult = {
      records: [
        {
          recordId: "rec-1",
          agentId: "agent-a",
          timestamp: 1_700_000_000_000,
          modality: "tool_result",
          pPublic: { summary: "Deployed service X", status: "success" },
          tags: ["deployment"],
          riskFlags: [],
          provenance: { sourceTool: "deploy_tool", inputHash: "abc123def456" },
        },
      ],
    };

    const formatted = formatRetrievedMemory(result);
    expect(formatted).toContain("### Retrieved Shared Memory (read-only; provenance-tagged)");
    expect(formatted).toContain("### End Shared Memory");
    expect(formatted).toContain("agent-a");
    expect(formatted).toContain("deploy_tool");
    expect(formatted).toContain("Deployed service X");
  });

  it("includes injection warning when risk flags present", () => {
    const result: UlsRetrieveResult = {
      records: [
        {
          recordId: "rec-1",
          agentId: "agent-x",
          timestamp: Date.now(),
          modality: "user_msg",
          pPublic: { intent: "suspicious content" },
          tags: [],
          riskFlags: ["injection_suspect"],
          provenance: { inputHash: "abc123" },
        },
      ],
    };

    const formatted = formatRetrievedMemory(result);
    expect(formatted).toContain("WARNING");
    expect(formatted).toContain("injection");
  });

  it("truncates when exceeding token budget", () => {
    const records = Array.from({ length: 50 }, (_, i) => ({
      recordId: `rec-${i}`,
      agentId: "agent-a",
      timestamp: Date.now(),
      modality: "tool_result" as const,
      pPublic: { summary: "x".repeat(200) },
      tags: ["bulk"],
      riskFlags: [] as never[],
      provenance: { inputHash: `hash-${i}` },
    }));

    const formatted = formatRetrievedMemory({ records }, 512);
    expect(formatted).toContain("truncated to fit token budget");
    // Should be roughly bounded
    expect(formatted.length).toBeLessThan(512 * 4 + 500); // allow header overhead
  });

  it("never returns raw tool dumps", () => {
    const result: UlsRetrieveResult = {
      records: [
        {
          recordId: "rec-1",
          agentId: "agent-a",
          timestamp: Date.now(),
          modality: "tool_result",
          pPublic: {
            toolName: "bash",
            status: "success",
            summary: "Command completed",
          },
          tags: [],
          riskFlags: [],
          provenance: { sourceTool: "bash", inputHash: "abc" },
        },
      ],
    };

    const formatted = formatRetrievedMemory(result);
    // Ensure it's structured, not raw dump
    expect(formatted).toContain("toolName:");
    expect(formatted).toContain("provenance-tagged");
  });
});
