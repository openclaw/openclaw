import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportTrajectoryCommand } from "../commands/export-trajectory.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
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
  json?: boolean;
}> = [
  {
    name: "complete context",
    contexts: [complete],
    contextFiles: ["system-prompt.txt", "tools.json"],
    outputPath: "prefix/../~/inventory",
  },
  {
    name: "double-dot-prefixed output directory",
    contexts: [complete],
    contextFiles: ["system-prompt.txt", "tools.json"],
    outputPath: "..diagnostics",
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
    json: true,
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
    json: true,
  },
];

describe("trajectory command export inventory", () => {
  it.each(cases)(
    "reports only written files in existing order for $name",
    async ({ contexts, contextFiles, outputPath = "inventory", json }) => {
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
      await replaceSessionEntry(sessionTarget, { sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(sessionTarget, entries);
      const transcriptBefore = await loadTranscriptEvents(sessionTarget);
      const recorder = await createTrajectoryRuntimeRecorder({
        sessionId,
        sessionKey,
        sessionTarget,
        workspaceDir: root,
        env: { ...process.env, OPENCLAW_TRAJECTORY: "1" },
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

      const runtime = createTestRuntime();
      await exportTrajectoryCommand(
        {
          sessionKey,
          store: sessionTarget.storePath,
          workspace: root,
          output: outputPath,
          json,
        },
        runtime,
      );
      const outputDir = path.resolve(root, ".openclaw", "trajectory-exports", outputPath);
      const manifest = JSON.parse(
        await fs.readFile(path.join(outputDir, "manifest.json"), "utf8"),
      ) as TrajectoryBundleManifest;
      const written = await fs.readdir(outputDir);
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
      expect(manifest.sessionId).toBe(sessionId);
      expect(manifest.eventCount).toBe(contexts.length + 4);
      expect(manifest.runtimeEventCount).toBe(contexts.length + 3);
      expect(manifest.transcriptEventCount).toBe(1);
      expect(await loadTranscriptEvents(sessionTarget)).toEqual(transcriptBefore);
      expect(await loadSqliteTrajectoryRuntimeEvents(sessionTarget)).toEqual(runtimeBefore);
      expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
        json
          ? JSON.stringify(
              {
                outputDir,
                displayPath: path.join(
                  ".openclaw",
                  "trajectory-exports",
                  path.normalize(outputPath),
                ),
                sessionId,
                eventCount: contexts.length + 4,
                runtimeEventCount: contexts.length + 3,
                transcriptEventCount: 1,
                files: expected,
              },
              null,
              2,
            )
          : [
              "✅ Trajectory exported!",
              "",
              `📦 Bundle: ${path.join(".openclaw", "trajectory-exports", path.normalize(outputPath))}`,
              `🧵 Session: ${sessionId}`,
              `📊 Events: ${contexts.length + 4}`,
              `🧪 Runtime events: ${contexts.length + 3}`,
              "📝 Transcript events: 1",
              `📁 Files: ${expected.join(", ")}`,
            ].join("\n"),
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
      const sessionTarget = {
        agentId: "main",
        sessionId: "boundary-session",
        sessionKey: "agent:main:boundary",
        storePath: path.join(root, "sessions.json"),
      };
      await replaceSessionEntry(sessionTarget, {
        sessionId: sessionTarget.sessionId,
        updatedAt: 1,
      });
      await replaceTranscriptEvents(sessionTarget, [
        {
          type: "session",
          version: 3,
          id: sessionTarget.sessionId,
          timestamp: "2026-09-01T00:00:00.000Z",
          cwd: workspaceDir,
        },
      ]);
      await expect(
        exportTrajectoryCommand(
          {
            sessionKey: sessionTarget.sessionKey,
            store: sessionTarget.storePath,
            workspace: workspaceDir,
            output: "alias/missing/export",
          },
          createTestRuntime(),
        ),
      ).rejects.toThrow(/workspace|trajectory exports|root/i);
      expect(await fs.readdir(outside)).toEqual([]);
    },
  );
});
