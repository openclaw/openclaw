import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

type Entry = Record<string, unknown>;

function readLines(transcript: string): string[] {
  return fs.readFileSync(transcript, "utf8").trimEnd().split("\n");
}

function writeLines(transcript: string, entries: unknown[]): void {
  fs.writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

/** Issue #172109: a repeated session header is not missing transcript history. */
describe("legacy session migration with a duplicated session header", () => {
  async function withKeptTranscript(
    run: (context: {
      transcript: string;
      importCodes: () => Promise<string[]>;
      header: Entry;
      body: string[];
    }) => Promise<void>,
  ) {
    await withOpenClawTestState({ label: "duplicate-session-header" }, async (state) => {
      const { cfg, storePath } = await seedDeferredPluginSessionSource(state, "default");
      const transcript = path.join(path.dirname(storePath), "legacy-kept.jsonl");
      const lines = readLines(transcript);
      const importCodes = async () => {
        const imported = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          allAgents: true,
          mode: "import",
        });
        return imported.targets.flatMap((target) => target.issues.map((issue) => issue.code));
      };
      await run({
        transcript,
        importCodes,
        header: JSON.parse(lines[0]!) as Entry,
        body: lines.slice(1),
      });
    });
  }

  const earlier = (header: Entry) => ({ ...header, timestamp: "2026-01-01T00:00:00.000Z" });
  const later = (header: Entry) => ({ ...header, timestamp: "2026-01-01T00:00:05.000Z" });

  it("migrates an empty destination when a second session header repeats the session", async () => {
    await withKeptTranscript(async ({ transcript, importCodes, header, body }) => {
      writeLines(transcript, [later(header), ...body, earlier(header)]);

      expect(await importCodes()).not.toContain("sqlite_transcript_count_mismatch");
    });
  });

  it("migrates when SQLite already holds the transcript (reported installation)", async () => {
    await withKeptTranscript(async ({ transcript, importCodes, header, body }) => {
      writeLines(transcript, [later(header), ...body]);
      expect(await importCodes()).not.toContain("sqlite_transcript_count_mismatch");
      writeLines(transcript, [later(header), ...body, earlier(header)]);

      expect(await importCodes()).not.toContain("sqlite_transcript_count_mismatch");
    });
  });
});
