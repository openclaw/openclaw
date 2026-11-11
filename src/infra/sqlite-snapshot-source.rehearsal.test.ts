import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as reads from "../state/artifact-preserving-state-reads.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import * as state from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { openSqliteReadOnlyDatabase } from "./sqlite-snapshot-source.js";
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

function exec(file: string, sql: string) {
  using database = openNodeSqliteDatabase(file);
  database.exec(sql);
}

it.each(["prepared", "outside", "symlink", "sidecar-symlink", "incomplete", "shared"])(
  "reuses only prepared rehearsal bytes across checks (%s)",
  async (kind) => {
    const root = fs.realpathSync(dirs.make("sqlite-rehearsal-read-"));
    const outside = fs.realpathSync(dirs.make("sqlite-rehearsal-outside-"));
    const env = rehearsalEnv(root);
    if (kind === "incomplete") {
      env.OPENCLAW_SKIP_CHANNELS = undefined;
    }
    const file =
      kind === "shared"
        ? path.join(root, "state", "openclaw.sqlite")
        : path.join(kind === "outside" || kind === "symlink" ? outside : root, "agent.sqlite");
    const options = { env, path: file };
    const seed = "CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (1)";
    if (kind === "shared") {
      state.openOpenClawStateDatabase(options).db.exec(seed);
      await closeOpenClawStateDatabaseAsync();
    } else {
      exec(file, seed);
    }
    const source = kind === "symlink" ? path.join(root, "linked.sqlite") : file;
    if (kind === "symlink") {
      fs.symlinkSync(file, source);
    }
    if (kind === "sidecar-symlink") {
      const sidecar = path.join(outside, "source-shm");
      fs.writeFileSync(sidecar, "");
      fs.symlinkSync(sidecar, `${source}-shm`);
    }
    await withEnvAsync(env, async () => {
      for (const value of [1, 2]) {
        let reader: ReturnType<typeof openSqliteReadOnlyDatabase> | undefined;
        reads.withArtifactPreservingStateReads(
          () => {
            if (kind === "shared") {
              withOpenClawStateDatabaseReadOnly(({ db }) => {
                expect(requireNativeSqliteDatabase(db).location()).toBe(file);
                expect(db.prepare("SELECT value FROM probe").get()).toEqual({ value });
              }, options);
              expect(() => state.runOpenClawStateWriteTransaction(() => {}, options)).toThrow(
                "shared-state write during artifact-preserving inspection",
              );
              return;
            }
            reader = openSqliteReadOnlyDatabase(source, { readOnly: false });
            expect(reader.prepare("SELECT value FROM probe").get()).toEqual({ value });
            expect(reader.location() === source).toBe(kind === "prepared");
            expect(reads.isArtifactPreservingStateRead("agent", source)).toBe(true);
            expect(() => reader!.exec("UPDATE probe SET value = 99")).toThrow(/readonly/);
          },
          { agentDatabases: true },
        );
        if (kind !== "shared") {
          expect(reader?.isOpen).toBe(false);
        }
        exec(file, "UPDATE probe SET value = 2");
      }
    });
  },
);
