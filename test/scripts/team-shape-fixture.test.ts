import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import {
  generateTeamShapeFixture,
  parseTeamShapeOptions,
} from "../../scripts/perf/team-shape-fixture.ts";
import { flushLogger, resetLogger } from "../../src/logging/logger.js";
import { captureFullEnv } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => resetLogger());
const read = (file: string) => fs.readFileSync(file, "utf8");
const readJson = (file: string) => JSON.parse(read(file));
const openDb = (file: string) => new DatabaseSync(file, { readOnly: true });
const options = (stateDir: string, flags: string) =>
  parseTeamShapeOptions(["--state-dir", stateDir, ...flags.split(" ")]);
function expectCounts(db: DatabaseSync, expected: Record<string, number>) {
  for (const [table, n] of Object.entries(expected)) {
    expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n });
  }
}

it("rejects unsafe ports and refuses to overwrite existing state", async () => {
  for (const port of ["18789", "39999", "65536", "NaN"]) {
    expect(() => parseTeamShapeOptions(["--state-dir", "/unused", "--port", port])).toThrow();
  }
  for (const args of [
    ["--agents", "0"],
    ["--long-transcript-entries", "1000000"],
    ["--worktree-files", "500001"],
    ["--projects", "0", "--worktree-files", "1"],
    ["--projects", "0", "--nested-repository"],
    ["--projects", "0", "--worktree-local-origin"],
    ["--projects", "0", "--github-options-connected"],
    ["--cron-announce-last", "--cron", "0"],
    ["--cron-announce-last", "--sessions", "1", "--runs", "0"],
  ]) {
    expect(() => parseTeamShapeOptions(["--state-dir", "/unused", ...args])).toThrow();
  }
  const root = temporary.make("team-shape-existing-");
  const sentinel = path.join(root, "operator-state");
  fs.writeFileSync(sentinel, "keep");
  await expect(
    generateTeamShapeFixture(parseTeamShapeOptions(["--state-dir", root])),
  ).rejects.toThrow();
  expect(fs.readdirSync(root)).toEqual(["operator-state"]);
  expect(read(sentinel)).toBe("keep");
});

