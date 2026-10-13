import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateTeamShapeFixture,
  parseTeamShapeOptions,
} from "../../scripts/perf/team-shape-fixture.ts";
import { flushLogger, resetLogger } from "../../src/logging/logger.js";
import { captureFullEnv } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => resetLogger());

describe("Team-shaped fixture CLI", () => {
  it("rejects unsafe ports and refuses to overwrite existing state", async () => {
    for (const port of ["18789", "39999", "65536", "NaN"]) {
      expect(() => parseTeamShapeOptions(["--state-dir", "/unused", "--port", port])).toThrow();
    }
    const root = temporary.make("team-shape-existing-");
    const sentinel = path.join(root, "operator-state");
    fs.writeFileSync(sentinel, "keep");
    await expect(
      generateTeamShapeFixture(parseTeamShapeOptions(["--state-dir", root])),
    ).rejects.toThrow();
    expect(fs.readdirSync(root)).toEqual(["operator-state"]);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("creates canonical sessions, retained lifecycle states and isolated supporting stores", async () => {
    const root = temporary.make("team-shape-contract-");
    const stateDir = path.join(root, "state");
    const sentinel = path.join(root, "unrelated-repository");
    execFileSync("git", ["init", "--initial-branch=main", sentinel], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        DEVELOPER_DIR: process.env.DEVELOPER_DIR,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: "ignore",
    });
    const originalConfig = fs.readFileSync(path.join(sentinel, ".git", "config"), "utf8");
    const environment = captureFullEnv();
    try {
      process.env.GIT_DIR = path.join(sentinel, ".git");
      process.env.GIT_WORK_TREE = sentinel;
      process.env.GIT_INDEX_FILE = path.join(sentinel, "redirected-index");
      const generated = await generateTeamShapeFixture(
        parseTeamShapeOptions([
          "--state-dir",
          stateDir,
          "--sessions",
          "20",
          "--runs",
          "20",
          "--approvals",
          "3",
          "--cron",
          "2",
          "--projects",
          "1",
          "--transcript-mib",
          "1",
        ]),
      );
      expect(generated.env).toMatchObject({
        OPENCLAW_PROFILE: "team-shape-40967",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-team-shape-40967",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.team-shape-40967",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (team-shape-40967)",
        TMPDIR: path.join(stateDir, "tmp"),
        TMP: path.join(stateDir, "tmp"),
        TEMP: path.join(stateDir, "tmp"),
        USERPROFILE: path.join(stateDir, "home"),
      });
    } finally {
      await flushLogger();
      environment.restore();
    }
    expect(fs.readFileSync(path.join(sentinel, ".git", "config"), "utf8")).toBe(originalConfig);
    expect(fs.existsSync(path.join(sentinel, "redirected-index"))).toBe(false);
    expect(fs.readdirSync(path.join(sentinel, ".git", "refs", "heads"))).toEqual([]);
    const summary = JSON.parse(
      fs.readFileSync(path.join(stateDir, "team-shape-summary.json"), "utf8"),
    );
    expect(summary).toMatchObject({
      sessionCount: 20,
      retainedRuns: 20,
      approvals: 3,
      cronJobs: 2,
      projects: 1,
      logicalTranscriptBytes: 1024 * 1024,
      visibilityCounts: { shared: 14, "read-only": 2, suggest: 2, draft: 2 },
    });
    expect(summary.agentDatabaseBytes).toBeGreaterThan(512 * 1024);
    const agent = new DatabaseSync(
      path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      {
        readOnly: true,
      },
    );
    const state = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        agent.prepare("SELECT count(*) AS n FROM session_nodes WHERE entry_valid = 1").get(),
      ).toEqual({ n: 20 });
      expect(
        agent
          .prepare("SELECT count(*) AS n FROM session_nodes WHERE owner_actor_type = 'human'")
          .get(),
      ).toEqual({ n: 20 });
      expect(agent.prepare("SELECT count(*) AS n FROM session_participants").get()).toEqual({
        n: 60,
      });
      expect(state.prepare("SELECT count(*) AS n FROM user_profiles").get()).toEqual({ n: 24 });
      expect(state.prepare("SELECT count(*) AS n FROM subagent_runs").get()).toEqual({ n: 20 });
      expect(state.prepare("SELECT count(*) AS n FROM worktrees").get()).toEqual({ n: 1 });
      expect(state.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 1 });
      expect(state.prepare("SELECT count(*) AS n FROM cron_jobs").get()).toEqual({ n: 2 });
      expect(
        state
          .prepare(
            "SELECT count(*) AS n FROM subagent_runs WHERE child_session_key = requester_session_key",
          )
          .get(),
      ).toEqual({ n: 0 });
      for (const run of state
        .prepare("SELECT child_session_key, created_at FROM subagent_runs")
        .all()) {
        const child = agent
          .prepare("SELECT created_at FROM session_nodes WHERE session_key = ?")
          .get(String(run.child_session_key));
        expect(Number(child?.created_at)).toBeLessThanOrEqual(Number(run.created_at));
      }
      const mix = state
        .prepare(
          "SELECT json_extract(payload_json, '$.execution.status') AS execution, json_extract(payload_json, '$.delivery.status') AS delivery, count(*) AS n FROM subagent_runs GROUP BY execution, delivery ORDER BY execution, delivery",
        )
        .all();
      expect(mix).toEqual([
        { execution: "interrupted", delivery: "not_required", n: 2 },
        { execution: "terminal", delivery: "delivered", n: 15 },
        { execution: "terminal", delivery: "pending", n: 3 },
      ]);
      expect(state.prepare("SELECT count(*) AS n FROM operator_approvals").get()).toEqual({ n: 3 });
    } finally {
      agent.close();
      state.close();
    }
    expect(fs.existsSync(path.join(summary.projectWorktrees[0].path, ".git"))).toBe(true);
    const config = JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"));
    expect(config.gateway).toMatchObject({ bind: "loopback", port: 40967 });
    expect(config.cron.enabled).toBe(false);
  });
});
