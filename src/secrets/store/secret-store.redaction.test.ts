import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveSecretsAuditExitCode, runSecretsAudit } from "../audit.js";
import { resolveSecretRefString } from "../resolve.js";
import {
  listSecretStoreEntries,
  readSecretStoreExecEnvironment,
  readSecretStoreValue,
  writeSecretStoreEntry,
  writeSecretStoreEntryWithRollback,
} from "./secret-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scope = { kind: "team" } as const;
const name = "OPENCLAW_GATEWAY_TOKEN";
const ref = { source: "store", provider: "default", id: name } as const;

afterEach(() => closeOpenClawStateDatabaseForTest());

function fixture() {
  const stateDir = tempDirs.make("openclaw-store-redaction-");
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  const database = { env };
  const entry = {
    scope,
    name,
    value: "synthetic-original-token",
    kind: "secret" as const,
    updatedBy: "test",
    database,
  };
  writeSecretStoreEntry(entry);
  return { env, database, entry };
}

function corruptStoredValue(database: ReturnType<typeof fixture>["database"]): void {
  openOpenClawStateDatabase(database)
    .db.prepare("UPDATE secret_store_entries SET value = ? WHERE name = ?")
    .run("__OPENCLAW_REDACTED__", name);
}

describe("secret store redaction integrity", () => {
  it.each([
    "__OPENCLAW_REDACTED__",
    "REDACTED",
    "xoxb-REDACTED",
    "xapp-REDACTED",
    "***",
    "[redacted]",
    "[REDACTED]",
    "<redacted>",
    "[REDACTED_PRIVATE_KEY]",
    "[REDACTED CREDENTIAL]",
    " __OPENCLAW_REDACTED__\n",
  ])("refuses display marker %s without overwriting the credential", (value) => {
    const { entry, database } = fixture();
    const before = listSecretStoreEntries({ scope, database });
    expect(() => writeSecretStoreEntry({ ...entry, value, updatedBy: "cli" })).toThrow(
      expect.objectContaining({
        code: "SECRET_STORE_VALUE_REDACTED",
        message: expect.stringContaining(name),
      }),
    );
    expect(readSecretStoreValue({ scope, name, database })).toEqual({
      ok: true,
      value: entry.value,
    });
    expect(listSecretStoreEntries({ scope, database })).toEqual(before);
  });

  it("preserves a concurrent replacement and compensates only its own repair", () => {
    const { entry, database } = fixture();
    corruptStoredValue(database);
    const repair = writeSecretStoreEntryWithRollback({
      ...entry,
      value: "synthetic-repaired-token",
      expectedValue: "__OPENCLAW_REDACTED__",
    });
    expect(repair.rollback()).toBe(true);
    expect(readSecretStoreValue({ scope, name, database })).toEqual({
      ok: true,
      value: "__OPENCLAW_REDACTED__",
    });
    writeSecretStoreEntry({ ...entry, value: "synthetic-concurrent-token" });
    expect(() =>
      writeSecretStoreEntryWithRollback({ ...entry, expectedValue: "__OPENCLAW_REDACTED__" }),
    ).toThrow(expect.objectContaining({ code: "SECRET_STORE_VALUE_CHANGED" }));
    expect(readSecretStoreValue({ scope, name, database })).toEqual({
      ok: true,
      value: "synthetic-concurrent-token",
    });
  });

  it("rejects a pre-existing corrupted row with its exact reference and repair command", async () => {
    const { database, env } = fixture();
    corruptStoredValue(database);
    await expect(resolveSecretRefString(ref, { config: {}, env })).rejects.toMatchObject({
      code: "SECRET_REF_REDACTED_VALUE",
      source: "store",
      provider: "default",
      refId: name,
      message: expect.stringContaining("openclaw doctor --fix"),
    });
  });

  it("quarantines a corrupted row from exec and egress without hiding healthy siblings", () => {
    const { database, entry } = fixture();
    corruptStoredValue(database);
    writeSecretStoreEntry({ ...entry, name: "SERVICE_MODE", value: "synthetic-mode", kind: "env" });
    expect(readSecretStoreExecEnvironment({ includeSecretSentinels: true, database })).toEqual({
      env: { SERVICE_MODE: "synthetic-mode" },
    });
  });

  it("reports a resolvable redaction marker as an audit error", async () => {
    const { database, env } = fixture();
    corruptStoredValue(database);
    await fs.writeFile(
      env.OPENCLAW_CONFIG_PATH,
      JSON.stringify({ gateway: { auth: { mode: "token", token: ref } } }),
    );
    const report = await runSecretsAudit({ env });
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "PLACEHOLDER_VALUE",
        severity: "error",
        jsonPath: "gateway.auth.token",
        message: expect.stringContaining(name),
      }),
    );
    expect(report.summary.unresolvedRefCount).toBe(1);
    expect(resolveSecretsAuditExitCode(report, false)).toBe(2);
  });
});
