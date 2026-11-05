import assert from "node:assert/strict";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import type { AuthProfileReadOwner } from "../../agents/auth-profiles/runtime-read.types.js";
import {
  deletePersistedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
} from "../../agents/auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
} from "../../agents/auth-profiles/store-runtime.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["shared-state", "agent"] as const)(
  "native PostgreSQL auth loading (%s)",
  (kind) => {
    const fixture = useMixedAgentPair("postgres", "postgres");

    it("retains fresh/missing/unreadable behavior through the native read owner", () => {
      const agentDir =
        kind === "agent" ? path.join(fixture.root, "agents", "native-auth", "agent") : undefined;
      const database = withEngineStoreAdmission(() =>
        agentDir
          ? openOpenClawAgentDatabase({ agentId: "native-auth" })
          : openOpenClawStateDatabase(),
      );
      expect(isPostgresSqlConnection(database.db)).toBe(true);
      const save = (key: string, lastUsed: number) =>
        withEngineStoreAdmission(() =>
          saveAuthProfileStore(
            {
              version: 1,
              profiles: { fixture: { type: "api_key", provider: "fixture", key } },
              usageStats: { fixture: { lastUsed } },
            },
            agentDir,
            { filterExternalAuthProfiles: false, syncExternalCli: false },
          ),
        );
      save("synthetic-first", 100);
      if (!agentDir) {
        expect(resolveSharedAuthStoreOwnership()).toEqual({ location: "state-db" });
      }
      let owner: AuthProfileReadOwner | undefined;
      const load = () =>
        withEngineStoreAdmission(() =>
          loadAuthProfileStoreForRuntime(agentDir, {
            readOnly: true,
            syncExternalCli: false,
            externalCli: { mode: "none" },
            config: { plugins: { enabled: false } },
            ...(agentDir ? { inheritedAuthDir: agentDir } : {}),
            onReadOwner(value) {
              owner = value;
            },
          }),
        );
      expect(load()).toMatchObject({
        profiles: { fixture: { key: "synthetic-first" } },
        usageStats: { fixture: { lastUsed: 100 } },
      });
      assert(owner);
      expect(owner.databasePath).toBe(database.path);
      const readStore = owner.readStore;
      const read = () => withEngineStoreAdmission(readStore);
      save("synthetic-second", 200);
      expect(read()).toMatchObject({
        profiles: { fixture: { key: "synthetic-second" } },
        usageStats: { fixture: { lastUsed: 200 } },
      });
      withEngineStoreAdmission(() => deletePersistedAuthProfileStoreRaw(agentDir));
      expect(read()).toBeNull();
      expect(load().profiles).toEqual({});

      save("synthetic-corrupt-fixture", 400);
      // Inject malformed persisted bytes inside the real writer's transaction.
      withEngineStoreAdmission(() =>
        runAuthProfileWriteTransaction(agentDir, ({ db }) => {
          db.prepare(
            agentDir
              ? "UPDATE auth_profile_store SET store_json = ? WHERE store_key = 'primary'"
              : "UPDATE config_machine_state SET value_json = ? WHERE state_key = 'authProfiles.store'",
          ).run("{");
        }),
      );
      expect(read).toThrow("is unreadable");
      expect(load).toThrow("is unreadable");
    });
  },
);
