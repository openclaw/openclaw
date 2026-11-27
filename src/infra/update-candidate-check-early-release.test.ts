import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { refuseEarlyGitReleaseSchemaChange as refuse } from "./update-candidate-check-early-release.js";

const roots: string[] = [];
afterEach(() => cleanupTempDirs(roots));

const POSIX_REBUILD =
  "git pull --ff-only && openclaw gateway stop --force && pnpm install --frozen-lockfile && pnpm build && openclaw gateway install --force || { openclaw gateway start; false; }";

function sqlite(file: string, version: number, setup = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; ${setup} PRAGMA user_version = ${version};`);
  db.close();
}

/**
 * State (WAL stores, closed as a stopped Gateway leaves them) and a release worktree as an
 * updater leaves them when it runs this release's check: the 2026-11-17 main layout
 * (`releases/<id>/build` beside `lib/node_modules/openclaw`) by default.
 */
function install(params: {
  state?: number;
  agents?: number[];
  layout?: "build" | "current" | "package";
  legacyLink?: boolean;
  registered?: boolean;
}) {
  const stateDir = makeTempDir(roots, "openclaw-early-release-");
  const prefix = path.join(stateDir, "git-install");
  const agents = (params.agents ?? [OPENCLAW_AGENT_SCHEMA_VERSION - 1]).map((version, index) => {
    const file = path.join(
      stateDir,
      params.registered === true ? "registered-agents" : "agents",
      `a${index}`,
      "agent",
      "openclaw-agent.sqlite",
    );
    sqlite(file, version);
    return file;
  });
  sqlite(
    path.join(stateDir, "state", "openclaw.sqlite"),
    params.state ?? OPENCLAW_STATE_SCHEMA_VERSION - 1,
    `CREATE TABLE agent_databases (path TEXT, agent_id TEXT);
     ${(params.registered === false ? [] : agents).map((file, index) => `INSERT INTO agent_databases VALUES ('${file}', 'a${index}');`).join("\n")}`,
  );
  const root = path.join(
    prefix,
    "releases",
    "git-b",
    ...{ build: ["build"], current: ["openclaw"], package: ["lib", "node_modules", "openclaw"] }[
      params.layout ?? "build"
    ],
  );
  fs.mkdirSync(root, { recursive: true });
  if (params.legacyLink !== false) {
    fs.mkdirSync(path.join(prefix, "releases", "git-a", "lib", "node_modules", "openclaw"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });
    fs.symlinkSync(
      "../../releases/git-a/lib/node_modules/openclaw",
      path.join(prefix, "lib", "node_modules", "openclaw"),
    );
  }
  return { root, stateDir, env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv };
}

it("refuses a schema change for the early release updater and names the rebuild for the platform", () => {
  const { root, env } = install({});
  for (const platform of ["darwin", "linux"] as const) {
    const lines = refuse(root, env, platform)!.split("\n");
    expect(lines[0]).toContain(
      `state schema ${OPENCLAW_STATE_SCHEMA_VERSION - 1} to ${OPENCLAW_STATE_SCHEMA_VERSION}, agent schema ${OPENCLAW_AGENT_SCHEMA_VERSION - 1} to ${OPENCLAW_AGENT_SCHEMA_VERSION}`,
    );
    expect(lines).toContain(
      "The update stopped before switching releases; the Gateway was not touched. Running `openclaw update` again stops here the same way.",
    );
    // The early updater redacts state and home paths out of this output; the step names none.
    expect(lines.at(-1)).toBe(POSIX_REBUILD);
    expect(lines.join("\n")).not.toMatch(/[\s~]\/|automatic|background|systemctl|launchctl/iu);
  }
  // PowerShell has no `{ ...; false; }` group, so Windows gets the steps one per line.
  const windows = refuse(root, env, "win32")!.split("\n");
  expect(windows.slice(-5)).toEqual([
    "git pull --ff-only",
    "openclaw gateway stop --force",
    "pnpm install --frozen-lockfile",
    "pnpm build",
    "openclaw gateway install --force",
  ]);
  expect(windows.at(-6)).toContain("if one fails, run `openclaw gateway start`");
  // A second update reads the same unchanged state and gets the same reason.
  expect(refuse(root, env, "darwin")).toBe(refuse(root, env, "darwin"));
});

it("refuses when one agent store is older, registered or not", () => {
  for (const registered of [true, false]) {
    const { root, env } = install({
      state: OPENCLAW_STATE_SCHEMA_VERSION,
      agents: [OPENCLAW_AGENT_SCHEMA_VERSION, OPENCLAW_AGENT_SCHEMA_VERSION - 1],
      registered,
    });
    // A store found only on disk (registered: false) must count as well as a registered one.
    expect(refuse(root, env)).toContain(
      `migrates your databases (agent schema ${OPENCLAW_AGENT_SCHEMA_VERSION - 1} to ${OPENCLAW_AGENT_SCHEMA_VERSION}).`,
    );
  }
});

it("finds the early release layout through a linked state directory", () => {
  const { root, stateDir } = install({});
  const alias = path.join(makeTempDir(roots, "openclaw-early-release-alias-"), "state");
  fs.symlinkSync(stateDir, alias);
  expect(refuse(root, { OPENCLAW_STATE_DIR: alias })).not.toBeNull();
});

it("lets the early release updater through when nothing migrates or state is unreadable", () => {
  for (const agents of [[OPENCLAW_AGENT_SCHEMA_VERSION], []]) {
    const { root, env } = install({ state: OPENCLAW_STATE_SCHEMA_VERSION, agents });
    expect(refuse(root, env)).toBeNull();
  }
  const newer = install({ state: OPENCLAW_STATE_SCHEMA_VERSION + 1, agents: [] });
  expect(refuse(newer.root, newer.env)).toBeNull();
  // A PostgreSQL-backed store's local anchor has user_version 0; the server holds the schema.
  const postgres = install({ state: 0, agents: [] });
  expect(refuse(postgres.root, postgres.env)).toBeNull();
  const unreadable = install({});
  fs.writeFileSync(path.join(unreadable.stateDir, "state", "openclaw.sqlite"), "not a database");
  expect(refuse(unreadable.root, unreadable.env)).toBeNull();
});

it("reads a rollback-journal store with locks, so a writer's commit is not skipped", async () => {
  const { root, env, stateDir } = install({ state: OPENCLAW_STATE_SCHEMA_VERSION });
  const file = path.join(stateDir, "agents", "a0", "agent", "openclaw-agent.sqlite");
  // A Gateway on a network filesystem, inside the transaction that migrates this store.
  const sql = `PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE; PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`;
  const code = `const db = new (require("node:sqlite").DatabaseSync)(process.argv[1]); db.exec(process.argv[2]); console.log(); setTimeout(() => db.exec("COMMIT"), 300);`;
  const writer = spawn(process.execPath, ["-e", code, file, sql]);
  const exited = once(writer, "exit");
  try {
    await Promise.race([once(writer.stdout, "data"), exited]);
    // The committed store is current, so nothing migrates and the update may pass.
    expect(refuse(root, env)).toBeNull();
  } finally {
    await exited;
  }
});

it("never refuses another updater, which can finish a schema change", () => {
  for (const shape of [
    { layout: "current" as const },
    { layout: "package" as const },
    { legacyLink: false },
  ]) {
    const { root, env } = install(shape);
    expect(refuse(root, env)).toBeNull();
  }
  // A `build` directory outside this state directory's releases is not the early layout.
  const { env } = install({});
  const elsewhere = path.join(makeTempDir(roots, "openclaw-early-other-"), "releases/x/build");
  fs.mkdirSync(elsewhere, { recursive: true });
  expect(refuse(elsewhere, env)).toBeNull();
});
