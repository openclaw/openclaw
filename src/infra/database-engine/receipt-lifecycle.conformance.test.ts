import { describe, expect, it, vi } from "vitest";
import { resolveSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import { prepareFreshSharedAuthStoreWriteAsync } from "../../agents/auth-profiles/shared-store-bootstrap-async.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { retireSqliteDatabaseAdmissionForPath } from "../sqlite-database-admission.js";
import * as receipts from "../sqlite-worker-operation-admission.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s receipt lifecycle",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("bootstraps empty shared auth after reopening an unsealed legacy source", async () => {
      const source = admit(() => openOpenClawAgentDatabase({ agentId: "main" }));
      if (engine === "postgres") {
        // An older server seal requires real schema verification on the next native open.
        admit(() =>
          source.db.exec("UPDATE openclaw_schema_meta SET server_major = 0 WHERE store = 'agent'"),
        );
      }
      admit(() => closeOpenClawAgentDatabaseByPath(source.path));
      await closeOpenClawAgentDatabaseByPathAsync(source.path);
      retireSqliteDatabaseAdmissionForPath(source.path);
      const committed: unknown[] = [];
      const observe = receipts.observeSqliteWorkerCommittedFacts;
      const observed = vi
        .spyOn(receipts, "observeSqliteWorkerCommittedFacts")
        .mockImplementation((admission, callback) =>
          observe(admission, (receipt) => {
            committed.push(receipt.facts);
            callback(receipt);
          }),
        );
      try {
        await expect(
          prepareFreshSharedAuthStoreWriteAsync({
            agentDir: undefined,
            allowExplicitMain: false,
            env: process.env,
          }),
        ).resolves.toBe(true);
        expect(resolveSharedAuthStoreOwnership(process.env)).toEqual({ location: "state-db" });
        expect(committed).toEqual([{ ownership: { location: "state-db" }, relocated: true }]);
      } finally {
        observed.mockRestore();
      }
    });
  },
);
