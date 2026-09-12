import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawAgentDatabaseClaim } from "./openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

let directory: string;
let env: NodeJS.ProcessEnv;
const claims: OpenClawAgentDatabaseClaim[] = [];

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-db-identity-")));
  env = { OPENCLAW_STATE_DIR: directory };
});

afterEach(() => {
  for (const claim of claims.splice(0)) {
    claim.release();
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(directory, { recursive: true, force: true });
});

function retain(databasePath: string) {
  const result = retainOpenClawAgentDatabaseReadOnly({ agentId: "main", env, path: databasePath });
  if (!result.found) {
    throw new Error(`Expected existing database: ${result.reason}`);
  }
  claims.push(result.claim);
  return result;
}

it.runIf(process.platform !== "win32")(
  "keeps physical identity and lexical close ownership through a symlink retarget",
  () => {
    const original = openOpenClawAgentDatabase({ agentId: "main", env });
    const alias = path.join(directory, "alias.sqlite");
    fs.symlinkSync(original.path, alias);
    const aliased = openOpenClawAgentDatabase({ agentId: "main", env, path: alias });
    const { claim } = retain(alias);
    const replacement = openOpenClawAgentDatabase({
      agentId: "main",
      env,
      path: path.join(directory, "replacement.sqlite"),
    });
    const originalIdentity = retain(original.path).claim.identity;
    const replacementIdentity = retain(replacement.path).claim.identity;
    expect(claim.identity).toBe(originalIdentity);
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement.path, alias);

    expect(openOpenClawAgentDatabase({ agentId: "main", env, path: alias })).toBe(aliased);
    expect(claim.identity).toBe(originalIdentity);
    expect(claim.identity).not.toBe(replacementIdentity);
    expect(closeOpenClawAgentDatabaseByPath(alias)).toBe(true);
    expect(claim.isCurrent()).toBe(false);
    expect(() => claim.assertCurrent()).toThrow("no longer current");
    expect(original.db.isOpen).toBe(true);
    expect(replacement.db.isOpen).toBe(true);
    const { claim: current } = retain(alias);
    expect(current.identity).toBe(replacementIdentity);
    expect(claim.isCurrent()).toBe(false);
  },
);

it("retains cold existing stores read-only without registering or creating missing stores", () => {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  closeOpenClawAgentDatabaseByPath(database.path);
  const registry = listOpenClawRegisteredAgentDatabases({ env });
  const { database: readOnlyDatabase, claim } = retain(database.path);
  expect(claim.isCurrent()).toBe(true);
  expect(isOpenClawAgentDatabaseOpen(database.path)).toBe(false);
  expect(() => readOnlyDatabase.db.exec("CREATE TABLE unexpected (value TEXT)")).toThrow(
    /readonly/,
  );
  expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual(registry);
  claim.release();
  expect(readOnlyDatabase.db.isOpen).toBe(false);
  expect(() => claim.assertCurrent()).toThrow("no longer current");

  const missing = path.join(directory, "missing", "agent.sqlite");
  expect(retainOpenClawAgentDatabaseReadOnly({ agentId: "main", env, path: missing })).toEqual({
    found: false,
    reason: "database-missing",
  });
  expect(fs.existsSync(path.dirname(missing))).toBe(false);
});

it("releases only one warm claim while revoking its retained copies", () => {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const { claim: first } = retain(database.path);
  const { claim: second } = retain(database.path);
  expect(first.incarnation).toBe(second.incarnation);
  const assertCurrent = first.assertCurrent;
  first.release();
  first.release();
  expect(() => assertCurrent()).toThrow("no longer current");
  expect(second.isCurrent()).toBe(true);
  expect(database.db.isOpen).toBe(true);
});

it.each([false, true])("does not reuse a reopened connection claim, incognito=%s", (incognito) => {
  const databasePath = incognito
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env })
    : path.join(directory, "agent.sqlite");
  expect(retainOpenClawAgentDatabaseReadOnly({ agentId: "main", env, path: databasePath })).toEqual(
    {
      found: false,
      reason: "database-missing",
    },
  );
  openOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });
  const { claim } = retain(databasePath);
  closeOpenClawAgentDatabaseByPath(databasePath);
  openOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });
  const { claim: replacement } = retain(databasePath);
  expect(claim.incarnation).not.toBe(replacement.incarnation);
  expect(claim.isCurrent()).toBe(false);
  expect(replacement.isCurrent()).toBe(true);
  if (incognito) {
    expect(claim.identity).not.toBe(replacement.identity);
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(listOpenClawRegisteredAgentDatabases({ env })).toEqual([]);
  } else {
    expect(claim.identity).toBe(replacement.identity);
  }
});
