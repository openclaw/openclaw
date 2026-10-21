import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
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
const marker = "__OPENCLAW_REDACTED__";
const secret = { scope, name, value: "synthetic-original-token", kind: "secret" as const };

afterEach(() => closeOpenClawStateDatabaseAsync());

async function fixture(corrupt = false) {
  const stateDir = tempDirs.make("openclaw-store-redaction-");
  const env = {
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  const database = { env };
  const entry = { ...secret, updatedBy: "test", database };
  await writeSecretStoreEntry(entry);
  if (corrupt) {
    openOpenClawStateDatabase(database)
      .db.prepare("UPDATE secret_store_entries SET value = ? WHERE name = ?")
      .run(marker, name);
  }
  const read = () => readSecretStoreValue({ scope, name, database });
  return { env, database, entry, read };
}

describe("secret store redaction integrity", () => {
  it("refuses a padded display marker without overwriting the credential", async () => {
    const { entry, database, read } = await fixture();
    const before = await listSecretStoreEntries({ scope, database });
    await expect(
      writeSecretStoreEntry({ ...entry, value: " __OPENCLAW_REDACTED__\n", updatedBy: "cli" }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: "SECRET_STORE_VALUE_REDACTED",
        message: expect.stringContaining(name),
      }),
    );
    expect(await read()).toEqual({ ok: true, value: entry.value });
    expect(await listSecretStoreEntries({ scope, database })).toEqual(before);
  });

  it("preserves a concurrent replacement and compensates only its own repair", async () => {
    const { entry, read } = await fixture(true);
    const repair = await writeSecretStoreEntryWithRollback({
      ...entry,
      value: "synthetic-repaired-token",
      expectedValue: marker,
    });
    expect(await repair.rollback()).toBe(true);
    expect(await read()).toEqual({ ok: true, value: marker });
    await writeSecretStoreEntry({ ...entry, value: "synthetic-concurrent-token" });
    await expect(
      writeSecretStoreEntryWithRollback({ ...entry, expectedValue: marker }),
    ).rejects.toThrow(expect.objectContaining({ code: "SECRET_STORE_VALUE_CHANGED" }));
    expect(await read()).toEqual({ ok: true, value: "synthetic-concurrent-token" });
  });

  it("rejects a pre-existing corrupted row with its exact reference and repair command", async () => {
    const { env } = await fixture(true);
    await expect(resolveSecretRefString(ref, { config: {}, env })).rejects.toMatchObject({
      code: "SECRET_REF_REDACTED_VALUE",
      source: "store",
      provider: "default",
      refId: name,
      message: expect.stringContaining("openclaw doctor --fix"),
    });
  });

  it("quarantines a corrupted row from exec and egress without hiding healthy siblings", async () => {
    const { database, entry } = await fixture(true);
    const sibling = {
      ...entry,
      name: "SERVICE_MODE",
      value: "synthetic-mode",
      kind: "env" as const,
    };
    await writeSecretStoreEntry(sibling);
    const result = await readSecretStoreExecEnvironment({ includeSecretSentinels: true, database });
    expect(result).toEqual({ env: { SERVICE_MODE: "synthetic-mode" } });
  });

  it("reports a resolvable redaction marker as an audit error", async () => {
    const { env } = await fixture(true);
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
