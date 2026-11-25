import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  formatEarlyGitReleaseRefusal,
  inspectEarlyGitReleaseSchemaChange as inspect,
} from "./update-candidate-check-early-release.js";

const roots: string[] = [];
afterEach(() => cleanupTempDirs(roots));

function sqlite(file: string, version: number, setup = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL; ${setup} PRAGMA user_version = ${version};`);
  db.close();
}

/**
 * State (WAL stores, closed as a stopped Gateway leaves them) and a release worktree as an updater leaves them when it runs this release's check:
 * the 2026-11-17 main layout (`releases/<id>/build` beside `lib/node_modules/openclaw`) by default.
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

it("refuses a schema change for the early release updater and names the rebuild", () => {
  const { root, env } = install({});
  const change = inspect(root, env)!;
  const refusal = formatEarlyGitReleaseRefusal(change, { started: false, reason: "no upstream" });

  expect(refusal).toContain(
    `state schema ${OPENCLAW_STATE_SCHEMA_VERSION - 1} to ${OPENCLAW_STATE_SCHEMA_VERSION}, agent schema ${OPENCLAW_AGENT_SCHEMA_VERSION - 1} to ${OPENCLAW_AGENT_SCHEMA_VERSION}`,
  );
  expect(refusal).toContain(
    "the Gateway was not touched.\nAutomatic recovery did not start: no upstream.",
  );
  // The early updater redacts state and home paths out of this output; the step names none.
  const rebuild = refusal.split("\n").at(-1);
  expect(rebuild).toBe(
    "git pull --ff-only && openclaw gateway stop --force && pnpm install --frozen-lockfile && pnpm build && openclaw gateway install --force || { openclaw gateway start; false; }",
  );
  expect(rebuild).not.toMatch(/[\s~]\//u);

  // Started: failures go to the journal, because the checkout's CLI fails until it is rebuilt.
  const target = "0123456789abcdef0123456789abcdef01234567";
  const started = { started: true, unit: "openclaw-update-recovery", target } as const;
  const automatic = formatEarlyGitReleaseRefusal(change, started);
  expect(automatic).toContain(
    "finishes the update in the background. In about 5 to 10 minutes it moves the checkout to 0123456789a",
  );
  expect(automatic).toContain(
    "its log (journalctl --user -u openclaw-update-recovery) says why and prints the next step",
  );
  expect(automatic).toContain(
    "`openclaw update status` shows the outcome once the checkout is rebuilt",
  );
  expect(automatic).not.toMatch(/[\s~]\/|not touched/u);
});

it("refuses when one agent store is older, registered or not", () => {
  for (const registered of [true, false]) {
    const { root, env } = install({
      state: OPENCLAW_STATE_SCHEMA_VERSION,
      agents: [OPENCLAW_AGENT_SCHEMA_VERSION, OPENCLAW_AGENT_SCHEMA_VERSION - 1],
      registered,
    });
    expect(inspect(root, env)?.pending?.agent).toBe(OPENCLAW_AGENT_SCHEMA_VERSION - 1);
  }
});

it("finds the early release layout through a linked state directory", () => {
  const { root, stateDir } = install({});
  const alias = path.join(makeTempDir(roots, "openclaw-early-release-alias-"), "state");
  fs.symlinkSync(stateDir, alias);
  expect(inspect(root, { OPENCLAW_STATE_DIR: alias })).not.toBeNull();
});

it("lets the early release updater through when nothing migrates or state is unreadable", () => {
  for (const agents of [[OPENCLAW_AGENT_SCHEMA_VERSION], []]) {
    const { root, env } = install({ state: OPENCLAW_STATE_SCHEMA_VERSION, agents });
    expect(inspect(root, env)).toBeNull();
  }
  const newer = install({ state: OPENCLAW_STATE_SCHEMA_VERSION + 1, agents: [] });
  expect(inspect(newer.root, newer.env)).toBeNull();
  // A PostgreSQL-backed store's local anchor has user_version 0; the server holds the schema.
  const postgres = install({ state: 0, agents: [] });
  expect(inspect(postgres.root, postgres.env)).toBeNull();
  const unreadable = install({});
  fs.writeFileSync(path.join(unreadable.stateDir, "state", "openclaw.sqlite"), "not a database");
  expect(inspect(unreadable.root, unreadable.env)).toBeNull();
});

it("reads a rollback-journal store with locks, so a writer's commit is not skipped", async () => {
  const { root, env, stateDir } = install({});
  const file = path.join(stateDir, "agents", "a0", "agent", "openclaw-agent.sqlite");
  // A Gateway on a network filesystem, inside the transaction that migrates this store.
  const sql = `PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE; PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`;
  const code = `const db = new (require("node:sqlite").DatabaseSync)(process.argv[1]); db.exec(process.argv[2]); console.log(); setTimeout(() => db.exec("COMMIT"), 300);`;
  const writer = spawn(process.execPath, ["-e", code, file, sql]);
  await Promise.race([once(writer.stdout, "data"), once(writer, "exit")]);
  expect(inspect(root, env)?.pending?.agent).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  await once(writer, "exit");
});

it("stops a concurrent early updater while an automatic recovery's release exists", () => {
  const { root, env, stateDir } = install({ state: OPENCLAW_STATE_SCHEMA_VERSION, agents: [] });
  fs.mkdirSync(path.join(stateDir, "git-install", "recovery", "openclaw"), { recursive: true });
  const change = inspect(root, env)!;
  expect(change.pending).toBeNull();
  const refusal = formatEarlyGitReleaseRefusal(change, { started: false, running: "u" });
  expect(refusal).toContain("That recovery is still running and finishes the update");
});

it("never refuses another updater, which can finish a schema change", () => {
  for (const shape of [
    { layout: "current" as const },
    { layout: "package" as const },
    { legacyLink: false },
  ]) {
    const { root, env } = install(shape);
    expect(inspect(root, env)).toBeNull();
  }
  // A `build` directory outside this state directory's releases is not the early layout.
  const { env } = install({});
  const elsewhere = path.join(makeTempDir(roots, "openclaw-early-other-"), "releases/x/build");
  fs.mkdirSync(elsewhere, { recursive: true });
  expect(inspect(elsewhere, env)).toBeNull();
});
