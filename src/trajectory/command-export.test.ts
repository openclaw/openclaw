import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  exportTrajectoryForCommand,
  formatTrajectoryCommandExportSummary,
} from "./command-export.js";
import { loadSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder } from "./runtime.js";
import type { TrajectoryBundleManifest } from "./types.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-trajectory-command-");

const tool = { name: "synthetic_read", description: "Read a synthetic document." };
const complete = { systemPrompt: "Synthetic system prompt.", tools: [tool] };
const oversized = { systemPrompt: "x".repeat(32_769), tools: [tool] };
const cases: Array<{
  name: string;
  contexts: Record<string, unknown>[];
  contextFiles: string[];
  outputPath?: string;
}> = [
  {
    name: "complete context",
    contexts: [complete],
    contextFiles: ["system-prompt.txt", "tools.json"],
    outputPath: "prefix/../~/inventory",
  },
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
    async ({ contexts, contextFiles, outputPath = "inventory" }) => {
      const root = sessionDirs.make();
      const sessionId = "inventory-session";
      const sessionKey = "agent:main:qa-inventory";
      const sessionTarget = {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: path.join(root, "sessions.json"),
      };
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
      await replaceTranscriptEvents(sessionTarget, entries);
      const transcriptBefore = await loadTranscriptEvents(sessionTarget);
      const recorder = await createTrajectoryRuntimeRecorder({
        sessionId,
        sessionKey,
        sessionTarget,
        workspaceDir: root,
        env: { OPENCLAW_TRAJECTORY: "1", OPENCLAW_STATE_DIR: root },
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
      const runtimeBefore = await loadSqliteTrajectoryRuntimeEvents(sessionTarget);

      const result = await exportTrajectoryForCommand({
        sessionTarget,
        sessionId,
        sessionKey,
        workspaceDir: root,
        outputPath,
      });
      expect(result.outputDir).toBe(
        path.resolve(root, ".openclaw", "trajectory-exports", outputPath),
      );
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
      expect(await loadTranscriptEvents(sessionTarget)).toEqual(transcriptBefore);
      expect(await loadSqliteTrajectoryRuntimeEvents(sessionTarget)).toEqual(runtimeBefore);
      expect(result.files).toEqual(expected);
      expect(formatTrajectoryCommandExportSummary(result)).toContain(
        `📁 Files: ${expected.join(", ")}`,
      );
    },
  );

  it.each([".openclaw", ".openclaw/trajectory-exports/alias"])(
    "rejects an escaping %s directory without writing outside the workspace",
    async (relativeLink) => {
      const root = sessionDirs.make();
      const workspaceDir = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      const link = path.join(workspaceDir, relativeLink);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.mkdir(outside);
      await fs.symlink(outside, link, "junction");
      const sessionFile = path.join(root, "session.jsonl");
      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({ type: "session", version: 3, id: "boundary-session", timestamp: "2026-09-01T00:00:00.000Z", cwd: workspaceDir })}\n`,
      );
      await expect(
        exportTrajectoryForCommand({
          sessionFile,
          sessionId: "boundary-session",
          sessionKey: "agent:main:boundary",
          workspaceDir,
          outputPath: "alias/missing/export",
        }),
      ).rejects.toThrow(/workspace|trajectory exports|root/i);
      expect(await fs.readdir(outside)).toEqual([]);
    },
  );
});
