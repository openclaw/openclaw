import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateSyntheticObservabilityFixture } from "../../scripts/generate-observability-synthetic.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  buildSyntheticObservabilityDataset,
  writeSyntheticObservabilityFiles,
} from "./synthetic-data.js";

describe("synthetic observability data", () => {
  it("builds dataset with channel-formatted messages", () => {
    const dataset = buildSyntheticObservabilityDataset({
      channels: ["telegram", "discord"],
      messagesPerChannel: 1,
      sessionId: "session-qa",
      agentId: "agent-qa",
    });

    expect(dataset.sessionLines.length).toBe(3);
    expect(dataset.cacheTraceLines.length).toBe(2);
    expect(dataset.systemLogLines.length).toBe(2);
    expect(dataset.sessionLines[1]).toContain("[telegram]");
    expect(dataset.sessionLines[2]).toContain("[discord]");
  });

  it("writes synthetic jsonl files in expected layout", async () => {
    await withTempDir("observability-synthetic-files-", async (tempDir) => {
      const result = await writeSyntheticObservabilityFiles({
        rootDir: tempDir,
        agentId: "agent-e2e",
      });

      const sessionContent = await fs.readFile(result.sessionFile, "utf8");
      const cacheContent = await fs.readFile(result.cacheTraceFile, "utf8");
      const systemContent = await fs.readFile(result.systemLogFile, "utf8");
      expect(sessionContent).toContain('"type":"session"');
      expect(cacheContent).toContain('"stage":"session:after"');
      expect(systemContent).toContain('"logLevelName":"INFO"');
      expect(path.basename(result.sessionFile)).toBe("synthetic-session.jsonl");
    });
  });

  it("script entry generates files from CLI-style args", async () => {
    await withTempDir("observability-synthetic-script-", async (tempDir) => {
      const output = await generateSyntheticObservabilityFixture([
        "--out",
        tempDir,
        "--channels",
        "telegram,discord",
        "--messages-per-channel",
        "2",
        "--agent-id",
        "agent-script",
      ]);

      expect(output.sessionFile).toContain(path.join("agents", "agent-script", "sessions"));
      const sessionContent = await fs.readFile(output.sessionFile, "utf8");
      const lines = sessionContent.trim().split("\n");
      expect(lines.length).toBe(1 + 4);
    });
  });
});
