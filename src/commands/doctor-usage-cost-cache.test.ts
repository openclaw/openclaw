import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEventsSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import * as usageCacheSqlite from "../infra/session-cost-usage-cache.sqlite.js";
import { USAGE_COST_ROLLUP_SCOPE } from "../infra/session-cost-usage-rollup-codec.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginDoctorRepair } from "./doctor-maintenance.admission.test-support.js";
import { maybeRepairLegacyRuntimeFiles } from "./doctor-usage-cost-cache.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const tempDirs = createTempDirTracker();

afterEach(async () => {
  vi.restoreAllMocks();
  note.mockReset();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  tempDirs.cleanup();
});

async function uploadFixture() {
  const root = tempDirs.make("openclaw-skill-upload-doctor-");
  const uploadRoot = path.join(root, "tmp", "skill-uploads");
  const metadataPath = path.join(uploadRoot, "sample", "metadata.json");
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, "{}\n", "utf8");
  return { uploadRoot, metadataPath, env: { OPENCLAW_STATE_DIR: root } };
}

const missing = (file: string) => expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
const contents = (file: string, expected: string) =>
  expect(fs.readFile(file, "utf8")).resolves.toBe(expected);
const noted = (message: string | RegExp, title: string) =>
  expect(note).toHaveBeenCalledWith(
    typeof message === "string" ? expect.stringContaining(message) : expect.stringMatching(message),
    title,
  );
const current = { value_json: '{"current":true}', blob: Uint8Array.of(0, 17, 255) };
type CacheDatabase = ReturnType<typeof openOpenClawAgentDatabase>["db"];

function seedCacheRows(db: CacheDatabase, unrelated = false) {
  const insert = db.prepare(
    "INSERT INTO cache_entries (scope, key, value_json, blob, updated_at) VALUES (?, ?, ?, ?, 1)",
  );
  insert.run(USAGE_COST_ROLLUP_SCOPE, "current", current.value_json, current.blob);
  insert.run("session-cost-usage", "refresh-lock", "{}", null);
  for (const scope of ["session-cost-usage-rollup-v1", "session-cost-usage-rollup-v2"]) {
    insert.run(scope, "retired", "{}", null);
  }
  insert.run("session-cost-usage", "cache", "{}", null);
  if (unrelated) {
    insert.run("other", "keep", "{}", null);
  }
}

const cacheRows = (db: CacheDatabase) =>
  db.prepare("SELECT scope, key, value_json, blob FROM cache_entries ORDER BY scope, key").all();
const retainedRows = [
  { scope: "session-cost-usage", key: "refresh-lock", value_json: "{}", blob: null },
  { scope: USAGE_COST_ROLLUP_SCOPE, key: "current", ...current },
];

