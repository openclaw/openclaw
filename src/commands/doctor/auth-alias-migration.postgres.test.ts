import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApiKeyCredential as apiKey } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { inspectAuthProfileJsonCell } from "../../agents/auth-profiles/sqlite-json.js";
import {
  readPersistedAuthProfileStoreRaw,
  readPersistedSharedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission,
} from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as databaseBackup from "../../snapshot/database-backup.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeRepairLegacyAuthProfileStores,
} from "../doctor-auth-flat-profiles.js";

installDatabaseProcessRole("cli-oneshot");

describe.skipIf(!mixedAgentConnection).each(["shared-state", "agent"] as const)(
  "Doctor PostgreSQL auth alias migration (%s)",
  (kind) => {
    const fixture = useMixedAgentPair(
      kind === "shared-state" ? "postgres" : "sqlite",
      kind === "agent" ? "postgres" : "sqlite",
    );

    function seedLegacyAlias() {
      const agentDir =
        kind === "agent" ? path.join(fixture.root, "agents", "worker", "agent") : undefined;
      const database = withEngineStoreAdmission(() =>
        agentDir ? openOpenClawAgentDatabase({ agentId: "worker" }) : openOpenClawStateDatabase(),
      );
      const cfg: OpenClawConfig = {
        ...loadConfig(),
        plugins: { enabled: false },
        auth: {
          profiles: { "claude-cli:work": { provider: "claude-cli", mode: "api_key" } },
          order: { "claude-cli": ["claude-cli:work"] },
        },
      };
      const original: AuthProfileStore = {
        version: 1,
        profiles: { "claude-cli:work": apiKey("claude-cli", "synthetic-work-key") },
        order: { "claude-cli": ["claude-cli:work"] },
      };
      const write = (store: AuthProfileStore) =>
        withEngineStoreAdmission(() =>
          runAuthProfileWriteTransaction(agentDir, (owner) =>
            writePersistedAuthProfileStoreRaw(store, agentDir, owner),
          ),
        );
      write(original);
      const read = () =>
        withEngineStoreAdmission(() =>
          agentDir
            ? readPersistedAuthProfileStoreRaw(agentDir)
            : readPersistedSharedAuthProfileStoreRaw(process.env),
        );
      const repair = () =>
        maybeRepairLegacyAuthProfileStores({
          cfg,
          env: process.env,
          profileIdMap: collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: process.env }),
        });
      return { database, original, read, repair, write };
    }

    it("migrates the alias only after saving a verified backup containing the original credentials", async () => {
      const { database, original, read, repair } = seedLegacyAlias();

      const result = await repair();

      expect(result.warnings).toEqual([]);
      expect(read()).toEqual({
        version: 1,
        profiles: { "anthropic:work": apiKey("anthropic", "synthetic-work-key") },
        order: { anthropic: ["anthropic:work"] },
      });
      const backups = fs
        .readdirSync(path.dirname(database.path))
        .filter((name) =>
          name.startsWith(`${path.basename(database.path)}.auth-profile-migration-`),
        );
      expect(backups).toHaveLength(1);
      const backupPath = path.join(path.dirname(database.path), backups[0]!);
      expect(result.changes).toContain(`Saved auth profile migration backup: ${backupPath}.`);
      await databaseBackup.verifyMatchedPostgresBackup(backupPath, "exact");
      using captured = openNodeSqliteDatabase(path.join(backupPath, "database.sqlite"), {
        readOnly: true,
      });
      expect(inspectAuthProfileJsonCell(captured, "store", kind)).toEqual({
        status: "readable",
        raw: original,
      });
    });

    it("preserves changed credentials when the captured rows differ from the migration plan", async () => {
      const { original, read, repair, write } = seedLegacyAlias();
      const changed: AuthProfileStore = {
        ...original,
        profiles: { "claude-cli:work": apiKey("claude-cli", "synthetic-rotated-key") },
      };
      const capture = databaseBackup.createVerifiedDatabaseMigrationBackup;
      const replacement = vi
        .spyOn(databaseBackup, "createVerifiedDatabaseMigrationBackup")
        .mockImplementationOnce(async (params) => {
          write(changed);
          return capture(params);
        });
      try {
        await expect(repair()).rejects.toThrow(
          "Auth profile backup differs from the planned source; retry Doctor.",
        );
        expect(read()).toEqual(changed);
      } finally {
        replacement.mockRestore();
      }
    });
  },
);
