import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveAgentPortRoots } from "./agent-port.js";
import { withDatabaseEngineSelection } from "./context.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("discovers default, shared auth, explicit session and retained agent stores without changing the registry", async () => {
  const root = tempDirs.make("agent-port-roots-");
  const stateDir = path.join(root, "selected");
  const sharedAuth = path.join(root, "shared-auth");
  const externalAgent = path.join(root, "custom-agent");
  const externalSession = path.join(root, "custom-session", "sessions.json");
  const retired = path.join(root, "retired", "agent.sqlite");
  const unconfigured = path.join(stateDir, "agents", "unconfigured", "agent");
  const systemAgent = path.join(stateDir, "agents", "crestodian", "agent");
  const registryPath = path.join(stateDir, "state", "openclaw.sqlite");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: sharedAuth };
  await fs.mkdir(unconfigured, { recursive: true });
  await fs.mkdir(systemAgent, { recursive: true });
  const bytes = await withDatabaseEngineSelection(
    { effectiveEngines: resolveDatabaseFamilyEngines({}) },
    async () => {
      const { db } = openOpenClawStateDatabase({ env });
      db.prepare(
        "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, ?, 0)",
      ).run("retired", retired, 21);
      closeOpenClawStateDatabaseByPath(registryPath);
      return fs.readFile(registryPath);
    },
  );

  const roots = await withDatabaseEngineSelection(
    { effectiveEngines: resolveDatabaseFamilyEngines({}) },
    () =>
      resolveAgentPortRoots({
        stateDir,
        env: { ...env, OPENCLAW_STATE_DIR: path.join(root, "unselected") },
        config: {
          // Offline source selection remains authoritative while config is being switched.
          database: { engine: "postgres" },
          agents: { entries: { selected: { agentDir: externalAgent } } },
          session: { store: externalSession },
        },
      }),
  );

  expect(new Set(roots)).toEqual(
    new Set([
      path.join(sharedAuth, "openclaw-agent.sqlite"),
      path.join(unconfigured, "openclaw-agent.sqlite"),
      path.join(systemAgent, "openclaw-agent.sqlite"),
      path.join(externalAgent, "openclaw-agent.sqlite"),
      path.join(root, "custom-session", "openclaw-agent.sqlite"),
      retired,
    ]),
  );
  expect(await fs.readFile(registryPath)).toEqual(bytes);
});