it("adds bounded long histories and an unchanged tracked inventory with a nested checkout", async () => {
  const stateDir = path.join(temporary.make("team-shape-stress-"), "state");
  const { summary, env } = await generateTeamShapeFixture(
    options(
      stateDir,
      "--sessions 2 --runs 0 --approvals 0 --cron 0 --projects 1 --transcript-mib 0 --long-transcript-entries 4 --long-transcript-sessions 1 --worktree-files 5 --nested-repository --github-options-connected",
    ),
  );
  expect(summary).toMatchObject({
    logicalTranscriptBytes: 4 * 1024,
    transcriptMessages: 4,
    longTranscriptSessions: 1,
    thinkingSignatureBytes: 2 * 16 * 1024,
    worktreeFiles: 5,
    nestedRepository: true,
    githubOptionsConnected: true,
  });
  using agent = openDb(path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"));
  const rows = agent
    .prepare(
      "SELECT session_id, event_json, event_zstd FROM transcript_events ORDER BY session_id, seq",
    )
    .all();
  const events = rows.map((row) =>
    JSON.parse(
      row.event_zstd instanceof Uint8Array
        ? zstdDecompressSync(row.event_zstd).toString("utf8")
        : String(row.event_json),
    ),
  );
  expect(rows.filter((row) => row.session_id === "team-shape-session-1")).toHaveLength(1);
  const messages = events.filter((event) => event.type === "message");
  expect(messages.map((event) => event.message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  expect(messages.map((event) => event.parentId)).toEqual([
    null,
    ...messages.slice(0, -1).map((event) => event.id),
  ]);
  const signatures: string[] = messages.flatMap((event) =>
    event.message.content
      .filter((block: { type: string }) => block.type === "thinking")
      .map((block: { thinkingSignature: string }) => block.thinkingSignature),
  );
  expect(signatures.map((signature) => signature.length)).toEqual([16 * 1024, 16 * 1024]);
  expect(new Set(signatures).size).toBe(2);
  const worktree = summary.projectWorktrees[0]!.path;
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", worktree, ...args], { env, encoding: "utf8" }).trim();
  expect(git("remote", "get-url", "origin")).toBe("https://github.com/openclaw-fixture/soak.git");
  const { resolveRepositoryIdentity } =
    await import("../../src/agents/worktrees/repository-paths.js");
  const repository = await resolveRepositoryIdentity(worktree);
  using state = openDb(path.join(stateDir, "state/openclaw.sqlite"));
  expect(state.prepare("SELECT repo_fingerprint FROM worktrees").get()).toEqual({
    repo_fingerprint: repository.fingerprint,
  });
  expect(git("ls-files", "inventory").split("\n")).toHaveLength(5);
  expect(git("diff", "--name-only", "main")).toBe("");
  expect(git("status", "--porcelain")).toBe("?? nested-repository/");
  expect(git("-C", path.join(worktree, "nested-repository"), "status", "--porcelain")).toBe("");
  expect(git("-C", path.join(worktree, "nested-repository"), "log", "-1", "--format=%s")).toBe(
    "test: seed nested synthetic repository",
  );
});

it("creates canonical sessions, retained lifecycle states and isolated supporting stores", async () => {
  const root = temporary.make("team-shape-contract-");
  const stateDir = path.join(root, "state");
  const at = (name: string) => path.join(stateDir, name);
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
  const gitConfig = path.join(sentinel, ".git/config");
  const originalConfig = read(gitConfig);
  const originalEnv = process.env;
  const environment = captureFullEnv();
  try {
    process.env.GIT_DIR = path.join(sentinel, ".git");
    process.env.GIT_WORK_TREE = sentinel;
    process.env.GIT_INDEX_FILE = path.join(sentinel, "redirected-index");
    const generated = await generateTeamShapeFixture(
      options(
        stateDir,
        "--sessions 20 --runs 20 --approvals 3 --cron 2 --projects 1 --transcript-mib 1 --worktree-local-origin --worktree-files 5 --worktree-file-bytes 256",
      ),
    );
    const project = generated.summary.projectWorktrees[0]!;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", project.repoRoot, ...args], {
        env: generated.env,
        encoding: "utf8",
      }).trim();
    const origin = git("remote", "get-url", "origin");
    expect(path.dirname(origin)).toBe(at("fixture-remotes"));
    expect(git("ls-remote", "--symref", "origin", "HEAD")).toContain("ref: refs/heads/main\tHEAD");
    expect(git("--git-dir", origin, "rev-parse", "HEAD")).toBe(git("rev-parse", "refs/heads/main"));
    expect(process.env === originalEnv).toBe(true);
    expect(generated.env).toMatchObject({
      OPENCLAW_PROFILE: "team-shape-40967",
      OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-team-shape-40967",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.team-shape-40967",
      OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (team-shape-40967)",
      ...Object.fromEntries(["TMPDIR", "TMP", "TEMP"].map((key) => [key, at("tmp")])),
      USERPROFILE: at("home"),
    });
  } finally {
    await flushLogger();
    environment.restore();
  }
  expect(read(gitConfig)).toBe(originalConfig);
  expect(fs.existsSync(path.join(sentinel, "redirected-index"))).toBe(false);
  expect(fs.readdirSync(path.join(sentinel, ".git", "refs", "heads"))).toEqual([]);
  const summary = readJson(at("team-shape-summary.json"));
  expect(summary).toMatchObject({
    sessionCount: 20,
    retainedRuns: 20,
    approvals: 3,
    cronJobs: 2,
    cronAnnounceLast: false,
    projects: 1,
    githubOptionsConnected: false,
    logicalTranscriptBytes: 1024 * 1024,
    visibilityCounts: { shared: 14, "read-only": 2, suggest: 2, draft: 2 },
  });
  expect(summary.agentDatabaseBytes).toBeGreaterThan(512 * 1024);
  {
    using agent = openDb(at("agents/main/agent/openclaw-agent.sqlite"));
    using state = openDb(at("state/openclaw.sqlite"));
    expectCounts(agent, {
      "session_nodes WHERE entry_valid = 1": 20,
      "session_nodes WHERE owner_actor_type = 'human'": 20,
      session_participants: 60,
    });
    expectCounts(state, {
      user_profiles: 24,
      subagent_runs: 20,
      worktrees: 1,
      projects: 1,
      cron_jobs: 2,
      operator_approvals: 3,
      "subagent_runs WHERE child_session_key = requester_session_key": 0,
    });
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
      { execution: "terminal", delivery: "delivered", n: 15 },
      { execution: "terminal", delivery: "not_required", n: 2 },
      { execution: "terminal", delivery: "pending", n: 3 },
    ]);
  }
  expect(fs.existsSync(path.join(summary.projectWorktrees[0].path, ".git"))).toBe(true);
  expect(readJson(at("openclaw.json"))).toMatchObject({
    gateway: { bind: "loopback", port: 40967 },
    cron: { enabled: false },
  });
});

