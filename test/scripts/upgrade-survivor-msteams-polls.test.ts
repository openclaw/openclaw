import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertMSTeamsPluginFiles,
  assertMSTeamsPollMigration,
  seedMSTeamsPollMigration,
} from "../../scripts/e2e/lib/upgrade-survivor/msteams-polls.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type Poll = { id: string; createdAt: string; updatedAt?: string; votes: Record<string, string[]> };

function importSpecimen(stateDir: string, archiveSuffix = "") {
  const source = join(stateDir, "msteams-polls.json");
  const { polls } = JSON.parse(readFileSync(source, "utf8")) as { polls: Record<string, Poll> };
  const databasePath = join(stateDir, "state", "openclaw.sqlite");
  mkdirSync(join(stateDir, "state"), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS plugin_state_entries (plugin_id TEXT, namespace TEXT, entry_key TEXT, value_json TEXT, expires_at INTEGER)",
    );
    const insert = db.prepare("INSERT INTO plugin_state_entries VALUES ('msteams', ?, ?, ?, NULL)");
    for (const { votes, ...poll } of Object.values(polls)) {
      const key = createHash("sha256").update(poll.id).digest("hex");
      insert.run("polls", key, JSON.stringify(poll));
      const buckets = new Map<string, Record<string, string[]>>();
      for (const [voter, selections] of Object.entries(votes)) {
        const digest = createHash("sha256").update(`${poll.id}\0${voter}`).digest("hex");
        const bucket = String(Number.parseInt(digest.slice(0, 8), 16) % 32).padStart(4, "0");
        const entries = buckets.get(bucket) ?? {};
        entries[voter] = selections;
        buckets.set(bucket, entries);
      }
      for (const [bucket, bucketVotes] of buckets) {
        insert.run(
          "poll-vote-buckets",
          `${key}:${bucket}`,
          JSON.stringify({
            pollId: poll.id,
            bucket,
            votes: bucketVotes,
            updatedAt: poll.updatedAt ?? poll.createdAt,
          }),
        );
      }
    }
  } finally {
    db.close();
  }
  renameSync(source, `${source}.migrated${archiveSuffix}`);
  return databasePath;
}

describe("Teams published-upgrade evidence", () => {
  it.each([
    ["msteams-polls", "msteams", 0],
    ["base", "msteams", 1],
    ["msteams-polls", "unreviewed", 1],
  ] as const)("scopes Teams recovery to %s with %s", (scenario, pluginId, expectedStatus) => {
    const root = tempDirs.make("teams-upgrade-consent-");
    const resultFile = join(root, "update.json");
    writeFileSync(
      resultFile,
      JSON.stringify({
        status: "error",
        mode: "npm",
        reason: "post-update-plugins",
        before: { version: "2026.9.4" },
        after: { version: "2026.9.4" },
        steps: [
          { name: "global update", exitCode: 0 },
          { name: "global install swap", exitCode: 0 },
        ],
        postUpdate: {
          plugins: {
            status: "error",
            integrityDrifts: [],
            warnings: [],
            sync: { errors: [] },
            npm: {
              outcomes: [{ pluginId, status: "error", code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED" }],
            },
          },
        },
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "scripts/e2e/lib/upgrade-survivor/assertions.mjs",
        "assert-recoverable-update-json",
        resultFile,
        "2026.9.4",
        "",
        "2026.9.4",
      ],
      { encoding: "utf8", env: { ...process.env, OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario } },
    );
    expect(result.status, result.stderr).toBe(expectedStatus);
  });

  it.each(["intact", "missing metadata", "lost vote", "archive changed"])(
    "checks %s migration evidence",
    (fault) => {
      const root = tempDirs.make("teams-upgrade-");
      const stateDir = join(root, "state");
      const artifacts = join(root, "artifacts");
      mkdirSync(stateDir);
      seedMSTeamsPollMigration(stateDir, artifacts);
      assertMSTeamsPollMigration(stateDir, artifacts, "baseline");
      const database = importSpecimen(stateDir);
      assertMSTeamsPollMigration(stateDir, artifacts, "survival");
      // Exercise the runner's second seed after upgrade, before candidate Doctor.
      execFileSync(
        process.execPath,
        ["scripts/e2e/lib/upgrade-survivor/assertions.mjs", "seed-msteams-doctor"],
        {
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: artifacts,
            OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "msteams-polls",
          },
        },
      );
      importSpecimen(stateDir, ".2");
      const db = new DatabaseSync(database);
      try {
        if (fault === "missing metadata") {
          db.exec("DELETE FROM plugin_state_entries WHERE namespace = 'polls'");
        }
        if (fault === "lost vote") {
          db.exec("DELETE FROM plugin_state_entries WHERE namespace = 'poll-vote-buckets'");
        }
      } finally {
        db.close();
      }
      if (fault === "archive changed") {
        writeFileSync(join(stateDir, "msteams-polls.json.migrated.2"), "{}");
      }
      const assertion = () => assertMSTeamsPollMigration(stateDir, artifacts, "survival");
      if (fault === "intact") {
        expect(assertion).not.toThrow();
      } else {
        expect(assertion).toThrow();
      }
    },
  );

  it("starts a new run with the same artifact directory without prior Doctor expectations", () => {
    const root = tempDirs.make("teams-upgrade-repeat-");
    const artifacts = join(root, "artifacts");
    const firstState = join(root, "first-state");
    mkdirSync(firstState);
    seedMSTeamsPollMigration(firstState, artifacts);
    importSpecimen(firstState);
    seedMSTeamsPollMigration(firstState, artifacts, "doctor");
    importSpecimen(firstState, ".2");
    assertMSTeamsPollMigration(firstState, artifacts, "survival");
    const nextState = join(root, "next-state");
    mkdirSync(nextState);
    seedMSTeamsPollMigration(nextState, artifacts);
    importSpecimen(nextState);
    expect(() => assertMSTeamsPollMigration(nextState, artifacts, "survival")).not.toThrow();
  });

  it("rejects stale installed Teams bytes even when package versions match", () => {
    const root = tempDirs.make("teams-candidate-bytes-");
    const packageDir = join(root, "package");
    mkdirSync(packageDir);
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@openclaw/msteams", version: "2026.9.4" }),
    );
    writeFileSync(join(packageDir, "doctor-contract-api.cjs"), "exports.candidate = true;\n");
    writeFileSync(join(packageDir, "polls.cjs"), "exports.batch = true;\n");
    execFileSync("tar", ["-czf", "candidate.tgz", "package"], { cwd: root });
    assertMSTeamsPluginFiles(packageDir, join(root, "candidate.tgz"));
    writeFileSync(join(packageDir, "polls.cjs"), "exports.batch = false;\n");
    expect(() => assertMSTeamsPluginFiles(packageDir, join(root, "candidate.tgz"))).toThrow(
      "Installed candidate Teams bytes changed",
    );
  });
});
