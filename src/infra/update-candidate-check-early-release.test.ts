import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { refuseEarlyGitReleaseSchemaChange } from "./update-candidate-check-early-release.js";

const roots: string[] = [];
afterEach(() => cleanupTempDirs(roots));

function sqlite(file: string, version: number, setup = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`${setup} PRAGMA user_version = ${version};`);
  db.close();
}

/**
 * State and a release worktree as an updater leaves them when it runs this release's check:
 * the 2026-11-17 main layout (`releases/<id>/build` beside `lib/node_modules/openclaw`) by default.
 */
function install(params: {
  state?: number;
  agents?: number[];
  layout?: "build" | "current";
  legacyLink?: boolean;
}) {
  const stateDir = makeTempDir(roots, "openclaw-early-release-");
  const prefix = path.join(stateDir, "git-install");
  const agents = (params.agents ?? [OPENCLAW_AGENT_SCHEMA_VERSION - 1]).map((version, index) => {
    const file = path.join(stateDir, "agents", `a${index}`, "agent", "openclaw-agent.sqlite");
    sqlite(file, version);
    return file;
  });
  sqlite(
    path.join(stateDir, "state", "openclaw.sqlite"),
    params.state ?? OPENCLAW_STATE_SCHEMA_VERSION - 1,
    `CREATE TABLE agent_databases (path TEXT, agent_id TEXT);
     ${agents.map((file, index) => `INSERT INTO agent_databases VALUES ('${file}', 'a${index}');`).join("\n")}`,
  );
  const root = path.join(
    prefix,
    "releases",
    "git-b",
    params.layout === "current" ? "openclaw" : "build",
  );
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ".git"), "gitdir: /home/me/openclaw/.git/worktrees/build\n");
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
  return { root, env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv };
}

it("refuses a schema change for the early release updater and names the rebuild", () => {
  const { root, env } = install({});
  const refusal = refuseEarlyGitReleaseSchemaChange(root, env);

  expect(refusal).toContain(
    `state schema ${OPENCLAW_STATE_SCHEMA_VERSION - 1} to ${OPENCLAW_STATE_SCHEMA_VERSION}, agent schema ${OPENCLAW_AGENT_SCHEMA_VERSION - 1} to ${OPENCLAW_AGENT_SCHEMA_VERSION}`,
  );
  expect(refusal).toContain("Nothing was changed");
  expect(refusal?.split("\n").at(-1)).toBe(
    "cd /home/me/openclaw && openclaw gateway stop --force && git pull --ff-only && pnpm install --frozen-lockfile && pnpm build && openclaw doctor --fix && openclaw gateway install --force && openclaw gateway start",
  );
});

it("refuses when only one agent store is older", () => {
  const { root, env } = install({
    state: OPENCLAW_STATE_SCHEMA_VERSION,
    agents: [OPENCLAW_AGENT_SCHEMA_VERSION, OPENCLAW_AGENT_SCHEMA_VERSION - 1],
  });
  expect(refuseEarlyGitReleaseSchemaChange(root, env)).toContain(
    `agent schema ${OPENCLAW_AGENT_SCHEMA_VERSION - 1} to ${OPENCLAW_AGENT_SCHEMA_VERSION}`,
  );
});

it("lets the early release updater through when nothing migrates", () => {
  for (const agents of [[OPENCLAW_AGENT_SCHEMA_VERSION], []]) {
    const { root, env } = install({ state: OPENCLAW_STATE_SCHEMA_VERSION, agents });
    expect(refuseEarlyGitReleaseSchemaChange(root, env)).toBeNull();
  }
});

it("never refuses another updater, which can finish a schema change", () => {
  for (const shape of [{ layout: "current" as const }, { legacyLink: false }]) {
    const { root, env } = install(shape);
    expect(refuseEarlyGitReleaseSchemaChange(root, env)).toBeNull();
  }
});
