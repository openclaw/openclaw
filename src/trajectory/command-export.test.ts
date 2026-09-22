import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  exportTrajectoryForCommand,
  formatTrajectoryCommandExportSummary,
} from "./command-export.js";
import { resolveTrajectoryFilePath } from "./paths.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";
import type { TrajectoryBundleManifest, TrajectoryEvent } from "./types.js";

const tool = { name: "synthetic_read", description: "Read a synthetic document." };
const complete = { systemPrompt: "Synthetic system prompt.", tools: [tool] };
const oversized = { systemPrompt: "x".repeat(32_769), tools: [tool] };
const cases: Array<{
  name: string;
  contexts: Record<string, unknown>[];
  contextFiles: string[];
}> = [
  { name: "no context", contexts: [], contextFiles: [] },
  {
    name: "complete context",
    contexts: [complete],
    contextFiles: ["system-prompt.txt", "tools.json"],
  },
  { name: "oversized prompt", contexts: [oversized], contextFiles: ["tools.json"] },
  {
    name: "empty prompt",
    contexts: [{ systemPrompt: "", tools: [] }],
    contextFiles: ["tools.json"],
  },
  {
    name: "latest truncated context",
    contexts: [complete, oversized],
    contextFiles: ["tools.json"],
  },
  {
    name: "oversized event",
    contexts: [
      {
        systemPrompt: "Synthetic system prompt.",
        prompt: "Synthetic request.",
        tools: Array.from({ length: 12 }, (_, index) => ({
          name: `synthetic_${index}`,
          description: "x".repeat(32_000),
        })),
      },
    ],
    contextFiles: [],
  },
];

describe("trajectory command export inventory", () => {
  it.each(cases)(
    "reports only written files in existing order for $name",
    async ({ contexts, contextFiles }) => {
      await withTempDir("openclaw-trajectory-inventory-", async (root) => {
        const sessionId = "inventory-session";
        const sessionKey = "agent:main:qa-inventory";
        const sessionFile = path.join(root, "session.jsonl");
        const entries = [
          {
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: "2026-09-01T00:00:00.000Z",
            cwd: root,
          },
          {
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-09-01T00:00:01.000Z",
            message: { role: "user", content: "Synthetic inventory request.", timestamp: 1 },
          },
        ];
        const sessionBytes = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
        await fs.writeFile(sessionFile, sessionBytes);
        const runtimeFile = resolveTrajectoryFilePath({ env: {}, sessionFile, sessionId });
        const writes: string[] = [];
        const recorder = createTrajectoryRuntimeRecorder({
          sessionId,
          sessionKey,
          sessionFile,
          workspaceDir: root,
          env: { OPENCLAW_TRAJECTORY: "1" },
          writer: {
            filePath: runtimeFile,
            write: (line) => {
              writes.push(line);
            },
            flush: async () => {},
          },
        });
        if (!recorder) {
          throw new Error("Expected the synthetic recorder to be enabled");
        }
        recorder.recordEvent("trace.metadata", { harness: { id: "synthetic" } });
        recorder.recordEvent("prompt.submitted", { prompt: "Synthetic inventory request." });
        for (const context of contexts) {
          recorder.recordEvent("context.compiled", context);
        }
        recorder.recordEvent("model.completed", { stopReason: "stop" });
        await recorder.flush();
        expect(writes).toHaveLength(contexts.length + 3);
        const recorded = writes.map((line) => JSON.parse(line) as TrajectoryEvent);
        const latest = recorded.findLast((event) => event.type === "context.compiled")?.data;
        expect(typeof latest?.systemPrompt === "string" && latest.systemPrompt.length > 0).toBe(
          contextFiles.includes("system-prompt.txt"),
        );
        expect(Array.isArray(latest?.tools)).toBe(contextFiles.includes("tools.json"));
        const runtimeBytes = writes.join("");
        await fs.writeFile(runtimeFile, runtimeBytes);

        const result = await exportTrajectoryForCommand({
          sessionFile,
          sessionId,
          sessionKey,
          workspaceDir: root,
          outputPath: "inventory",
        });
        const manifest = JSON.parse(
          await fs.readFile(path.join(result.outputDir, "manifest.json"), "utf8"),
        ) as TrajectoryBundleManifest;
        const written = await fs.readdir(result.outputDir);
        const expected = [
          "manifest.json",
          "events.jsonl",
          "session-branch.json",
          ...contextFiles,
          "metadata.json",
          "artifacts.json",
          "prompts.json",
        ];
        expect(written.toSorted()).toEqual(expected.toSorted());
        expect(
          ["manifest.json", ...(manifest.contents ?? []).map((file) => file.path)].toSorted(),
        ).toEqual(written.toSorted());
        expect(result.sessionId).toBe(sessionId);
        expect(result.eventCount).toBe(contexts.length + 4);
        expect(result.runtimeEventCount).toBe(contexts.length + 3);
        expect(result.transcriptEventCount).toBe(1);
        expect(await fs.readFile(sessionFile, "utf8")).toBe(sessionBytes);
        expect(await fs.readFile(runtimeFile, "utf8")).toBe(runtimeBytes);
        expect(result.files).toEqual(expected);
        expect(formatTrajectoryCommandExportSummary(result)).toContain(
          `📁 Files: ${expected.join(", ")}`,
        );
      });
    },
  );
});
