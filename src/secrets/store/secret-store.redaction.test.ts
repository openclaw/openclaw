import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as state from "../../state/openclaw-state-db.js";
import { resolveSecretsAuditExitCode, runSecretsAudit } from "../audit.js";
import { resolveSecretRefString } from "../resolve.js";
import * as store from "./secret-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scope = { kind: "team" } as const;
const name = "OPENCLAW_GATEWAY_TOKEN";
const ref = { source: "store", provider: "default", id: name } as const;
const config = { gateway: { auth: { mode: "token", token: ref } } };
const marker = "__OPENCLAW_REDACTED__";
const secret = { scope, name, value: "synthetic-original-token", kind: "secret" as const };

afterEach(() => state.closeOpenClawStateDatabaseAsync());

async function fixture(corrupt = false) {
  const root = tempDirs.make("openclaw-store-redaction-");
  const env = { OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, "c.json") };
  const database = { env };
  const entry = { ...secret, updatedBy: "test", database };
  await store.writeSecretStoreEntry(entry);
  if (corrupt) {
    state
      .openOpenClawStateDatabase(database)
      .db.prepare("UPDATE secret_store_entries SET value = ? WHERE name = ?")
      .run(marker, name);
  }
  const write = (overrides: Partial<store.SecretStoreWriteParams>) =>
    store.writeSecretStoreEntry({ ...entry, ...overrides });
  return { env, database, entry, write };
}

it("refuses a padded display marker without overwriting the credential", async () => {
  const { entry, database, write } = await fixture();
  const before = await store.listSecretStoreEntries({ scope, database });
  const attempt = write({ value: " __OPENCLAW_REDACTED__\n", updatedBy: "cli" });
  await expect(attempt).rejects.toMatchObject({
    code: "SECRET_STORE_VALUE_REDACTED",
    message: expect.stringContaining(name),
  });
  expect(await store.readSecretStoreValue(entry)).toEqual({ ok: true, value: entry.value });
  expect(await store.listSecretStoreEntries({ scope, database })).toEqual(before);
});

it("restores a repaired marker and refuses to overwrite a concurrent replacement", async () => {
  const { entry, write } = await fixture(true);
  const replacement = { ...entry, value: "repaired-token", expectedValue: marker };
  const repair = await store.writeSecretStoreEntryWithRollback(replacement);
  expect(await repair.rollback()).toBe(true);
  expect(await store.readSecretStoreValue(entry)).toEqual({ ok: true, value: marker });
  await write({ value: "synthetic-new" });
  const staleRepair = store.writeSecretStoreEntryWithRollback({ ...entry, expectedValue: marker });
  await expect(staleRepair).rejects.toMatchObject({ code: "SECRET_STORE_VALUE_CHANGED" });
  expect(await store.readSecretStoreValue(entry)).toEqual({ ok: true, value: "synthetic-new" });
});

it("rejects a stored marker in resolution, audit, and exec while preserving healthy entries", async () => {
  const { env, database, write } = await fixture(true);
  await expect(resolveSecretRefString(ref, { config: {}, env })).rejects.toMatchObject({
    code: "SECRET_REF_REDACTED_VALUE",
    message: expect.stringContaining("openclaw doctor --fix"),
  });
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  const report = await runSecretsAudit({ env });
  const finding = {
    code: "PLACEHOLDER_VALUE",
    severity: "error",
    jsonPath: "gateway.auth.token",
    message: expect.stringContaining(name),
  };
  expect(report.findings).toContainEqual(expect.objectContaining(finding));
  expect(report.summary.unresolvedRefCount).toBe(1);
  expect(resolveSecretsAuditExitCode(report, false)).toBe(2);
  await write({ name: "SERVICE_MODE", value: "synthetic-mode", kind: "env" });
  const result = await store.readSecretStoreExecEnvironment({
    includeSecretSentinels: true,
    database,
  });
  expect(result).toEqual({ env: { SERVICE_MODE: "synthetic-mode" } });
});
