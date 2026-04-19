import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { ObservabilityIngestor } from "./ingestor.js";
import {
  buildSyntheticObservabilityDataset,
  writeSyntheticObservabilityFiles,
} from "./synthetic-data.js";

type QueryEventRow = {
  source_type: string;
  event_type: string;
  message_preview: string | null;
};

function openDbRows(dbPath: string, query: string): QueryEventRow[] {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(query).all() as QueryEventRow[];
  } finally {
    db.close();
  }
}

describe("ObservabilityIngestor QA coverage", () => {
  afterEach(async () => {
    // Avoid leaking watchers if a test exits early.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });

  it("runs end-to-end ingestion from synthetic channel session logs to SQLite queries", async () => {
    await withTempDir("observability-e2e-", async (tempDir) => {
      const stateDir = path.join(tempDir, "state");
      const dbPath = path.join(tempDir, "observability.db");
      const dataset = buildSyntheticObservabilityDataset({
        channels: ["telegram", "discord", "slack"],
        messagesPerChannel: 2,
        agentId: "qa-agent",
      });
      const files = await writeSyntheticObservabilityFiles({
        rootDir: stateDir,
        agentId: "qa-agent",
        dataset,
        systemFileName: "openclaw-e2e.log",
      });

      const ingestor = new ObservabilityIngestor({
        dbPath,
        watchedPaths: [
          { pattern: files.sessionFile, sourceType: "session" },
          { pattern: files.cacheTraceFile, sourceType: "cache-trace" },
          { pattern: files.systemLogFile, sourceType: "system-log" },
        ],
        stateDir,
      });

      try {
        const result = await ingestor.ingestExisting();
        expect(result.files).toBe(3);
        expect(result.events).toBeGreaterThanOrEqual(10);

        const rows = openDbRows(
          dbPath,
          "SELECT source_type, event_type, message_preview FROM events ORDER BY id",
        );
        expect(rows.some((row) => row.source_type === "session")).toBe(true);
        expect(rows.some((row) => row.source_type === "cache-trace")).toBe(true);
        expect(rows.some((row) => row.source_type === "system-log")).toBe(true);
        expect(
          rows.some(
            (row) =>
              row.event_type === "session:message:user" &&
              typeof row.message_preview === "string" &&
              row.message_preview.includes("[telegram]"),
          ),
        ).toBe(true);
      } finally {
        await ingestor.close();
      }
    });
  });

  it("detects file rotation and re-ingests from the beginning", async () => {
    await withTempDir("observability-rotation-", async (tempDir) => {
      const sessionFile = path.join(tempDir, "rotation.jsonl");
      const dbPath = path.join(tempDir, "observability.db");

      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "session",
          version: 1,
          id: "rotation-session",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/a/very/long/path/that/makes/the/first/line/longer/than/the/replacement",
        })}\n`,
        "utf8",
      );

      const ingestor = new ObservabilityIngestor({
        dbPath,
        watchedPaths: [{ pattern: sessionFile, sourceType: "session" }],
      });

      try {
        const firstCount = await ingestor.ingestFile(sessionFile, "session");
        expect(firstCount).toBe(1);

        await fs.writeFile(
          sessionFile,
          `${JSON.stringify({
            type: "ok",
          })}\n`,
          "utf8",
        );

        const rotatedCount = await ingestor.ingestFile(sessionFile, "session");
        expect(rotatedCount).toBe(1);

        const rows = openDbRows(
          dbPath,
          "SELECT source_type, event_type, message_preview FROM events ORDER BY id",
        );
        expect(rows.length).toBe(2);
        expect(rows[1]?.event_type).toBe("session:ok");
      } finally {
        await ingestor.close();
      }
    });
  });

  it("ingests live updates in watch mode", async () => {
    await withTempDir("observability-watch-", async (tempDir) => {
      const sessionFile = path.join(tempDir, "watch-session.jsonl");
      const dbPath = path.join(tempDir, "observability.db");

      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "session",
          version: 1,
          id: "watch-session",
          timestamp: "2026-01-01T00:00:00.000Z",
        })}\n`,
        "utf8",
      );

      const ingestor = new ObservabilityIngestor({
        dbPath,
        watchedPaths: [{ pattern: sessionFile, sourceType: "session" }],
      });

      try {
        await ingestor.startWatching();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });

        await fs.appendFile(
          sessionFile,
          `${JSON.stringify({
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "[discord] live update" }],
              provider: "openai",
              model: "gpt-5.4",
              timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
            },
          })}\n`,
          "utf8",
        );

        (
          ingestor as unknown as {
            onFileChange: (event: {
              path: string;
              sourceType: "session" | "cache-trace" | "system-log";
              eventType: "add" | "change" | "unlink";
            }) => void;
          }
        ).onFileChange({
          path: sessionFile,
          sourceType: "session",
          eventType: "change",
        });
        await (
          ingestor as unknown as {
            processPendingFiles: () => Promise<void>;
          }
        ).processPendingFiles();
        expect(ingestor.status().totalEvents).toBeGreaterThanOrEqual(2);
        const rows = openDbRows(
          dbPath,
          "SELECT source_type, event_type, message_preview FROM events ORDER BY id",
        );
        expect(rows.some((row) => row.message_preview?.includes("[discord] live update"))).toBe(
          true,
        );
      } finally {
        await ingestor.close();
      }
    });
  });

  it("handles large synthetic session files without dropping events", async () => {
    await withTempDir("observability-large-", async (tempDir) => {
      const sessionFile = path.join(tempDir, "large-session.jsonl");
      const dbPath = path.join(tempDir, "observability.db");
      const totalMessages = 3_000;

      const header = JSON.stringify({
        type: "session",
        version: 1,
        id: "large-session",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      const lines = [header];
      for (let index = 0; index < totalMessages; index += 1) {
        lines.push(
          JSON.stringify({
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: `[telegram] perf message #${index + 1}` }],
              provider: "openai",
              model: "gpt-5.4",
              timestamp: Date.parse("2026-01-01T00:00:00.000Z") + index,
            },
          }),
        );
      }
      await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, "utf8");

      const ingestor = new ObservabilityIngestor({
        dbPath,
        watchedPaths: [{ pattern: sessionFile, sourceType: "session" }],
      });

      try {
        const startedAt = Date.now();
        const result = await ingestor.ingestExisting();
        const elapsedMs = Date.now() - startedAt;

        expect(result.files).toBe(1);
        expect(result.events).toBe(totalMessages + 1);
        expect(elapsedMs).toBeLessThan(15_000);

        const rows = openDbRows(
          dbPath,
          "SELECT source_type, event_type, message_preview FROM events ORDER BY id DESC LIMIT 1",
        );
        expect(rows[0]?.message_preview).toContain("perf message");
      } finally {
        await ingestor.close();
      }
    });
  });
});
