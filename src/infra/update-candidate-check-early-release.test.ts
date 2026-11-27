import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { refuseEarlyGitReleaseSchemaChange as refuse } from "./update-candidate-check-early-release.js";

const roots: string[] = [];
afterEach(() => cleanupTempDirs(roots));

const rebuild = (link: string) => {
  const quoted = `"${link}/git-install/lib/node_modules/openclaw"`;
  return `oc_link= && git pull --ff-only && openclaw gateway stop --force && pnpm install --frozen-lockfile && pnpm build && oc_link=$(readlink ${quoted} || true) && rm -f ${quoted} && openclaw gateway install --force || { [ -z "$oc_link" ] || [ -L ${quoted} ] || ln -s "$oc_link" ${quoted}; openclaw gateway start; false; }`;
};

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
  const { root, stateDir, env } = install({});
  // The state directory under HOME, as the early updater runs the check; its output replaces
  // that directory with a placeholder, so the link is spelled from $HOME.
  const home = path.dirname(stateDir);
  const homeEnv = { ...env, HOME: home };
  for (const platform of ["darwin", "linux"] as const) {
    const lines = refuse(root, homeEnv, platform)!.split("\n");
    expect(lines[0]).toContain(
      `state schema ${OPENCLAW_STATE_SCHEMA_VERSION - 1} to ${OPENCLAW_STATE_SCHEMA_VERSION}, agent schema ${OPENCLAW_AGENT_SCHEMA_VERSION - 1} to ${OPENCLAW_AGENT_SCHEMA_VERSION}`,
    );
    expect(lines).toContain(
      "The update stopped before switching releases; the Gateway was not touched. Running `openclaw update` again stops here the same way.",
    );
    expect(lines.at(-1)).toBe(rebuild(`$HOME/${path.basename(stateDir)}`));
    expect(lines.join("\n")).not.toContain(home);
    expect(lines.join("\n")).not.toMatch(/automatic|background|systemctl|launchctl/iu);
  }
  // PowerShell has no `{ ...; false; }` group, so Windows gets the steps one per line.
  const windows = refuse(root, homeEnv, "win32")!.split("\n");
  expect(windows.slice(-4)).toEqual([
    "git pull --ff-only",
    "openclaw gateway stop --force",
    "pnpm install --frozen-lockfile",
    "pnpm build",
  ]);
  expect(windows.at(-5)).toContain(
    "then remove the link git-install\\lib\\node_modules\\openclaw in the OpenClaw state directory and run `openclaw gateway install --force`",
  );
  // A second update reads the same unchanged state and gets the same reason.
  expect(refuse(root, homeEnv, "darwin")).toBe(refuse(root, homeEnv, "darwin"));
});

it.runIf(process.platform !== "win32")(
  "names a link path the shell resolves to this state directory's link",
  () => {
    const { root, stateDir } = install({});
    const home = makeTempDir(roots, "openclaw-early-release-home-");
    const odd = path.join(home, 'state "$x" `y` \\z');
    fs.renameSync(stateDir, odd);
    const line = refuse(
      root.replace(stateDir, odd),
      { OPENCLAW_STATE_DIR: odd, HOME: home },
      "linux",
    )!
      .split("\n")
      .at(-1)!;
    const word = /rm -f ("(?:[^"\\]|\\.)*")/u.exec(line)![1];
    // The shell the user runs the line in expands the word to the real link.
    const expanded = execFileSync("/bin/sh", ["-c", `printf %s ${word}`], {
      env: { HOME: home, PATH: process.env.PATH },
      encoding: "utf8",
    });
    expect(expanded).toBe(path.join(odd, "git-install", "lib", "node_modules", "openclaw"));
    expect(fs.lstatSync(expanded).isSymbolicLink()).toBe(true);
  },
);

it.runIf(process.platform !== "win32")(
  "runs the printed line only with a known state directory and restores the link when the install fails",
  () => {
    const { root, stateDir, env } = install({});
    const line = refuse(root, { ...env, HOME: "/nonexistent-home" }, "linux")!
      .split("\n")
      .at(-1)!;
    // Stand-ins for git, pnpm and openclaw record each step the line reaches.
    const bin = makeTempDir(roots, "openclaw-early-release-bin-");
    const log = path.join(bin, "calls.log");
    for (const tool of ["git", "pnpm", "openclaw"]) {
      fs.writeFileSync(
        path.join(bin, tool),
        `#!/bin/sh\necho "${tool} $*" >> "${log}"\n[ "$1 $2" = "gateway install" ] && [ -n "$FAIL_INSTALL" ] && exit 1\nexit 0\n`,
        { mode: 0o755 },
      );
    }
    const run = (extra: NodeJS.ProcessEnv) =>
      spawnSync("/bin/sh", ["-c", line], {
        env: { PATH: `${bin}:/usr/bin:/bin`, ...extra },
        encoding: "utf8",
      });
    const link = path.join(stateDir, "git-install", "lib", "node_modules", "openclaw");

    const unset = run({});
    expect(unset.status).not.toBe(0);
    expect(unset.stderr).toContain("set it to the OpenClaw state directory");
    // Nothing ran: the Gateway was not stopped and the link is still there.
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);

    // A failed service install puts the link back before starting the previous service.
    const target = fs.readlinkSync(link);
    const failed = run({ OPENCLAW_STATE_DIR: stateDir, FAIL_INSTALL: "1" });
    expect(failed.status).not.toBe(0);
    expect(fs.readlinkSync(link)).toBe(target);
    expect(fs.readFileSync(log, "utf8").trim().split("\n").slice(-2)).toEqual([
      "openclaw gateway install --force",
      "openclaw gateway start",
    ]);
    fs.rmSync(log);

    expect(run({ OPENCLAW_STATE_DIR: stateDir }).status).toBe(0);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "git pull --ff-only",
      "openclaw gateway stop --force",
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "openclaw gateway install --force",
    ]);
    expect(fs.lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
  },
);

it("survives the early updater's redaction of its check output unchanged", () => {
  const { root, stateDir, env } = install({});
  // The early updater prints this stderr through the same redaction (unchanged since then), with
  // its state directory and home; a state directory outside home is spelled from the variable.
  for (const home of [path.dirname(stateDir), "/nonexistent-home"]) {
    const refusal = refuse(root, { ...env, HOME: home }, "linux")!;
    expect(
      redactSupportString(refusal, { env: { HOME: home }, stateDir }, { maxLength: 8192 }),
    ).toBe(refusal);
  }
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
