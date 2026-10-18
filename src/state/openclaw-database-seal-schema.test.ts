import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readSqliteCleanCloseSeal,
  writeSqliteCleanCloseSeal,
} from "../infra/sqlite-clean-close-seal.js";

const inputs = vi.hoisted(() => ({
  version: "2026.10.1",
  commit: "first",
  build: "first",
  agent: "CREATE TABLE session_nodes (session_key TEXT);",
  state: "CREATE TABLE user_profiles (id TEXT);",
}));
vi.mock("./openclaw-agent-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-agent-schema.js")>()),
  get OPENCLAW_AGENT_SCHEMA_SQL() {
    return inputs.agent;
  },
}));
vi.mock("./openclaw-state-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-schema.js")>()),
  get OPENCLAW_STATE_SCHEMA_SQL() {
    return inputs.state;
  },
}));
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  get VERSION() {
    return inputs.version;
  },
  resolveRuntimeServiceCommit: () => inputs.commit,
  resolveRuntimeServiceBuildId: () => inputs.build,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  inputs.version = "2026.10.1";
  inputs.agent = "CREATE TABLE session_nodes (session_key TEXT);";
  inputs.state = "CREATE TABLE user_profiles (id TEXT);";
});

it.each(["agent", "state"] as const)(
  "retains %s proof across unrelated schema changes but rejects its own schema changes",
  async (kind) => {
    vi.resetModules();
    const { sqliteDatabaseSealSchemaFor } = await import("./openclaw-database-seal-schema.js");
    const before = sqliteDatabaseSealSchemaFor(kind);
    const unknown = sqliteDatabaseSealSchemaFor("other");
    inputs[kind === "agent" ? "state" : "agent"] += "\nCREATE TABLE unrelated (id TEXT);";
    vi.resetModules();
    const unrelated = await import("./openclaw-database-seal-schema.js");
    expect(unrelated.sqliteDatabaseSealSchemaFor(kind)).toBe(before);
    expect(unrelated.sqliteDatabaseSealSchemaFor("other")).not.toBe(unknown);
    inputs[kind] += "\nCREATE TABLE owned (id TEXT);";
    vi.resetModules();
    const changed = await import("./openclaw-database-seal-schema.js");
    expect(changed.sqliteDatabaseSealSchemaFor(kind)).not.toBe(before);
  },
);

it("reuses a clean seal across builds but validates again after a version change", async () => {
  vi.resetModules();
  const pathname = path.join(tempDirs.make("seal-build-identity-"), "database.sqlite");
  fs.writeFileSync(pathname, "unchanged synthetic database");
  const file = fs.statSync(pathname, { bigint: true });
  const proof = { verifiedAt: Date.now(), facts: "validated facts" };
  const first = await import("./openclaw-database-seal-schema.js");
  const schemaIdentity = first.sqliteDatabaseSealSchemaFor("agent");
  expect(writeSqliteCleanCloseSeal(pathname, schemaIdentity, file, proof)).toBe(true);
  expect(readSqliteCleanCloseSeal(pathname, file)).toEqual({ ...proof, schemaIdentity });

  inputs.commit = "second";
  inputs.build = "second";
  vi.resetModules();
  const rebuilt = await import("./openclaw-database-seal-schema.js");
  expect(rebuilt.sqliteDatabaseSealSchemaFor("agent")).toBe(schemaIdentity);
  expect(readSqliteCleanCloseSeal(pathname, file)?.schemaIdentity).toBe(
    rebuilt.sqliteDatabaseSealSchemaFor("agent"),
  );

  inputs.version = "2026.10.2";
  vi.resetModules();
  const upgraded = await import("./openclaw-database-seal-schema.js");
  expect(readSqliteCleanCloseSeal(pathname, file)?.schemaIdentity).not.toBe(
    upgraded.sqliteDatabaseSealSchemaFor("agent"),
  );
});
