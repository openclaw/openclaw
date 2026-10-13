import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDoctorConfigSnapshot } from "../../commands/doctor-config-snapshot.test-helpers.js";
import { noteStaleUpdateRuns } from "../../commands/doctor-update-run.js";
import * as startupConfigPreflight from "../../commands/startup-config-preflight.js";
import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import { isVerbose, setVerbose } from "../../globals.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { TranscriptSessionDescriptor } from "../../transcripts/provider-types.js";
import { TranscriptsStore } from "../../transcripts/store.js";
import { summarizeTranscripts } from "../../transcripts/summary.js";
import { withConsoleLogsRoutedToStderrForJson } from "../json-output-mode.js";
import { testApi as configGuardTestApi } from "./config-guard.js";
import { registerPreActionHooks } from "./preaction.js";
import { registerTranscriptsCli } from "./register.transcripts.js";

const originalArgv = process.argv;
const originalTitle = process.title;
const originalVerbose = isVerbose();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function storeFor(stateDir: string): TranscriptsStore {
  return new TranscriptsStore(path.join(stateDir, "transcripts"), {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

async function writeSession(stateDir: string, sessionId: string): Promise<string> {
  const session: TranscriptSessionDescriptor = {
    sessionId,
    title: "Design review",
    source: { providerId: "manual-transcript" },
    startedAt: "2026-05-22T10:00:00.000Z",
    stoppedAt: "2026-05-22T10:05:00.000Z",
  };
  const store = storeFor(stateDir);
  const utterance = { text: "Action item: Ship CLI", speaker: { label: "Sam" } };
  await store.writeSession(session);
  await store.appendUtteranceForSession(session, utterance);
  await store.writeSummary(summarizeTranscripts({ session, utterances: [utterance] }), session);
  return store.sessionDir(session);
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    await run();
    return output;
  } finally {
    writeSpy.mockRestore();
  }
}

async function runTranscriptsCli(args: string[], startup = false): Promise<string> {
  return captureStdout(async () => {
    const program = new Command().name("openclaw");
    registerTranscriptsCli(program);
    if (startup) {
      registerPreActionHooks(program, "test");
    }
    await program.parseAsync(["transcripts", ...args], { from: "user" });
  });
}

describe("transcripts CLI", () => {
  let stateDir = "";

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-transcripts-cli-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    configGuardTestApi.resetConfigGuardStateForTests();
    clearRuntimeConfigSnapshot();
    process.argv = originalArgv;
    process.title = originalTitle;
    setVerbose(originalVerbose);
  });

  it("keeps transcript output clean after a successful update with warnings", async () => {
    await writeSession(stateDir, "design-review");
    const args = ["list"];
    const jsonArgs = [...args, "--json"];
    const expected = await runTranscriptsCli(args);
    const expectedJson = await runTranscriptsCli(jsonArgs);
    const run = createUpdateRun({ trigger: "cli" });
    const warning = "Recorded update warning";
    const warningStep = {
      step: "warning:openclaw doctor",
      status: "completed",
      detail: warning,
    } as const;
    recordUpdateRunStep(run.runId, warningStep);
    finishUpdateRun(run.runId, { status: "succeeded" });
    const snapshot = createDoctorConfigSnapshot();
    // Keep real note emission and guard suppression; state migration is outside this output test.
    const preflight = vi
      .spyOn(startupConfigPreflight, "runStartupConfigPreflight")
      .mockImplementation(async () => {
        await noteStaleUpdateRuns();
        return { snapshot, baseConfig: snapshot.config };
      });
    vi.stubEnv("OPENCLAW_SUPPRESS_NOTES", undefined);
    vi.stubEnv("NODE_NO_WARNINGS", process.env.NODE_NO_WARNINGS);
    expect(await captureStdout(() => noteStaleUpdateRuns())).toContain(warning);
    for (const [commandArgs, expectedOutput] of [
      [args, expected],
      [jsonArgs, expectedJson],
    ] as const) {
      configGuardTestApi.resetConfigGuardStateForTests();
      process.argv = ["node", "openclaw", "transcripts", ...commandArgs];
      const output = await withConsoleLogsRoutedToStderrForJson(
        process.argv,
        () => runTranscriptsCli([...commandArgs], true),
        { restoreChanges: true },
      );
      expect(output).toBe(expectedOutput);
    }
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(getUpdateRun(run.runId)?.steps).toContainEqual(expect.objectContaining(warningStep));
    expect(await captureStdout(() => noteStaleUpdateRuns())).toContain(warning);
  });

  it("keeps JSON inspection available before a summary exists", async () => {
    await storeFor(stateDir).writeSession({
      sessionId: "active-session",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-22T10:00:00.000Z",
    });

    const jsonOutput = await runTranscriptsCli(["show", "active-session", "--json"]);

    expect(JSON.parse(jsonOutput)).toMatchObject({
      session: { sessionId: "active-session" },
      summary: null,
    });
    expect(JSON.parse(await runTranscriptsCli(["path", "active-session", "--json"]))).toMatchObject(
      {
        exists: false,
      },
    );
    await expect(runTranscriptsCli(["show", "active-session"])).rejects.toThrow(
      "summary.md not found",
    );
    await expect(runTranscriptsCli(["path", "active-session"])).rejects.toThrow(
      "summary.md not found",
    );
  });

  it("sanitizes stored summary control bytes at the show boundary", async () => {
    await writeSession(stateDir, "legacy-summary");
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const db = getNodeSqliteKysely<
      Pick<OpenClawStateKyselyDatabase, "meeting_transcript_summaries">
    >(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("meeting_transcript_summaries")
        .set({
          markdown: "# Legacy\n\n- first\tcolumn\n- \u001b[2J\u001b[31mADMIN APPROVED\u001b[0m",
        })
        .where("session_id", "=", "legacy-summary"),
    );

    const output = await runTranscriptsCli(["show", "legacy-summary"]);

    expect(output).toContain("# Legacy\n\n- first\\tcolumn\n- ADMIN APPROVED");
    expect(output).not.toContain("\u001b");
  });

  it("sanitizes list selectors and text while escaping C1 bytes in JSON", async () => {
    const title = "\u001b[31mCSI \u009b31m injected \u007f\u0085 title\u001b[0m";
    const sessionId = "ansi-\u001b[31mprovider\u001b[0m";
    await storeFor(stateDir).writeSession({
      sessionId,
      title,
      source: { providerId: "manual-transcript" },
      startedAt: "2026-05-22T10:00:00.000Z",
    });

    const text = await runTranscriptsCli(["list"]);
    expect(text.split("\t")[0]).toBe("2026-05-22/ansi--31mprovider-0m");
    expect(text).not.toContain("\u001b");
    const output = await runTranscriptsCli(["list", "--json"]);

    expect(/[\u007f-\u009f]/.test(output)).toBe(false);
    expect(output).toContain("\\u009b");
    const parsed = JSON.parse(output) as Array<{ sessionId: string; title: string }>;
    expect(parsed).toEqual([expect.objectContaining({ sessionId, title })]);
  });

  it("materializes metadata, transcript, and directory exports from SQLite", async () => {
    const sessionDir = await writeSession(stateDir, "design-review");
    await fs.rm(sessionDir, { recursive: true, force: true });

    const ownershipReads: string[] = [];
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    }).db;
    // Manifest writers retain the same SELECT inside their synchronous transaction.
    // oxlint-disable-next-line typescript/unbound-method -- Preserve the intercepted native receiver below.
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (!this.isTransaction && /^select\b/iu.test(sql) && sql.includes("export_pending_json")) {
        ownershipReads.push(sql);
      }
      return prepare.call(this, sql);
    });
    // The identical writer SELECT may already be prepared and cached before observation.
    // oxlint-disable-next-line typescript/unbound-method -- Preserve the intercepted statement receiver below.
    const get = StatementSync.prototype.get;
    vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (
      this: StatementSync,
      ...args
    ) {
      if (!database.isTransaction && this.sourceSQL.includes("export_pending_json")) {
        ownershipReads.push(this.sourceSQL);
      }
      return get.apply(this, args);
    });

    const metadataOutput = await runTranscriptsCli(["path", "design-review", "--metadata"]);
    const transcriptOutput = await runTranscriptsCli(["path", "design-review", "--transcript"]);
    const dirOutput = await runTranscriptsCli(["path", "design-review", "--dir"]);

    expect(metadataOutput.trim()).toBe(path.join(sessionDir, "metadata.json"));
    expect(transcriptOutput.trim()).toBe(path.join(sessionDir, "transcript.jsonl"));
    expect(dirOutput.trim()).toBe(sessionDir);
    await expect(fs.readFile(path.join(sessionDir, "metadata.json"), "utf8")).resolves.toContain(
      '"sessionId": "design-review"',
    );
    await expect(fs.readFile(path.join(sessionDir, "transcript.jsonl"), "utf8")).resolves.toContain(
      '"text":"Action item: Ship CLI"',
    );
    const summary = await runTranscriptsCli(["show", "design-review"]);
    expect(summary).toContain("Ship CLI");
    expect(JSON.parse(await runTranscriptsCli(["show", "design-review", "--json"])).summary).toBe(
      summary,
    );
    const artifact = JSON.parse(await runTranscriptsCli(["path", "design-review", "--json"]));
    expect(artifact).toMatchObject({ path: path.join(sessionDir, "summary.md"), exists: true });
    expect(ownershipReads, "standalone export ownership SQL on the caller thread").toEqual([]);
  });
});
