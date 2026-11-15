import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import * as identity from "./openclaw-agent-db-identity.js";
import { useAgentDatabaseDirectories } from "./openclaw-agent-db-lifecycle.test-support.js";
import { retainOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import * as proof from "./openclaw-agent-db-validation-cache.js";
import * as agentDb from "./openclaw-agent-db.js";

let directory: string;
let env: NodeJS.ProcessEnv;
const claims: identity.OpenClawAgentDatabaseClaim[] = [];
const directories = useAgentDatabaseDirectories(() => {
  for (const claim of claims.splice(0)) {
    claim.release();
  }
});

beforeEach(() => {
  directory = directories.make("agent-db-identity-");
  env = { OPENCLAW_STATE_DIR: directory };
});

function retain(databasePath: string) {
  const result = retainOpenClawAgentDatabaseReadOnly({ agentId: "main", env, path: databasePath });
  if (!result.found) {
    throw new Error(`Expected existing database: ${result.reason}`);
  }
  claims.push(result.claim);
  return result;
}

function open(databasePath?: string) {
  return agentDb.openOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });
}

it.runIf(process.platform !== "win32")(
  "keeps physical identity and lexical close ownership through a symlink retarget",
  () => {
    const original = open();
    const alias = path.join(directory, "alias.sqlite");
    fs.symlinkSync(original.path, alias);
    const aliased = open(alias);
    const { claim } = retain(alias);
    const replacement = open(path.join(directory, "replacement.sqlite"));
    const originalIdentity = retain(original.path).claim.identity;
    const replacementIdentity = retain(replacement.path).claim.identity;
    const originalProof = proof.getOpenClawAgentDatabaseValidation(original);
    const replacementProof = proof.getOpenClawAgentDatabaseValidation(replacement);
    expect(originalProof).toBeDefined();
    expect(replacementProof).toBeDefined();
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement.path, alias);

    expect(open(alias)).toBe(aliased);
    expect(claim.identity).toBe(originalIdentity);
    expect(claim.identity).not.toBe(replacementIdentity);
    expect(proof.getOpenClawAgentDatabaseValidation(aliased)).toBe(originalProof);
    expect(proof.hasOpenClawAgentCanonicalValidation(aliased)).toBe(true);
    expect(proof.getOpenClawAgentDatabaseValidationForTransfer(replacement)).toBe(replacementProof);
    proof.invalidateOpenClawAgentDatabaseValidation(original.path);
    expect(proof.getOpenClawAgentDatabaseValidation(aliased)).toBeUndefined();
    expect(proof.hasOpenClawAgentCanonicalValidation(aliased)).toBe(false);
    expect(proof.getOpenClawAgentDatabaseValidationForTransfer(replacement)).toBe(replacementProof);
    expect(agentDb.closeOpenClawAgentDatabaseByPath(alias)).toBe(true);
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
  const database = open();
  agentDb.closeOpenClawAgentDatabaseByPath(database.path);
  const registry = agentDb.listOpenClawRegisteredAgentDatabases({ env });
  const { database: reader, claim } = retain(database.path);
  expect(claim.isCurrent()).toBe(true);
  expect(agentDb.isOpenClawAgentDatabaseOpen(database.path)).toBe(false);
  expect(() => reader.db.exec("CREATE TABLE unexpected (value TEXT)")).toThrow(/readonly/);
  expect(agentDb.listOpenClawRegisteredAgentDatabases({ env })).toEqual(registry);
  claim.release();
  expect(reader.db.isOpen).toBe(true);
  expect(() => claim.assertCurrent()).toThrow("no longer current");
  agentDb.closeOpenClawAgentDatabaseByPath(database.path);
  expect(reader.db.isOpen).toBe(false);

  const missing = path.join(directory, "missing", "agent.sqlite");
  expect(retainOpenClawAgentDatabaseReadOnly({ agentId: "main", env, path: missing })).toEqual({
    found: false,
    reason: "database-missing",
  });
  expect(fs.existsSync(path.dirname(missing))).toBe(false);
});

it.runIf(typeof DatabaseSync.prototype.deserialize === "function")(
  "preserves file identity after failed deserialization but rejects a successful in-memory replacement",
  () => {
    const original = open();
    agentDb.closeOpenClawAgentDatabaseByPath(original.path);
    const { database } = retain(original.path);
    const prepared = identity.readOpenClawAgentDatabaseIdentity(database);
    const db = requireNativeSqliteDatabase(database.db);
    const nativeLocation = db.location();
    using replacement = new DatabaseSync(":memory:");
    replacement.exec("CREATE TABLE restored(value); INSERT INTO restored VALUES (42)");
    const bytes = replacement.serialize();
    expect(identity.isOpenClawAgentDatabasePathCurrent(database)).toBe(true);
    database.db.exec("BEGIN");
    try {
      database.db.prepare("SELECT role FROM schema_meta").get();
      expect(() => db.deserialize(bytes)).toThrow();
      expect(db.location()).toBe(nativeLocation);
      expect(identity.isOpenClawAgentDatabasePathCurrent(database)).toBe(true);
    } finally {
      database.db.exec("ROLLBACK");
    }

    db.deserialize(bytes);
    expect(database.db.prepare("SELECT value FROM restored").get()?.value).toBe(42);
    expect(db.location()).toBeNull();
    expect(fs.existsSync(original.path)).toBe(true);
    expect(identity.readOpenClawAgentDatabaseIdentity(database)).toBe(prepared);
    expect(identity.isOpenClawAgentDatabasePathCurrent(database)).toBe(false);
  },
);

it("releases only one warm claim while revoking its retained copies", () => {
  const database = open();
  const { claim: first } = retain(database.path);
  const { claim: second } = retain(database.path);
  expect(first.incarnation).toBe(second.incarnation);
  const assertCurrent = first.assertCurrent;
  first.release();
  first.release();
  expect(assertCurrent).toThrow("no longer current");
  expect(second.isCurrent()).toBe(true);
});

it("does not reuse a reopened connection claim", () => {
  const { path: databasePath } = open();
  const { claim } = retain(databasePath);
  agentDb.closeOpenClawAgentDatabaseByPath(databasePath);
  expect(claim.isCurrent()).toBe(false);
  expect(claim.assertCurrent).toThrow("no longer current");
  open(databasePath);
  const { claim: replacement } = retain(databasePath);
  expect(claim.incarnation).not.toBe(replacement.incarnation);
  expect(claim.isCurrent()).toBe(false);
  expect(replacement.isCurrent()).toBe(true);
  expect(claim.identity).toBe(replacement.identity);
  claim.release();
  claim.release();
  expect(replacement.isCurrent()).toBe(true);
});