describe("legacy usage-cost cache cleanup", () => {
  it("reports the obsolete Control UI cache and removes only that cache on repair, recording failures", async () => {
    const stateDir = tempDirs.make("openclaw-control-ui-cache-doctor-");
    const cacheRoot = path.join(stateDir, "cache", "control-ui-assets");
    const cachedAsset = path.join(cacheRoot, "old-build", "assets", "index-old.js");
    const unrelatedCache = path.join(stateDir, "cache", "keep.txt");
    await fs.mkdir(path.dirname(cachedAsset), { recursive: true });
    await fs.writeFile(cachedAsset, "old build");
    await fs.writeFile(unrelatedCache, "keep");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    await maybeRepairLegacyRuntimeFiles(false, env);
    await contents(cachedAsset, "old build");
    noted(`Obsolete Control UI asset cache remains at ${cacheRoot}`, "Control UI assets");
    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(fsError("EACCES"));
    await expect(maybeRepairLegacyRuntimeFiles(true, env)).resolves.toEqual([
      expect.stringMatching(/Could not remove obsolete Control UI asset cache.*EACCES/u),
    ]);
    noted(/Could not remove obsolete Control UI asset cache.*EACCES/u, "Doctor warnings");
    await contents(cachedAsset, "old build");
    rm.mockRestore();
    await expect(maybeRepairLegacyRuntimeFiles(true, env)).resolves.toEqual([]);
    await missing(cacheRoot);
    await contents(unrelatedCache, "keep");
    noted(`Removed obsolete Control UI asset cache at ${cacheRoot}`, "Control UI assets");
    await expect(maybeRepairLegacyRuntimeFiles(true, env)).resolves.toEqual([]);
  });
  it("removes only rebuildable usage-cost cache sidecars", async () => {
    const root = tempDirs.make("openclaw-usage-cost-doctor-");
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const paths = (...names: string[]) => names.map((name) => path.join(sessionsDir, name));
    const cacheFiles = paths(".usage-cost-cache.json", ".usage-cost-cache.json.lock");
    const staleTempFiles = paths(
      ".usage-cost-cache.123.3b241101-e2bb-4255-8caf-4136c566a962.tmp",
      ".usage-cost-cache.json.lock.123.456.tmp",
      ".usage-cost-cache.json.123.tmp",
      ".usage-cost-cache.123.tmp",
      ".usage-cost-cache.json.lock.123.tmp",
    );
    const recentTemp = path.join(sessionsDir, ".usage-cost-cache.456.tmp");
    const unrelatedFiles = paths(
      "session.jsonl",
      ".usage-cost-cache.backup",
      ".usage-cost-cache.notes",
    );
    await Promise.all(
      [...cacheFiles, ...staleTempFiles, recentTemp, ...unrelatedFiles].map((filePath) =>
        fs.writeFile(filePath, "x"),
      ),
    );
    const staleTime = new Date(Date.now() - 60_000);
    await Promise.all(staleTempFiles.map((filePath) => fs.utimes(filePath, staleTime, staleTime)));
    const env = { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv;
    await maybeRepairLegacyRuntimeFiles(true, env);
    for (const filePath of [...cacheFiles, ...staleTempFiles]) {
      await missing(filePath);
    }
    for (const filePath of [recentTemp, ...unrelatedFiles]) {
      await contents(filePath, "x");
    }
  });
  it("reports legacy skill-upload staging without deleting it unless repair is enabled", async () => {
    const { uploadRoot, metadataPath, env } = await uploadFixture();
    await maybeRepairLegacyRuntimeFiles(false, env);
    await contents(metadataPath, "{}\n");
    await maybeRepairLegacyRuntimeFiles(true, env);
    await missing(uploadRoot);
  });
  it.each([false, true])("reports skill-upload inspection failures (repair=%s)", async (repair) => {
    const { metadataPath, env } = await uploadFixture();
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(fsError("EACCES"));
    await maybeRepairLegacyRuntimeFiles(repair, env);
    noted(/Failed (?:removing|inspecting) legacy skill-upload staging:.*EACCES/u, "Skill uploads");
    await contents(metadataPath, "{}\n");
  });
  const symlinkTest = process.platform === "win32" ? it.skip : it;
  symlinkTest("removes a legacy staging symlink without touching its target", async () => {
    const root = tempDirs.make("openclaw-skill-upload-link-");
    const uploadRoot = path.join(root, "tmp", "skill-uploads");
    const external = path.join(root, "external");
    await fs.mkdir(path.dirname(uploadRoot), { recursive: true });
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "keep.txt"), "keep", "utf8");
    await fs.symlink(external, uploadRoot, "dir");
    await maybeRepairLegacyRuntimeFiles(true, { OPENCLAW_STATE_DIR: root });
    await missing(uploadRoot);
    await contents(path.join(external, "keep.txt"), "keep");
  });
  it("cleans obsolete rows under real Doctor custody without warning on clean stores", async () => {
    await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const scope = {
        agentId: "main",
        env: state.env,
        sessionKey: "agent:main:history",
        sessionId: "main-history",
      };
      const events = [{ type: "message", message: { role: "user", content: "Keep history." } }];
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 123 });
      await replaceTranscriptEvents(scope, events);
      seedCacheRows(openOpenClawAgentDatabase(scope).db);
      await closeOpenClawAgentDatabasesAsync();
      const maintenance = await beginDoctorRepair({ env: state.env });
      expect(maintenance).toBeDefined();
      try {
        await maintenance!.run(async () => {
          await maybeRepairLegacyRuntimeFiles(true, state.env);
          expect(note).not.toHaveBeenCalledWith(expect.anything(), "Doctor warnings");
          expect(cacheRows(openOpenClawAgentDatabase(scope).db)).toEqual(retainedRows);
          expect(loadExactSessionEntryReadOnly(scope)?.entry).toMatchObject({
            sessionId: scope.sessionId,
            updatedAt: 123,
          });
          expect(loadTranscriptEventsSync(scope)).toEqual(events);
          await maybeRepairLegacyRuntimeFiles(true, state.env);
          expect(note).not.toHaveBeenCalledWith(expect.anything(), "Doctor warnings");
        });
      } finally {
        await maintenance?.release();
      }
    });
  });
  it.each(["write", "inspection"] as const)(
    "continues retired-row cleanup after an agent failure (failure=%s)",
    async (failure) => {
      const root = tempDirs.make("openclaw-usage-cost-sqlite-doctor-");
      const env = { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv;
      const firstDatabase = openOpenClawAgentDatabase({ agentId: "main", env });
      const secondDatabase = openOpenClawAgentDatabase({ agentId: "worker", env });
      const databases = [firstDatabase, secondDatabase];
      for (const database of databases) {
        seedCacheRows(database.db, true);
      }
      const query = "SELECT * FROM cache_entries ORDER BY scope, key";
      const before = firstDatabase.db.prepare(query).all();
      if (failure === "inspection") {
        vi.spyOn(fs, "stat").mockRejectedValueOnce(fsError("EACCES"));
      } else if (failure === "write") {
        vi.spyOn(usageCacheSqlite, "retireLegacySessionCostUsageCache").mockRejectedValueOnce(
          new Error("pruning rejected"),
        );
      }
      await maybeRepairLegacyRuntimeFiles(true, env);
      noted(failure === "inspection" ? "EACCES" : "pruning rejected", "Doctor warnings");
      expect(firstDatabase.db.prepare(query).all()).toEqual(before);
      expect(cacheRows(secondDatabase.db)).toEqual([
        { key: "keep", scope: "other", value_json: "{}", blob: null },
        ...retainedRows,
      ]);
    },
  );
  it.each([
    ["unreadable agent root", "root", "readdir", "EACCES", false, true],
    ["unreadable temp entry", "entry", "stat", "EIO", true, true],
    ["missing agent root", "root", "readdir", "ENOENT", true, false],
    ["disappearing temp entry", "entry", "stat", "ENOENT", true, false],
  ] as const)("%s", async (_name, scope, operation, code, shouldRepair, diagnostic) => {
    const root = tempDirs.make(`openclaw-usage-cost-${scope}-fault-`);
    const agentsDir = path.join(root, "agents");
    const sessionsDir =
      scope === "root" ? path.join(root, "sessions") : path.join(agentsDir, "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    if (scope === "root") {
      await fs.mkdir(agentsDir);
    }
    const cacheFile = path.join(sessionsDir, ".usage-cost-cache.json");
    const tempFile = path.join(sessionsDir, ".usage-cost-cache.123.tmp");
    await fs.writeFile(cacheFile, "x");
    if (scope === "entry") {
      await fs.writeFile(tempFile, "x");
    }
    const error = fsError(code);
    if (operation === "readdir") {
      vi.spyOn(fs, "readdir").mockRejectedValueOnce(error);
    } else {
      const stat = fs.stat;
      vi.spyOn(fs, "stat").mockImplementation((...args) => {
        if (args[0] === tempFile) {
          return Promise.reject(error);
        }
        return stat(...args);
      });
    }
    await maybeRepairLegacyRuntimeFiles(shouldRepair, { OPENCLAW_STATE_DIR: root });
    if (diagnostic) {
      const action = shouldRepair ? "scan and cleanup" : "scan";
      expect(note).toHaveBeenCalledOnce();
      expect(note).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`usage-cost cache ${action} could not be completed`, "iu"),
        ),
        "Usage cost cache",
      );
      const message = note.mock.calls[0]?.[0];
      expect(message).toContain(scope === "root" ? agentsDir : tempFile);
      expect(message).toContain(code);
      expect(message).toContain(shouldRepair ? "openclaw doctor --fix" : "openclaw doctor");
      expect(message).not.toContain("Removed");
      await contents(cacheFile, "x");
      return;
    }
    noted("Removed 1 rebuildable legacy usage-cost cache file", "Usage cost cache");
    await missing(cacheFile);
  });
});

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected filesystem failure`), { code });
}
