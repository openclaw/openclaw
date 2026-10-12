import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const fixtureUrl = new URL("../../../test/fixtures/sqlite/", import.meta.url);

export function seedLegacyAgentDeletionFixture(
  root: string,
  configPath: string,
  deleteFiles: boolean,
) {
  const stateDir = path.join(root, "state");
  const stateDatabase = path.join(stateDir, "state", "openclaw.sqlite");
  const workspace = (agentId: string) => path.join(root, `workspace-${agentId}`);
  const agentDatabase = (agentId: string) =>
    path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
  const writeDatabase = (file: string, sql: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const database = new DatabaseSync(file);
    try {
      database.exec(sql);
      database.exec("PRAGMA journal_mode = WAL");
    } finally {
      database.close();
    }
  };
  writeDatabase(
    stateDatabase,
    fs
      .readFileSync(new URL("openclaw-state-v2026.9.9.sql", fixtureUrl), "utf8")
      .replaceAll("__FIXTURE_ROOT__", root.replaceAll("\\", "/").replaceAll("'", "''")) +
      `\nUPDATE agent_deletion_journal SET delete_files = ${Number(deleteFiles)};`,
  );
  const agentSql = fs.readFileSync(new URL("openclaw-agent-v2026.9.9.sql", fixtureUrl), "utf8");
  for (const agentId of ["keeper", "doomed"]) {
    writeDatabase(agentDatabase(agentId), agentSql.replaceAll("keeper", agentId));
    fs.mkdirSync(path.join(stateDir, "agents", agentId, "sessions"), { recursive: true });
    fs.mkdirSync(workspace(agentId), { recursive: true });
    fs.writeFileSync(
      path.join(workspace(agentId), `${agentId}-witness.txt`),
      `${agentId} workspace witness\n`,
    );
  }
  fs.mkdirSync(workspace("main"), { recursive: true });
  const config = {
    meta: {
      lastTouchedVersion: "2026.9.9",
      migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true },
    },
    gateway: { mode: "local", auth: { mode: "token", token: "synthetic-upgrade-fixture-only" } },
    agents: {
      ownership: "explicit",
      defaults: {
        model: "openai/gpt-4.1",
        skipBootstrap: true,
        systemAgent: { agentId: "main" },
        heartbeat: { every: "0m" },
      },
      entries: {
        main: { name: "Stable Main", workspace: workspace("main") },
        keeper: { name: "Stable Keeper", workspace: workspace("keeper") },
        doomed: {
          name: "doomed",
          workspace: workspace("doomed"),
          agentDir: path.dirname(agentDatabase("doomed")),
        },
      },
    },
    plugins: { enabled: false },
    update: { channel: "stable" },
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    stateDir,
    configPath,
    stateDatabase,
    keeperDatabase: agentDatabase("keeper"),
    doomedDatabase: agentDatabase("doomed"),
    keeperWorkspace: workspace("keeper"),
    doomedWorkspace: workspace("doomed"),
    keeperSessionKey: "agent:keeper:stable-upgrade",
    keeperSessionId: "10000000-0000-4000-8000-000000000001",
    keeperTranscriptText:
      "Synthetic v2026.9.9 keeper transcript survives only when its agent survives.",
    userId: "1dfe86ae-0765-48eb-a1f3-05220f74bff5",
    preferences: { "ui.themeMode": "dark" },
    config,
  };
}