it("keeps explicit session keys consistent across retained runs and automation targets", async () => {
  const stateDir = path.join(temporary.make("team-shape-keys-"), "state");
  const sessionKeys = [
    "agent:main:24800000-0000-4000-8000-000000000001",
    "agent:main:dashboard:24800001-0000-4000-8000-000000000001",
  ];
  await generateTeamShapeFixture({
    ...options(
      stateDir,
      "--sessions 3 --runs 1 --settled-runs --approvals 0 --cron 1 --cron-announce-last --projects 0 --transcript-mib 0",
    ),
    sessionKeys,
  });
  using agent = openDb(path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"));
  using state = openDb(path.join(stateDir, "state/openclaw.sqlite"));
  expect(
    agent
      .prepare("SELECT session_key FROM session_nodes WHERE entry_valid = 1 ORDER BY session_key")
      .all(),
  ).toEqual([
    { session_key: sessionKeys[0] },
    { session_key: sessionKeys[1] },
    { session_key: "agent:main:team-shape-session-2" },
  ]);
  expect(
    state.prepare("SELECT child_session_key, requester_session_key FROM subagent_runs").all(),
  ).toEqual([{ child_session_key: sessionKeys[1], requester_session_key: sessionKeys[0] }]);
  expect(
    JSON.parse(String(state.prepare("SELECT job_json FROM cron_jobs").get()?.job_json)),
  ).toMatchObject({
    sessionKey: sessionKeys[1],
  });
});

it("retains settled history and seeds disabled announce/last jobs without delivery routes", async () => {
  const stateDir = path.join(temporary.make("team-shape-settled-"), "state");
  const { summary } = await generateTeamShapeFixture(
    options(
      stateDir,
      "--sessions 20 --runs 60 --settled-runs --approvals 0 --cron 40 --cron-announce-last --projects 0 --transcript-mib 0",
    ),
  );
  await flushLogger();
  expect(summary).toMatchObject({
    sessionCount: 20,
    retainedRuns: 60,
    settledRuns: true,
    cronJobs: 40,
    cronAnnounceLast: true,
    retainedRunStates: { successful: 51, failed: 9, pending: 0, cancelled: 0 },
  });
  using state = openDb(path.join(stateDir, "state/openclaw.sqlite"));
  expectCounts(state, {
    subagent_runs: 60,
    "subagent_runs WHERE json_extract(payload_json, '$.execution.status') = 'terminal' AND json_extract(payload_json, '$.delivery.status') = 'delivered' AND json_extract(payload_json, '$.cleanupHandled') = 1": 60,
  });
  const jobs = state.prepare("SELECT job_json FROM cron_jobs").all();
  expect(jobs).toHaveLength(40);
  for (const row of jobs) {
    expect(JSON.parse(String(row.job_json))).toMatchObject({
      enabled: false,
      sessionTarget: "isolated",
      sessionKey: "agent:main:team-shape-session-1",
      payload: { kind: "agentTurn", message: expect.stringContaining("Synthetic inspection") },
      delivery: { mode: "announce", channel: "last" },
      failureAlert: false,
    });
  }
  using agent = openDb(path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"));
  const target = agent
    .prepare("SELECT archived_at, entry_json FROM session_nodes WHERE session_key = ?")
    .get("agent:main:team-shape-session-1");
  expect(target?.archived_at).toBeNull();
  expect(JSON.parse(String(target?.entry_json))).not.toHaveProperty("deliveryContext");
});

it("seeds the stress category mix with readable collector parents and settled unarchived children", async () => {
  const stateDir = path.join(temporary.make("team-shape-load-"), "state");
  const { summary } = await generateTeamShapeFixture(
    options(
      stateDir,
      "--sessions 108 --runs 43 --settled-runs --team-stress --agents 8 --approvals 0 --cron 0 --projects 0 --transcript-mib 1",
    ),
  );
  expect(summary.stressCounts).toMatchObject({
    subagent: 43,
    archivedDashboard: 44,
    dashboard: 4,
    explicit: 2,
  });
  using agent = openDb(path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"));
  using state = openDb(path.join(stateDir, "state/openclaw.sqlite"));
  expectCounts(agent, {
    "session_nodes WHERE entry_valid = 1": 108,
    "session_nodes WHERE session_key LIKE 'agent:main:subagent:%' AND archived_at IS NULL": 43,
    "session_nodes WHERE session_key LIKE 'agent:main:dashboard:%' AND archived_at IS NOT NULL": 44,
    "session_nodes WHERE session_key LIKE 'agent:main:dashboard:%' AND archived_at IS NULL": 4,
  });
  expectCounts(state, {
    "subagent_runs WHERE child_session_key LIKE 'agent:main:subagent:%' AND json_extract(payload_json, '$.execution.status') = 'terminal' AND json_extract(payload_json, '$.delivery.status') = 'not_required' AND json_extract(payload_json, '$.collect') = 1 AND json_extract(payload_json, '$.collectorCompletion.status') IN ('done', 'failed')": 43,
  });
  expectCounts(state, {
    "subagent_runs WHERE json_extract(payload_json, '$.swarmRequesterSessionKey') = requester_session_key AND json_extract(payload_json, '$.groupId') IS NOT NULL": 43,
  });
  const oldest = state
    .prepare(
      "SELECT min(json_extract(payload_json, '$.completion.capturedAt')) AS at FROM subagent_runs",
    )
    .get();
  expect(Number(oldest?.at)).toBeGreaterThan(summary.now - 31 * 60_000);
  expect(summary.stressTargets?.length).toBeGreaterThan(0);
  for (const target of summary.stressTargets ?? []) {
    const row = agent
      .prepare(
        "SELECT json_extract(entry_json, '$.sessionId') AS session_id, archived_at FROM session_nodes WHERE session_key = ?",
      )
      .get(target.sessionKey);
    expect(row?.archived_at).toBeNull();
    const transcript = agent
      .prepare("SELECT count(*) AS n FROM transcript_events WHERE session_id = ?")
      .get(String(row?.session_id));
    expect(Number(transcript?.n)).toBeGreaterThan(1);
  }
  const agentConfig = readJson(path.join(stateDir, "openclaw.json")).agents;
  expect(agentConfig.defaults.subagents.archiveAfterMinutes).toBeGreaterThanOrEqual(120);
  const agents = agentConfig.entries;
  expect(Object.keys(agents).join(",")).toBe(
    "main,reviewer,researcher,planner,agent-5,agent-6,agent-7,agent-8",
  );
  expect(summary.agentCount).toBe(8);
  expect(fs.statSync(agents["agent-8"].workspace).isDirectory()).toBe(true);
});
