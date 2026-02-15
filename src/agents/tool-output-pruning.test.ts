import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  findProtectedBoundary,
  getToolLimit,
  pruneToolResultText,
  pruneToolResults,
  readFullToolOutput,
  resolveToolPruningConfig,
  saveFullToolOutput,
} from "./tool-output-pruning.js";

function makeToolResult(text: string, toolName = "read"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${Math.random().toString(36).slice(2)}`,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeAssistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as AgentMessage;
}

// Cleanup temp files
const tempDir = path.join(os.tmpdir(), "openclaw-tool-outputs");
afterAll(async () => {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("resolveToolPruningConfig", () => {
  it("returns defaults when no config", () => {
    const config = resolveToolPruningConfig();
    expect(config.maxToolResultTokens).toBe(3000);
    expect(config.headRatio).toBe(0.4);
    expect(config.tailRatio).toBe(0.1);
    expect(config.protectLastAssistantTurns).toBe(3);
    expect(config.perToolLimits.browser).toBe(2000);
    expect(config.perToolLimits.bash).toBe(4000);
  });
});

describe("getToolLimit", () => {
  const config = resolveToolPruningConfig();

  it("returns per-tool limit when available", () => {
    expect(getToolLimit("browser", config)).toBe(2000);
    expect(getToolLimit("bash", config)).toBe(4000);
  });

  it("returns default for unknown tools", () => {
    expect(getToolLimit("custom_tool", config)).toBe(3000);
  });

  it("returns default for undefined tool name", () => {
    expect(getToolLimit(undefined, config)).toBe(3000);
  });
});

describe("pruneToolResultText", () => {
  it("returns unchanged text when under limit", () => {
    const result = pruneToolResultText({
      text: "short text",
      maxTokens: 1000,
      headRatio: 0.4,
      tailRatio: 0.1,
    });
    expect(result.pruned).toBe(false);
    expect(result.text).toBe("short text");
  });

  it("prunes oversized text with head+tail preservation", () => {
    const text = "A".repeat(4000) + "B".repeat(4000) + "C".repeat(4000);
    const result = pruneToolResultText({
      text,
      maxTokens: 1000, // 4000 chars
      headRatio: 0.4,
      tailRatio: 0.1,
      fullOutputPath: "/tmp/test.txt",
    });

    expect(result.pruned).toBe(true);
    expect(result.text.length).toBeLessThan(text.length);
    // Head should be preserved (first 40% of 4000 = 1600 chars)
    expect(result.text.startsWith("A".repeat(1600))).toBe(true);
    // Tail should be preserved (last 10% of 4000 = 400 chars)
    expect(result.text.endsWith("C".repeat(400))).toBe(true);
    // Placeholder should be present
    expect(result.text).toContain("CONTENT PRUNED");
    expect(result.text).toContain("/tmp/test.txt");
  });
});

describe("saveFullToolOutput and readFullToolOutput", () => {
  it("saves and retrieves full output", async () => {
    const text = "Full tool output content for testing";
    const filePath = await saveFullToolOutput(text, "test_tool");

    expect(filePath).toContain("openclaw-tool-outputs");
    expect(filePath).toContain("test_tool");

    const { content, found } = await readFullToolOutput(filePath);
    expect(found).toBe(true);
    expect(content).toBe(text);
  });

  it("returns not found for missing files", async () => {
    const { found } = await readFullToolOutput("/tmp/openclaw-tool-outputs/nonexistent.txt");
    expect(found).toBe(false);
  });

  it("rejects paths outside tool output directory", async () => {
    const { found, content } = await readFullToolOutput("/etc/passwd");
    expect(found).toBe(false);
    expect(content).toContain("Access denied");
  });
});

describe("findProtectedBoundary", () => {
  it("protects last N assistant turns", () => {
    const messages = [
      makeUserMessage("msg1"),
      makeAssistantMessage("resp1"),
      makeUserMessage("msg2"),
      makeAssistantMessage("resp2"),
      makeUserMessage("msg3"),
      makeAssistantMessage("resp3"),
    ];
    // Protect last 2 assistant turns: resp2 (index 3) and resp3 (index 5)
    // The boundary should be at index 3
    expect(findProtectedBoundary(messages, 2)).toBe(3);
  });

  it("returns 0 when fewer assistant turns than protect count", () => {
    const messages = [makeUserMessage("msg1"), makeAssistantMessage("resp1")];
    expect(findProtectedBoundary(messages, 5)).toBe(0);
  });

  it("returns messages.length when protect count is 0", () => {
    const messages = [makeUserMessage("msg1")];
    expect(findProtectedBoundary(messages, 0)).toBe(1);
  });
});

describe("pruneToolResults", () => {
  const config = resolveToolPruningConfig();

  it("does not prune small tool results", async () => {
    const messages = [makeUserMessage("hello"), makeToolResult("small result")];
    const { messages: result, prunedCount } = await pruneToolResults({
      messages,
      config,
    });
    expect(prunedCount).toBe(0);
    expect(result).toEqual(messages);
  });

  it("prunes oversized tool results", async () => {
    const bigText = "x".repeat(50_000); // Way over 3000 * 4 = 12000 chars
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading file"),
      makeToolResult(bigText),
      makeAssistantMessage("done1"),
      makeAssistantMessage("done2"),
      makeAssistantMessage("done3"),
      makeAssistantMessage("done4"),
    ];
    const { messages: result, prunedCount } = await pruneToolResults({
      messages,
      config,
    });
    expect(prunedCount).toBe(1);
    const prunedMsg = result[2] as { content: Array<{ text: string }> };
    expect(prunedMsg.content[0].text.length).toBeLessThan(bigText.length);
    expect(prunedMsg.content[0].text).toContain("CONTENT PRUNED");
  });

  it("protects last 3 assistant turns from pruning", async () => {
    const bigText = "x".repeat(50_000);
    const messages = [
      makeUserMessage("msg1"),
      makeAssistantMessage("resp1"),
      makeToolResult(bigText, "read"), // index 2: outside protected zone
      makeAssistantMessage("resp2"),
      makeUserMessage("msg2"),
      makeAssistantMessage("resp3"), // index 5: 3rd-to-last assistant
      makeUserMessage("msg3"),
      makeAssistantMessage("resp4"), // index 7: 2nd-to-last assistant
      makeToolResult(bigText, "read"), // index 8: inside protected zone (after boundary)
      makeAssistantMessage("resp5"), // index 9: last assistant
    ];
    const { prunedCount } = await pruneToolResults({
      messages,
      config,
    });
    // findProtectedBoundary returns index 5 (3rd-to-last assistant)
    // Tool result at index 2 is before the boundary so it gets pruned
    // Tool result at index 8 is at or after the boundary so it's protected
    expect(prunedCount).toBe(1);
  });
});
