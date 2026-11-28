import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import {
  databasePath,
  seedClaim,
  type ClaimTarget,
  type setupLegacyMainSessionMigrationTests,
} from "./legacy-main-session-migration.test-support.js";

type Fixture = ReturnType<ReturnType<typeof setupLegacyMainSessionMigrationTests>["createFixture"]>;

export function createLegacyMainSessionHandoff(
  fixture: Fixture,
  sessionId: string,
  storePath?: string,
) {
  const makeTarget = (agent: string): ClaimTarget => ({
    databaseAgentId: storePath ? "main" : agent,
    databasePath: storePath ?? databasePath(fixture.stateDir, agent),
    key: `agent:${agent}:chat`,
  });
  const source = makeTarget("main"),
    destination = makeTarget("ops");
  const entry = { sessionId, updatedAt: 100 };
  const events = [
    { type: "session", version: 3, id: sessionId, timestamp: new Date(1).toISOString() },
  ];
  const seed = (target: ClaimTarget) => seedClaim({ ...target, entry, events });
  seed(source);
  const withDatabase = <T>(target: ClaimTarget, run: (db: OpenClawAgentDatabase) => T) =>
    runOpenClawAgentWriteTransaction(run, {
      agentId: target.databaseAgentId,
      env: fixture.env,
      path: target.databasePath,
    });
  const scope = (target: ClaimTarget) => ({
    agentId: target.key === source.key ? "main" : "ops",
    env: fixture.env,
    storePath: target.databasePath,
    sessionKey: target.key,
    sessionId,
  });
  const migrate = () =>
    migrateLegacyMainSessionKeys({ cfg: fixture.cfg, env: fixture.env, mode: "doctor-fix" });
  return { source, destination, entry, seed, withDatabase, scope, migrate };
}
