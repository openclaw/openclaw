import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { repairLegacySessionEntryStates } from "./doctor-session-delivery-state.js";

let state: OpenClawTestState;

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await state?.cleanup();
});

it("names the pending agent schema migration instead of a redacted refusal", async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  const pathname = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
  closeOpenClawAgentDatabasesForTest();
  {
    using database = new DatabaseSync(pathname);
    database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1};`);
  }

  const failure = await withEnvAsync({ HOME: state.home, OPENCLAW_STATE_DIR: state.stateDir }, () =>
    repairLegacySessionEntryStates({ apply: false, cfg: {}, env: state.env }).catch(
      (error: unknown) => error,
    ),
  );

  expect(failure).toBeInstanceOf(DoctorStateMigrationRefusalError);
  const refusal = failure as DoctorStateMigrationRefusalError;
  // The operator sees the cause, the database (home-relative), and the command that completes it.
  expect(refusal.message).toContain("Doctor found pending state migrations");
  expect(refusal.message).toContain('Run "openclaw doctor --fix"');
  expect(refusal.message).toMatch(
    /(?:~|\$OPENCLAW_HOME)\/\.openclaw\/agents\/main\/agent\/openclaw-agent\.sqlite/u,
  );
  expect(refusal.message).toContain(`uses schema version ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}`);
  expect(refusal.message).toContain(
    `upgrade it to schema version ${OPENCLAW_AGENT_SCHEMA_VERSION}`,
  );
  expect(refusal.message).not.toContain(state.home);
  expect(refusal.message).not.toContain("[redacted-path]");
  expect(refusal.message).not.toContain("refused to continue");
  // Persisted failure facts keep the support-report redaction.
  expect(refusal.failureFacts).toContainEqual({
    check: "session-entry-state",
    code: "state-migration-pending",
    message: "OpenClaw agent database [redacted-path]",
  });
});
