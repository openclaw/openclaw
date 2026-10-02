import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runDoctorSessionSqlite } from "../commands/doctor-session-sqlite.js";
import { resolveLegacyTranscriptPaths } from "../config/sessions/legacy-store-inspection.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { isSessionSqliteMigrationWarning } from "./session-sqlite-migration-issues.js";
import { readSessionStoreJson5 } from "./state-migrations.fs.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { materializeUpdateCandidateStateWorker } from "./update-candidate-state.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it.each([
  {
    name: "refuses unsupported default input",
    external: false,
    unsupported: true,
    invalidEntry: false,
    json5: false,
  },
  {
    name: "imports supported external input privately",
    external: true,
    unsupported: false,
    invalidEntry: false,
    json5: false,
  },
  {
    name: "imports supported JSON5 input privately",
    external: true,
    unsupported: false,
    invalidEntry: false,
    json5: true,
  },
  {
    name: "retains invalid rows for Doctor diagnostics",
    external: true,
    unsupported: false,
    invalidEntry: true,
    json5: false,
  },
])("rehearsal Doctor $name", async ({ external, unsupported, invalidEntry, json5 }) => {
  const root = roots.make("rehearsal-sessions-");
  const stateDir = path.join(root, "source");
  const sessionDir = external
    ? path.join(root, "external", "sessions")
    : path.join(stateDir, "agents", "main", "sessions");
  const storePath = path.join(sessionDir, "sessions.json");
  const transcriptPath = path.join(
    json5 ? path.join(root, "foreign", "agents", "main", "sessions") : sessionDir,
    "session-1.jsonl",
  );
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const storeJson = JSON.stringify({
    "agent:main:main": {
      sessionId: "session-1",
      sessionFile: transcriptPath,
      updatedAt: 1,
      model: "gpt-5.5",
      ...(unsupported ? { room: "retired-room" } : { modelProvider: "openai", channel: "cli" }),
    },
    ...(invalidEntry ? { "agent:main:invalid": { sessionId: "   ", updatedAt: 1 } } : {}),
  });
  const originalStore = json5
    ? `// operator-authored session index\n${storeJson.slice(0, -1)},}`
    : storeJson;
  const originalTranscript =
    '{"type":"session","id":"session-1","version":3}\n' +
    '{"type":"message","id":"message-1","message":{"role":"user","content":"preserved history"}}\n';
  await fs.writeFile(storePath, originalStore, { mode: 0o600 });
  await fs.writeFile(transcriptPath, originalTranscript, { mode: 0o600 });
  const config: OpenClawConfig = {
    agents: { entries: { main: {} } },
    ...(external ? { session: { store: storePath } } : {}),
  };
  if (json5) {
    expect(
      resolveLegacyTranscriptPaths(
        { agentId: "main", storePath },
        { sessionId: "session-1", sessionFile: transcriptPath },
        undefined,
        { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      ).transcriptPath,
    ).toBe(transcriptPath);
  }
  const candidateRoot = path.join(root, "candidate");
  await materializeUpdateCandidateStateWorker(candidateRoot);
  const rehearsal = await prepareUpdateCandidateRehearsal({
    config,
    stateDir,
    candidateRoot,
    env: {
      ...process.env,
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    },
  });
  try {
    const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
    if (json5) {
      const index = readSessionStoreJson5(copied.session!.store!);
      expect(index.ok).toBe(true);
      const selected = index.store["agent:main:main"]?.sessionFile;
      expect(selected).toEqual(expect.stringContaining(`${rehearsal.stateDir}${path.sep}`));
      expect(await fs.readFile(String(selected), "utf8")).toBe(originalTranscript);
    }
    // Use the real import owner: an empty rehearsal must not stand in for the serving inputs.
    const doctor = runDoctorSessionSqlite({
      cfg: copied,
      env: rehearsal.env,
      mode: "import",
      allAgents: true,
    });
    if (unsupported) {
      await expect(doctor).rejects.toThrow('Session field "room" predates July 2026');
    } else {
      const report = await doctor;
      expect(report.totals.importedEntries).toBe(1);
      if (invalidEntry) {
        expect(report.targets.flatMap((entry) => entry.issues)).toContainEqual(
          expect.objectContaining({ code: "entry_invalid" }),
        );
      } else if (json5) {
        // Import is allowed; the archive owner preserves transcripts outside the index directory.
        const issues = report.targets.flatMap((entry) => entry.issues);
        expect(report.totals.issues).toBe(1);
        expect(issues).toEqual([
          expect.objectContaining({
            code: "transcript_archive_failed",
            message: expect.stringContaining(
              "Migration source is outside the target sessions directory",
            ),
          }),
        ]);
        expect(issues[0]!.message).toContain(rehearsal.stateDir);
        expect(isSessionSqliteMigrationWarning(issues[0]!)).toBe(true);
      } else {
        expect(report.totals.issues).toBe(0);
      }
      const target = report.targets.find((entry) => entry.agentId === "main");
      expect(target).toBeDefined();
      const session = loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: target!.storePath,
        env: rehearsal.env,
      });
      expect(session?.entry).toMatchObject({ modelProvider: "openai", model: "gpt-5.5" });
      expect(target!.sqlitePath.startsWith(`${rehearsal.stateDir}${path.sep}`)).toBe(true);
    }
    expect(await fs.readFile(storePath, "utf8")).toBe(originalStore);
    expect(await fs.readFile(transcriptPath, "utf8")).toBe(originalTranscript);
    await expect(fs.access(path.join(stateDir, "state", "openclaw.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await closeOpenClawAgentDatabasesAsync(rehearsal.stateDir);
    await rehearsal.cleanup();
  }
});

it("keeps an explicit external SQLite selector on its copied physical database", async () => {
  const directory = roots.make("rehearsal-external-sqlite-");
  const source = path.join(directory, "external", "custom.sqlite");
  await fs.mkdir(path.dirname(source), { recursive: true });
  const database = openNodeSqliteDatabase(source);
  try {
    database.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('selected database');",
    );
  } finally {
    database.close();
  }
  const original = await fs.readFile(source);
  const sourceEntries = await fs.readdir(path.dirname(source));
  const candidateRoot = path.join(directory, "candidate");
  await materializeUpdateCandidateStateWorker(candidateRoot);
  const rehearsal = await prepareUpdateCandidateRehearsal({
    config: { agents: { entries: { main: {} } }, session: { store: source } },
    stateDir: path.join(directory, "source"),
    candidateRoot,
    env: { ...process.env, HOME: directory, OPENCLAW_HOME: directory },
  });
  try {
    const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
    expect(copied.session?.store?.startsWith(`${rehearsal.stateDir}${path.sep}`)).toBe(true);
    const snapshot = openNodeSqliteDatabase(copied.session!.store!, { readOnly: true });
    try {
      expect(snapshot.prepare("SELECT value FROM evidence").all()).toEqual([
        { value: "selected database" },
      ]);
    } finally {
      snapshot.close();
    }
    expect(await fs.readFile(source)).toEqual(original);
    expect(await fs.readdir(path.dirname(source))).toEqual(sourceEntries);
  } finally {
    await rehearsal.cleanup();
  }
});

it("captures the live Doctor transcript selection while its worker uses a private environment", async () => {
  await withOpenClawTestState({ label: "rehearsal-source-environment" }, async (state) => {
    await state.writeText("agents/main/sessions/example.jsonl", "current-state transcript");
    const foreign = state.path("foreign", "agents", "main", "sessions", "example.jsonl");
    await fs.mkdir(path.dirname(foreign), { recursive: true });
    await fs.writeFile(foreign, "older foreign transcript");
    const storePath = state.path("external-store", "sessions.json");
    await fs.mkdir(path.dirname(storePath));
    const original = JSON.stringify({
      "agent:main:main": { sessionId: "example", sessionFile: foreign, updatedAt: 1 },
    });
    await fs.writeFile(storePath, original);
    const candidateRoot = state.path("candidate");
    await materializeUpdateCandidateStateWorker(candidateRoot);
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config: { agents: { entries: { main: {} } }, session: { store: storePath } },
      stateDir: state.stateDir,
      candidateRoot,
      env: state.env,
    });
    try {
      const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      const index = JSON.parse(await fs.readFile(copied.session!.store!, "utf8"));
      const selected = index["agent:main:main"].sessionFile;
      expect(selected.startsWith(`${rehearsal.stateDir}${path.sep}`)).toBe(true);
      expect(await fs.readFile(selected, "utf8")).toBe("current-state transcript");
      expect(await fs.readFile(storePath, "utf8")).toBe(original);
      expect(await fs.readFile(foreign, "utf8")).toBe("older foreign transcript");
    } finally {
      await rehearsal.cleanup();
    }
  });
});
