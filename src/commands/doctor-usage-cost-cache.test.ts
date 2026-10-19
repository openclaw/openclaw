import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as usageCacheSqlite from "../infra/session-cost-usage-cache.sqlite.js";
import { USAGE_COST_ROLLUP_SCOPE } from "../infra/session-cost-usage-rollup-codec.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
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
    await expect(fs.readFile(cachedAsset, "utf8")).resolves.toBe("old build");
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`Obsolete Control UI asset cache remains at ${cacheRoot}`),
      "Control UI assets",
    );
    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(fsError("EACCES"));
    await expect(maybeRepairLegacyRuntimeFiles(true, env)).resolves.toEqual([
      expect.stringMatching(/Could not remove obsolete Control UI asset cache.*EACCES/u),
    ]);
    expect(note).toHaveBeenCalledWith(
      expect.stringMatching(/Could not remove obsolete Control UI asset cache.*EACCES/u),
      "Doctor warnings",
    );
    await expect(fs.readFile(cachedAsset, "utf8")).resolves.toBe("old build");
    rm.mockRestore();
    await expect(maybeRepairLegacyRuntimeFiles(true, env)).resolves.toEqual([]);
    await expect(fs.lstat(cacheRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(unrelatedCache, "utf8")).resolves.toBe("keep");
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`Removed obsolete Control UI asset cache at ${cacheRoot}`),
      "Control UI assets",
    );
    await expect(maybeRepairLegacyRuntimeFiles(true, env)).resolves.toEqual([]);
  });
  it("removes only rebuildable usage-cost cache sidecars", async () => {
    const root = tempDirs.make("openclaw-usage-cost-doctor-");
    const sessionsDir = path.join(root, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const cacheFiles = [
      path.join(sessionsDir, ".usage-cost-cache.json"),
      path.join(sessionsDir, ".usage-cost-cache.json.lock"),
    ];
    const staleTempFiles = [
      path.join(sessionsDir, ".usage-cost-cache.123.3b241101-e2bb-4255-8caf-4136c566a962.tmp"),
      path.join(sessionsDir, ".usage-cost-cache.json.lock.123.456.tmp"),
      path.join(sessionsDir, ".usage-cost-cache.json.123.tmp"),
      path.join(sessionsDir, ".usage-cost-cache.123.tmp"),
      path.join(sessionsDir, ".usage-cost-cache.json.lock.123.tmp"),
    ];
    const recentTemp = path.join(sessionsDir, ".usage-cost-cache.456.tmp");
    const unrelatedFiles = [
      path.join(sessionsDir, "session.jsonl"),
      path.join(sessionsDir, ".usage-cost-cache.backup"),
      path.join(sessionsDir, ".usage-cost-cache.notes"),
    ];
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
      await expect(fs.readFile(filePath, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    }
    for (const filePath of [recentTemp, ...unrelatedFiles]) {
      await expect(fs.readFile(filePath, "utf-8")).resolves.toBe("x");
    }
  });
  it("reports legacy skill-upload staging without deleting it unless repair is enabled", async () => {
    const { uploadRoot, metadataPath, env } = await uploadFixture();
    await maybeRepairLegacyRuntimeFiles(false, env);
    await expect(fs.readFile(metadataPath, "utf8")).resolves.toBe("{}\n");
    await maybeRepairLegacyRuntimeFiles(true, env);
    await expect(fs.stat(uploadRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([false, true])("reports skill-upload inspection failures (repair=%s)", async (repair) => {
    const { metadataPath, env } = await uploadFixture();
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(fsError("EACCES"));
    await maybeRepairLegacyRuntimeFiles(repair, env);
    expect(note).toHaveBeenCalledWith(
      expect.stringMatching(/Failed (?:removing|inspecting) legacy skill-upload staging:.*EACCES/u),
      "Skill uploads",
    );
    await expect(fs.readFile(metadataPath, "utf8")).resolves.toBe("{}\n");
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
    await maybeRepairLegacyRuntimeFiles(true, {
      OPENCLAW_STATE_DIR: root,
    } as NodeJS.ProcessEnv);
    await expect(fs.lstat(uploadRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(external, "keep.txt"), "utf8")).resolves.toBe("keep");
  });
  it.each(["none", "write", "inspection"] as const)(
    "continues retired-row cleanup after an agent failure (failure=%s)",
    async (failure) => {
      const rejectFirst = failure !== "none";
      const root = tempDirs.make("openclaw-usage-cost-sqlite-doctor-");
      const env = { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv;
      const firstDatabase = openOpenClawAgentDatabase({ agentId: "main", env });
      const databases = [firstDatabase, openOpenClawAgentDatabase({ agentId: "worker", env })];
      // Cleanup selects scopes, not codec contents; preserve both stored columns byte-for-byte.
      const current = { valueJson: '{"fixture":"current"}', blob: Uint8Array.of(0, 17, 255) };
      for (const database of databases) {
        const insert = database.db.prepare(
          "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, 1)",
        );
        insert.run("session-cost-usage-rollup-v1", "retired", '{"pricingFingerprint":"large"}');
        insert.run("session-cost-usage-rollup-v2", "retired-v2", "{}");
        database.db
          .prepare(
            "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, 'current', ?, ?, NULL, 1)",
          )
          .run(USAGE_COST_ROLLUP_SCOPE, current.valueJson, current.blob);
        insert.run("session-cost-usage", "cache", "{}");
        insert.run("session-cost-usage", "refresh-lock", "{}");
        insert.run("other", "keep", "{}");
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
      if (rejectFirst) {
        expect(note).toHaveBeenCalledWith(
          expect.stringContaining(failure === "inspection" ? "EACCES" : "pruning rejected"),
          "Doctor warnings",
        );
        expect(firstDatabase.db.prepare(query).all()).toEqual(before);
      }
      for (const database of rejectFirst ? databases.slice(1) : databases) {
        expect(
          database.db.prepare("SELECT scope, key FROM cache_entries ORDER BY scope, key").all(),
        ).toEqual([
          { key: "keep", scope: "other" },
          { key: "refresh-lock", scope: "session-cost-usage" },
          { key: "current", scope: USAGE_COST_ROLLUP_SCOPE },
        ]);
        const retained = database.db
          .prepare("SELECT value_json, blob FROM cache_entries WHERE scope = ? AND key = 'current'")
          .get(USAGE_COST_ROLLUP_SCOPE);
        expect(retained).toEqual({ value_json: current.valueJson, blob: current.blob });
      }
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
      vi.spyOn(fs, "stat").mockRejectedValueOnce(error);
    }
    await maybeRepairLegacyRuntimeFiles(shouldRepair, {
      OPENCLAW_STATE_DIR: root,
    } as NodeJS.ProcessEnv);
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
      await expect(fs.readFile(cacheFile, "utf8")).resolves.toBe("x");
      return;
    }
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Removed 1 rebuildable legacy usage-cost cache file"),
      "Usage cost cache",
    );
    await expect(fs.stat(cacheFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected filesystem failure`), { code });
}
