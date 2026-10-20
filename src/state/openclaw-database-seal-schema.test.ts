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
  agentVersion: 31,
  stateVersion: 28,
  storageIdentity: "sqlite-3.53.4-source-build" as string | undefined,
}));
vi.mock("../infra/sqlite-native-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-native-runtime.js")>();
  return {
    ...actual,
    captureSqliteNativeRuntimeAdmission: () => ({
      ...actual.captureSqliteNativeRuntimeAdmission(),
      storageIdentity: inputs.storageIdentity,
    }),
  };
});
vi.mock("./openclaw-schema-versions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-schema-versions.js")>()),
  get OPENCLAW_AGENT_SCHEMA_VERSION() {
    return inputs.agentVersion;
  },
  get OPENCLAW_STATE_SCHEMA_VERSION() {
    return inputs.stateVersion;
  },
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
  inputs.agentVersion = 31;
  inputs.stateVersion = 28;
  inputs.storageIdentity = "sqlite-3.53.4-source-build";
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
    expect(unrelated.sqliteDatabaseSealSchemaFor(kind)).toEqual(before);
    expect(unrelated.sqliteDatabaseSealSchemaFor("other")).not.toEqual(unknown);
    inputs[kind] += "\nCREATE TABLE owned (id TEXT);";
    vi.resetModules();
    const changed = await import("./openclaw-database-seal-schema.js");
    expect(changed.sqliteDatabaseSealSchemaFor(kind)).not.toEqual(before);
  },
);

it("reuses a clean seal across builds and app-version changes", async () => {
  vi.resetModules();
  const pathname = path.join(tempDirs.make("seal-build-identity-"), "database.sqlite");
  fs.writeFileSync(pathname, "unchanged synthetic database");
  const file = fs.statSync(pathname, { bigint: true });
  const proof = { verifiedAt: Date.now(), facts: "validated facts" };
  const first = await import("./openclaw-database-seal-schema.js");
  const schemaIdentity = first.sqliteDatabaseSealSchemaFor("agent")!.schemaIdentity;
  expect(writeSqliteCleanCloseSeal(pathname, schemaIdentity, file, proof)).toBe(true);
  expect(readSqliteCleanCloseSeal(pathname, file)).toEqual({ ...proof, schemaIdentity });

  inputs.commit = "second";
  inputs.build = "second";
  vi.resetModules();
  const rebuilt = await import("./openclaw-database-seal-schema.js");
  expect(rebuilt.sqliteDatabaseSealSchemaFor("agent")?.schemaIdentity).toBe(schemaIdentity);
  expect(readSqliteCleanCloseSeal(pathname, file)?.schemaIdentity).toBe(
    rebuilt.sqliteDatabaseSealSchemaFor("agent")?.schemaIdentity,
  );

  inputs.version = "2026.10.2";
  vi.resetModules();
  const upgraded = await import("./openclaw-database-seal-schema.js");
  expect(readSqliteCleanCloseSeal(pathname, file)?.schemaIdentity).toBe(
    upgraded.sqliteDatabaseSealSchemaFor("agent")?.schemaIdentity,
  );
});

it.each(["agent", "state"] as const)(
  "invalidates %s proof when its schema version changes",
  async (kind) => {
    const { sqliteDatabaseSealSchemaFor } = await import("./openclaw-database-seal-schema.js");
    const before = sqliteDatabaseSealSchemaFor(kind);
    inputs[kind === "agent" ? "stateVersion" : "agentVersion"]++;
    expect(sqliteDatabaseSealSchemaFor(kind)).toEqual(before);
    inputs[kind === "agent" ? "agentVersion" : "stateVersion"]++;
    expect(sqliteDatabaseSealSchemaFor(kind)).not.toEqual(before);
  },
);

it("invalidates proof for a different or unknown SQLite storage stack", async () => {
  const { sqliteDatabaseSealSchemaFor } = await import("./openclaw-database-seal-schema.js");
  const before = sqliteDatabaseSealSchemaFor("agent");
  inputs.storageIdentity = "sqlite-3.54.0-source-build";
  expect(sqliteDatabaseSealSchemaFor("agent")).not.toEqual(before);
  inputs.storageIdentity = undefined;
  expect(sqliteDatabaseSealSchemaFor("agent")).toBeUndefined();
});
