import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { buildUpdateRehearsalPathEnv } from "./update-rehearsal-paths.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function rehearsalEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...buildUpdateRehearsalPathEnv(root),
    OPENCLAW_UPDATE_IN_PROGRESS: "0",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
    OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
  };
}

it("reuses prepared shared state without granting inspection write authority", async () => {
  const root = fs.realpathSync(dirs.make("sqlite-rehearsal-shared-"));
  const env = rehearsalEnv(root);
  const options = { env, path: path.join(root, "state", "openclaw.sqlite") };
  const database = openOpenClawStateDatabase(options);
  database.db.exec("CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (1)");
  await closeOpenClawStateDatabaseAsync();
  await withEnvAsync(env, async () => {
    for (const value of [1, 2]) {
      withArtifactPreservingStateReads(() => {
        withOpenClawStateDatabaseReadOnly(({ db }) => {
          expect(db.location()).toBe(options.path);
          expect(db.prepare("SELECT value FROM probe").get()).toEqual({ value });
          expect(() => db.exec("UPDATE probe SET value = 99")).toThrow(/readonly/);
        }, options);
      });
      const candidate = openNodeSqliteDatabase(options.path);
      candidate.exec("UPDATE probe SET value = 2");
      candidate.close();
    }
  });
});
