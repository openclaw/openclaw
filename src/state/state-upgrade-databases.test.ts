import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqliteSource from "../infra/sqlite-snapshot-source.js";
import { withArtifactPreservingStateReads } from "./artifact-preserving-state-reads.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { discoverDatabases, preflightStateUpgrade } from "./state-upgrade-databases.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["external", "logs", "tmp", "npm", "node_modules", "git-install", "deep", "symlink"])(
  "refuses an uncovered %s store before touching its bytes, but allows a same-schema update",
  async (layout) => {
    const root = dirs.make("state-boundary-");
    const outside = dirs.make("state-boundary-external-");
    const agentId = ["external", "deep", "symlink"].includes(layout) ? "main" : layout;
    const file =
      layout === "external"
        ? path.join(outside, "openclaw-agent.sqlite")
        : path.join(
            root,
            "agents",
            agentId,
            "agent",
            ...(layout === "deep" ? ["a", "b"] : []),
            "openclaw-agent.sqlite",
          );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (layout === "symlink") {
      fs.rmdirSync(path.dirname(file));
      fs.symlinkSync(outside, path.dirname(file), "junction");
    }
    {
      using db = new DatabaseSync(file);
      db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
    }
    const shared = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    const env = { OPENCLAW_STATE_DIR: root };
    {
      using db = new DatabaseSync(shared);
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
      db.prepare("INSERT INTO agent_databases VALUES (?, ?, ?, 1, 0)").run(
        agentId,
        file,
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
    }
    await preflightStateUpgrade(env, {});
    {
      using db = new DatabaseSync(shared);
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}`);
    }
    const before = fs.readFileSync(file);
    await expect(preflightStateUpgrade(env, {})).rejects.toThrow(/cannot restore.*Move.*retry/is);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(root).some((name) => name.startsWith(".upgrade-"))).toBe(false);
  },
);

it.each(["closed", "empty-wal", "live", "nonempty-no-shm"])(
  "inventories a %s WAL database without changing source artifacts",
  async (mode) => {
    const root = dirs.make("state-boundary-wal-");
    const file = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const writer = new DatabaseSync(file);
    try {
      writer.exec("PRAGMA journal_mode = WAL");
      const original = fs.readFileSync(file);
      writer.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}`);
      if (mode === "nonempty-no-shm") {
        const wal = fs.readFileSync(`${file}-wal`);
        writer.close();
        fs.writeFileSync(file, original);
        fs.writeFileSync(`${file}-wal`, wal);
      } else if (mode !== "live") {
        writer.close();
        if (mode === "empty-wal") {
          fs.writeFileSync(`${file}-wal`, "");
        }
      }
      const artifacts = () =>
        Object.fromEntries(
          fs.readdirSync(path.dirname(file)).map((name) => [
            name,
            createHash("sha256")
              .update(fs.readFileSync(path.join(path.dirname(file), name)))
              .digest("hex"),
          ]),
        );
      const before = artifacts();
      const prepare = vi.spyOn(sqliteSource, "prepareSqliteReadOnlyLocation");
      const { targets } = await withArtifactPreservingStateReads(() =>
        discoverDatabases(root, {}, { OPENCLAW_STATE_DIR: root }),
      );
      expect(targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "agent",
            path: file,
            version: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
          }),
        ]),
      );
      expect(artifacts()).toEqual(before);
      expect(prepare).toHaveBeenCalledTimes(mode === "nonempty-no-shm" ? 1 : 0);
    } finally {
      if (mode === "live") {
        writer.close();
      }
    }
  },
);

it("inspects current stores on ordinary boot without allocating a private whole-file image", async () => {
  const root = dirs.make("state-boundary-current-");
  const file = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  {
    using db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
  }
  const prepare = vi.spyOn(sqliteSource, "prepareSqliteReadOnlyLocation");
  const { targets } = await discoverDatabases(root, {}, { OPENCLAW_STATE_DIR: root });
  expect(targets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: file, version: OPENCLAW_AGENT_SCHEMA_VERSION }),
    ]),
  );
  expect(prepare).not.toHaveBeenCalled();
});

it("does not refuse an unrelated upgrade for a missing unconfigured retained registration", async () => {
  const root = dirs.make("state-boundary-missing-");
  const outside = dirs.make("state-boundary-missing-external-");
  const shared = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  {
    using db = new DatabaseSync(shared);
    db.exec(OPENCLAW_STATE_SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}`);
    db.prepare("INSERT INTO agent_databases VALUES ('archive', ?, ?, 1, 0)").run(
      path.join(outside, "missing.sqlite"),
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
  }
  await preflightStateUpgrade({ OPENCLAW_STATE_DIR: root }, {});
});

it("refuses a missing database with unresolved journal data instead of bootstrapping over it", async () => {
  const root = dirs.make("state-boundary-orphan-");
  const file = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}-journal`, "retained journal bytes");
  await expect(preflightStateUpgrade({ OPENCLAW_STATE_DIR: root }, {})).rejects.toThrow(
    /incomplete.*Preserve.*restore/is,
  );
  expect(fs.readFileSync(`${file}-journal`, "utf8")).toBe("retained journal bytes");
});

it("reads a large cleanly closed WAL schema without snapshotting or rejecting its size", async () => {
  const root = dirs.make("state-boundary-large-closed-");
  const file = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  {
    using db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
  }
  fs.truncateSync(file, 75 * 1024 ** 3);
  vi.spyOn(sqliteSource, "prepareSqliteReadOnlyLocation").mockRejectedValue(
    new Error("Metadata inspection must not copy the payload"),
  );
  await preflightStateUpgrade({ OPENCLAW_STATE_DIR: root }, {});
  expect(fs.statSync(file).size).toBe(75 * 1024 ** 3);
  expect(fs.existsSync(`${file}-shm`)).toBe(false);
  expect(fs.existsSync(`${file}-wal`)).toBe(false);
});
