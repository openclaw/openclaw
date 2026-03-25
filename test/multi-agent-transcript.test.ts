/**
 * Tests for Multi-Agent Group Transcript Feature
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  resolveMultiAgentTranscriptConfig,
  platformNeedsTranscript,
  shouldLogResponse,
  formatTranscriptEntry,
  listMultiAgentGroupIds,
  parseTranscriptEntry,
} from "../src/config/multi-agent-groups.js";
import {
  injectMultiAgentTranscript,
  pruneTranscript,
} from "../src/context-engine/multi-agent-transcript.js";
import type { OpenClawConfig } from "../src/config/config.js";

describe("Multi-Agent Group Transcript", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openclaw-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("Config Resolution", () => {
    it("returns null when no multiAgentGroups config exists", () => {
      const cfg = {} as OpenClawConfig;
      expect(resolveMultiAgentTranscriptConfig(cfg, "group123")).toBeNull();
    });

    it("returns null for unconfigured group", () => {
      const cfg = {
        multiAgentGroups: {
          "other-group": {
            transcriptPath: "/tmp/transcript.md",
          },
        },
      } as unknown as OpenClawConfig;
      expect(resolveMultiAgentTranscriptConfig(cfg, "group123")).toBeNull();
    });

    it("returns config with defaults for configured group", () => {
      const cfg = {
        multiAgentGroups: {
          "group123": {
            transcriptPath: "/tmp/transcript.md",
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveMultiAgentTranscriptConfig(cfg, "group123");
      expect(result).not.toBeNull();
      expect(result?.contextLimit).toBe(20);
      expect(result?.pruneAfterHours).toBe(48);
      expect(result?.format).toBe("markdown");
      expect(result?.enabled).toBe(true);
    });

    it("respects explicit config values", () => {
      const cfg = {
        multiAgentGroups: {
          "group123": {
            transcriptPath: "/tmp/transcript.md",
            contextLimit: 50,
            pruneAfterHours: 24,
            format: "json",
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveMultiAgentTranscriptConfig(cfg, "group123");
      expect(result?.contextLimit).toBe(50);
      expect(result?.pruneAfterHours).toBe(24);
      expect(result?.format).toBe("json");
    });

    it("returns null when group is explicitly disabled", () => {
      const cfg = {
        multiAgentGroups: {
          "group123": {
            transcriptPath: "/tmp/transcript.md",
            enabled: false,
          },
        },
      } as unknown as OpenClawConfig;

      expect(resolveMultiAgentTranscriptConfig(cfg, "group123")).toBeNull();
    });

    it("expands ~ in transcript path", () => {
      const cfg = {
        multiAgentGroups: {
          "group123": {
            transcriptPath: "~/test/transcript.md",
          },
        },
      } as unknown as OpenClawConfig;

      const result = resolveMultiAgentTranscriptConfig(cfg, "group123");
      expect(result?.resolvedPath).not.toContain("~");
      expect(result?.resolvedPath).toContain("test/transcript.md");
    });
  });

  describe("Platform Detection", () => {
    it("returns true for Telegram (needs transcript)", () => {
      expect(platformNeedsTranscript("telegram")).toBe(true);
    });

    it("returns true for Signal (needs transcript)", () => {
      expect(platformNeedsTranscript("signal")).toBe(true);
    });

    it("returns false for Slack (native bot visibility)", () => {
      expect(platformNeedsTranscript("slack")).toBe(false);
    });

    it("returns false for Discord (native bot visibility)", () => {
      expect(platformNeedsTranscript("discord")).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(platformNeedsTranscript("TELEGRAM")).toBe(true);
      expect(platformNeedsTranscript("SLACK")).toBe(false);
    });
  });

  describe("Response Filtering", () => {
    it("returns false for empty string", () => {
      expect(shouldLogResponse("")).toBe(false);
    });

    it("returns false for whitespace-only", () => {
      expect(shouldLogResponse("   \n\t  ")).toBe(false);
    });

    it("returns false for NO_REPLY", () => {
      expect(shouldLogResponse("NO_REPLY")).toBe(false);
    });

    it("returns false for NO_REPLY with whitespace", () => {
      expect(shouldLogResponse("  NO_REPLY  ")).toBe(false);
    });

    it("returns true for normal content", () => {
      expect(shouldLogResponse("Hello, this is a response")).toBe(true);
    });

    it("returns true for content containing NO_REPLY as part of text", () => {
      expect(shouldLogResponse("The agent said NO_REPLY earlier")).toBe(true);
    });
  });

  describe("Entry Formatting", () => {
    it("formats markdown entry correctly", () => {
      const entry = {
        timestamp: new Date("2026-03-24T21:30:00Z"),
        agentId: "forge",
        content: "Test response content",
      };

      const formatted = formatTranscriptEntry(entry, "markdown");
      expect(formatted).toContain("### 2026-03-24 21:30:00 - forge");
      expect(formatted).toContain("Test response content");
    });

    it("formats JSON entry correctly", () => {
      const entry = {
        timestamp: new Date("2026-03-24T21:30:00Z"),
        agentId: "forge",
        content: "Test response content",
      };

      const formatted = formatTranscriptEntry(entry, "json");
      const parsed = JSON.parse(formatted);
      expect(parsed.agentId).toBe("forge");
      expect(parsed.content).toBe("Test response content");
      expect(parsed.timestamp).toBe("2026-03-24T21:30:00.000Z");
    });

    it("truncates long content in markdown format", () => {
      const longContent = "A".repeat(300);
      const entry = {
        timestamp: new Date("2026-03-24T21:30:00Z"),
        agentId: "forge",
        content: longContent,
      };

      const formatted = formatTranscriptEntry(entry, "markdown");
      expect(formatted.length).toBeLessThan(longContent.length + 100);
      expect(formatted).toContain("...");
    });

    it("parses hyphenated agent IDs correctly", () => {
      const line = "### 2026-03-24 21:30:00 - my-agent-id";
      const result = parseTranscriptEntry(line, "markdown");
      
      expect(result).not.toBeNull();
      expect(result?.agentId).toBe("my-agent-id");
    });

    it("handles underscores and numbers in agent IDs", () => {
      const line = "### 2026-03-24 21:30:00 - agent_v2_test";
      const result = parseTranscriptEntry(line, "markdown");
      
      expect(result).not.toBeNull();
      expect(result?.agentId).toBe("agent_v2_test");
    });
  });

  describe("List Group IDs", () => {
    it("returns empty array when no config", () => {
      const cfg = {} as OpenClawConfig;
      expect(listMultiAgentGroupIds(cfg)).toEqual([]);
    });

    it("returns configured group IDs", () => {
      const cfg = {
        multiAgentGroups: {
          "group1": { transcriptPath: "/tmp/t1.md" },
          "group2": { transcriptPath: "/tmp/t2.md" },
        },
      } as unknown as OpenClawConfig;

      const ids = listMultiAgentGroupIds(cfg);
      expect(ids).toContain("group1");
      expect(ids).toContain("group2");
    });

    it("excludes disabled groups", () => {
      const cfg = {
        multiAgentGroups: {
          "group1": { transcriptPath: "/tmp/t1.md" },
          "group2": { transcriptPath: "/tmp/t2.md", enabled: false },
        },
      } as unknown as OpenClawConfig;

      const ids = listMultiAgentGroupIds(cfg);
      expect(ids).toContain("group1");
      expect(ids).not.toContain("group2");
    });
  });

  describe("Context Injection", () => {
    it("returns null when platform does not need transcript", async () => {
      const cfg = {
        multiAgentGroups: {
          "group123": { transcriptPath: join(tempDir, "transcript.md") },
        },
      } as unknown as OpenClawConfig;

      const result = await injectMultiAgentTranscript({
        cfg,
        channel: "slack",
        groupId: "group123",
        agentId: "forge",
      });

      expect(result).toBeNull();
    });

    it("returns null when no config for group", async () => {
      const cfg = {} as OpenClawConfig;

      const result = await injectMultiAgentTranscript({
        cfg,
        channel: "telegram",
        groupId: "group123",
        agentId: "forge",
      });

      expect(result).toBeNull();
    });

    it("returns null when transcript file does not exist", async () => {
      const cfg = {
        multiAgentGroups: {
          "group123": { transcriptPath: join(tempDir, "nonexistent.md") },
        },
      } as unknown as OpenClawConfig;

      const result = await injectMultiAgentTranscript({
        cfg,
        channel: "telegram",
        groupId: "group123",
        agentId: "forge",
      });

      expect(result).toBeNull();
    });

    it("filters out own agent entries", async () => {
      const transcriptPath = join(tempDir, "transcript.md");
      await writeFile(
        transcriptPath,
        `### 2026-03-24 21:30:00 - forge
My own message

### 2026-03-24 21:31:00 - jarvis
Peer message
`,
      );

      const cfg = {
        multiAgentGroups: {
          "group123": { transcriptPath, pruneAfterHours: 9999 },
        },
      } as unknown as OpenClawConfig;

      const result = await injectMultiAgentTranscript({
        cfg,
        channel: "telegram",
        groupId: "group123",
        agentId: "forge",
      });

      expect(result).not.toBeNull();
      expect(result).toContain("jarvis");
      expect(result).not.toContain("My own message");
    });

    it("includes context header with limits", async () => {
      const transcriptPath = join(tempDir, "transcript.md");
      await writeFile(
        transcriptPath,
        `### 2026-03-24 21:30:00 - jarvis
Peer message
`,
      );

      const cfg = {
        multiAgentGroups: {
          "group123": {
            transcriptPath,
            contextLimit: 20,
            pruneAfterHours: 48,
          },
        },
      } as unknown as OpenClawConfig;

      const result = await injectMultiAgentTranscript({
        cfg,
        channel: "telegram",
        groupId: "group123",
        agentId: "forge",
      });

      expect(result).toContain("## Peer Agent Activity");
      expect(result).toContain("last 20 entries");
      expect(result).toContain("up to 48h");
    });

    it("handles JSON format transcript", async () => {
      const transcriptPath = join(tempDir, "transcript.jsonl");
      const entry1 = JSON.stringify({
        timestamp: new Date(Date.now() - 1000).toISOString(),
        agentId: "jarvis",
        content: "JSON peer message",
      });
      const entry2 = JSON.stringify({
        timestamp: new Date(Date.now() - 500).toISOString(),
        agentId: "forge",
        content: "Own message to filter",
      });

      await writeFile(transcriptPath, `${entry1}\n${entry2}\n`);

      const cfg = {
        multiAgentGroups: {
          "group123": {
            transcriptPath,
            format: "json",
            pruneAfterHours: 9999,
          },
        },
      } as unknown as OpenClawConfig;

      const result = await injectMultiAgentTranscript({
        cfg,
        channel: "telegram",
        groupId: "group123",
        agentId: "forge",
      });

      expect(result).not.toBeNull();
      expect(result).toContain("jarvis");
      expect(result).toContain("JSON peer message");
      expect(result).not.toContain("Own message to filter");
    });
  });

  describe("Pruning", () => {
    it("removes old entries based on pruneAfterHours", async () => {
      const transcriptPath = join(tempDir, "transcript.md");

      // Create entries: one old, one recent
      const oldDate = new Date(Date.now() - 72 * 60 * 60 * 1000); // 72h ago
      const recentDate = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12h ago

      const oldEntry = `### ${oldDate.toISOString().replace("T", " ").slice(0, 19)} - forge
Old message`;
      const recentEntry = `### ${recentDate.toISOString().replace("T", " ").slice(0, 19)} - jarvis
Recent message`;

      await writeFile(transcriptPath, `${oldEntry}\n\n${recentEntry}\n`);

      const result = await pruneTranscript(transcriptPath, "markdown", 48);

      expect(result.removed).toBe(1);
      expect(result.remaining).toBe(1);

      const content = await readFile(transcriptPath, "utf-8");
      expect(content).not.toContain("Old message");
      expect(content).toContain("Recent message");
    });

    it("returns zero removed when nothing to prune", async () => {
      const transcriptPath = join(tempDir, "transcript.md");
      const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1h ago

      await writeFile(
        transcriptPath,
        `### ${recentDate.toISOString().replace("T", " ").slice(0, 19)} - forge
Recent message
`,
      );

      const result = await pruneTranscript(transcriptPath, "markdown", 48);

      expect(result.removed).toBe(0);
      expect(result.remaining).toBe(1);
    });
  });
});
