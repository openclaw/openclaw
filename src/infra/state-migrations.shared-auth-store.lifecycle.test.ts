import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as bootstrap from "../agents/auth-profiles/shared-store-bootstrap.js";
import {
  loadPersistedAuthProfileStoreFromRows,
  prepareAgentAuthProfileRowsRead,
  readSharedAuthProfileRows,
} from "../agents/auth-profiles/sqlite-read.js";
import {
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { captureAuthProfileCredentialAuthority } from "../state/user-model-account-authority.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { migrateSharedAuthStore } from "./state-migrations.shared-auth-store.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let unregisterAfterClose: (() => void) | undefined;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-shared-auth-" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  unregisterAfterClose?.();
  unregisterAfterClose = undefined;
  await state.cleanup();
});

const migrate = (sourcePath: string, integrityCheck?: "full") =>
  migrateSharedAuthStore({
    detected: { sourcePath, hasLegacy: true },
    stateDir: state.stateDir,
    env: state.env,
    integrityCheck,
  });

const credential = { type: "api_key" as const, provider: "openai", key: "relocated-key" };
const store = { version: 1, profiles: { "openai:default": credential } };
const rotation = { version: 1, order: { openai: ["openai:default"] } };
function registerSourceClose(sourcePath: string, close: () => Promise<void>) {
  unregisterAfterClose = registerOpenClawAgentDatabaseAsyncResource({
    agentId: "main",
    path: sourcePath,
    revoke: () => {},
    close,
  });
}

it.each([undefined, "full"] as const)(
  "uses requested integrity coverage for shared credential relocation (%s)",
  async (integrityCheck) => {
    const sourcePath = resolveAuthProfileDatabasePath(state.agentDir());
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    {
      using database = new DatabaseSync(sourcePath);
      database.exec(`${OPENCLAW_AGENT_SCHEMA_SQL};
        PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
        INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
        VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', 1, 1);
      `);
      database
        .prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)")
        .run(JSON.stringify(store));
      database
        .prepare("INSERT INTO auth_profile_state VALUES ('primary', ?, 1)")
        .run(JSON.stringify(rotation));
      // An unrelated index defect distinguishes QUICK from whole-database FULL.
      database.enableDefensive?.(false);
      database.exec(`
          DROP INDEX idx_agent_cache_updated;
          CREATE INDEX idx_agent_cache_updated ON cache_entries(scope, key, updated_at);
          INSERT INTO cache_entries (scope, key, value_json, updated_at)
          VALUES ('retained', 'history', '"untouched"', 1);
          PRAGMA writable_schema = ON;
          UPDATE sqlite_schema SET sql =
            'CREATE INDEX idx_agent_cache_updated ON cache_entries(scope, updated_at DESC, key)'
            WHERE name = 'idx_agent_cache_updated';
          PRAGMA writable_schema = OFF;
        `);
    }

    const sourceChecks = new Map<DatabaseSync, string[]>();
    // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted native database receiver.
    const prepare = DatabaseSync.prototype.prepare;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      const statement = prepare.call(this, sql);
      if (this.location() !== sourcePath || !/^PRAGMA (?:quick|integrity)_check\b/u.test(sql)) {
        return statement;
      }
      const all = statement.all.bind(statement);
      statement.all = () => {
        const checks = sourceChecks.get(this) ?? [];
        checks.push(sql);
        sourceChecks.set(this, checks);
        return all();
      };
      return statement;
    });

    const result = await migrate(sourcePath, integrityCheck);
    if (integrityCheck === "full") {
      expect([...sourceChecks.values()]).toEqual([["PRAGMA integrity_check;"]]);
      expect(result).toMatchObject({
        changes: [],
        warnings: [expect.stringMatching(/integrity_check.*idx_agent_cache_updated/su)],
      });
    } else {
      expect([...sourceChecks.values()]).toEqual([
        ["PRAGMA quick_check;"],
        [
          "PRAGMA quick_check;",
          "PRAGMA integrity_check('auth_profile_store');",
          "PRAGMA integrity_check('auth_profile_state');",
        ],
      ]);
      expect(result.warnings).toEqual([]);
      expect(
        await readSharedAuthProfileRows(captureOpenClawStateWorkerContext({ env: state.env })),
      ).toMatchObject({
        store: { status: "readable", raw: store },
        state: { status: "readable", raw: rotation },
      });
    }
    {
      using source = new DatabaseSync(sourcePath, { readOnly: true });
      expect(source.prepare("SELECT store_json FROM auth_profile_store").all()).toEqual(
        integrityCheck === "full" ? [{ store_json: JSON.stringify(store) }] : [],
      );
      expect(source.prepare("SELECT state_json FROM auth_profile_state").all()).toEqual(
        integrityCheck === "full" ? [{ state_json: JSON.stringify(rotation) }] : [],
      );
      expect(source.prepare("SELECT value_json FROM cache_entries").get()?.value_json).toBe(
        '"untouched"',
      );
    }
    if (integrityCheck !== "full") {
      // Successful QUICK relocation must not admit a later FULL runtime open.
      expect(() =>
        openOpenClawAgentDatabase({ agentId: "main", path: sourcePath, env: state.env }),
      ).toThrow(/integrity_check.*idx_agent_cache_updated/su);
    }
  },
);

it("joins pre-existing source resources before returning a migration read failure", async () => {
  writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, state.agentDir());
  const sourcePath = resolveAuthProfileDatabasePath(state.agentDir());
  let drained = false;
  registerSourceClose(sourcePath, async () => {
    await setImmediate();
    drained = true;
  });
  vi.spyOn(bootstrap, "readSharedAuthLegacyRowsFromDatabase").mockImplementationOnce(() => {
    throw new Error("source read failed");
  });

  const result = await migrate(sourcePath);

  expect(result.warnings).toEqual([expect.stringContaining("source read failed")]);
  expect(drained).toBe(true);
});

it("revokes the source credential authority before relocation and cold-loads the shared credential", async () => {
  writePersistedAuthProfileStoreRaw(store, state.agentDir());
  const sourcePath = resolveAuthProfileDatabasePath(state.agentDir());
  const reader = prepareAgentAuthProfileRowsRead({
    databasePath: sourcePath,
    agentId: "main",
    env: state.env,
  });
  const authority = reader.captureCredentialAuthority("openai:default")!;
  authority.observe(credential);
  await reader.dispose();
  let deniedBeforeSourceRelease = false;
  registerSourceClose(sourcePath, async () => {
    expect(() => authority.readCurrentCredential()).toThrow();
    deniedBeforeSourceRelease = true;
  });
  const result = await migrate(sourcePath);
  expect(result.warnings).toEqual([]);
  expect(deniedBeforeSourceRelease).toBe(true);
  expect(() => authority.readCurrentCredential()).toThrow();
  const context = captureOpenClawStateWorkerContext({ env: state.env });
  const identity = `${context.admission.identity.key}:${context.admission.identity.birthtime ?? ""}`;
  const current = captureAuthProfileCredentialAuthority(
    context,
    { identity, databasePath: context.admission.databasePath },
    "openai:default",
  );
  const rows = await readSharedAuthProfileRows(context);
  current.observe(
    loadPersistedAuthProfileStoreFromRows(rows, context.admission.databasePath)?.profiles[
      "openai:default"
    ],
  );
  expect(current.readCurrentCredential()).toEqual(credential);
});
