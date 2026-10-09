import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  isArtifactPreservingStateRead,
  withArtifactPreservingStateReads,
} from "../state/artifact-preserving-state-reads.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
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

it.each(["prepared", "outside", "symlink", "sidecar-symlink", "incomplete"])(
  "reuses only prepared rehearsal bytes across checks (%s)",
  async (kind) => {
    const root = fs.realpathSync(dirs.make("sqlite-rehearsal-read-"));
    const outside = fs.realpathSync(dirs.make("sqlite-rehearsal-outside-"));
    const file = path.join(
      kind === "outside" || kind === "symlink" ? outside : root,
      "agent.sqlite",
    );
    const writer = openNodeSqliteDatabase(file);
    writer.exec("CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (1)");
    writer.close();
    const source = kind === "symlink" ? path.join(root, "linked.sqlite") : file;
    if (kind === "symlink") {
      fs.symlinkSync(file, source);
    }
    if (kind === "sidecar-symlink") {
      const sidecar = path.join(outside, "source-shm");
      fs.writeFileSync(sidecar, "");
      fs.symlinkSync(sidecar, `${source}-shm`);
    }
    const env = {
      ...rehearsalEnv(root),
      ...(kind === "incomplete" ? { OPENCLAW_SKIP_CHANNELS: undefined } : {}),
    };
    await withEnvAsync(env, async () => {
      for (const value of [1, 2]) {
        let reader: ReturnType<typeof openSqliteReadOnlyDatabase> | undefined;
        withArtifactPreservingStateReads(
          () => {
            reader = openSqliteReadOnlyDatabase(source, { readOnly: false });
            expect(reader.prepare("SELECT value FROM probe").get()).toEqual({ value });
            expect(reader.location() === source).toBe(kind === "prepared");
            expect(isArtifactPreservingStateRead("agent", source)).toBe(true);
            expect(() => reader!.exec("UPDATE probe SET value = 99")).toThrow(/readonly/);
          },
          { agentDatabases: true },
        );
        expect(reader?.isOpen).toBe(false);
        const candidate = openNodeSqliteDatabase(file);
        candidate.exec("UPDATE probe SET value = 2");
        candidate.close();
      }
    });
  },
);

it("reuses prepared shared state without granting inspection write authority", async () => {
  const root = fs.realpathSync(dirs.make("sqlite-rehearsal-shared-"));
  const env = rehearsalEnv(root);
  const options = { env, path: path.join(root, "state", "openclaw.sqlite") };
  const database = openOpenClawStateDatabase(options);
  database.db.exec("CREATE TABLE probe(value INTEGER); INSERT INTO probe VALUES (1)");
  await closeOpenClawStateDatabaseAsync();
  await withEnvAsync(env, async () => {
    for (const value of [1, 2]) {
      withArtifactPreservingStateReads(
        () => {
          withOpenClawStateDatabaseReadOnly(({ db }) => {
            expect(db.location()).toBe(options.path);
            expect(db.prepare("SELECT value FROM probe").get()).toEqual({ value });
          }, options);
          expect(() => runOpenClawStateWriteTransaction(() => {}, options)).toThrow(
            "shared-state write during artifact-preserving inspection",
          );
        },
        { agentDatabases: true },
      );
      const candidate = openNodeSqliteDatabase(options.path);
      candidate.exec("UPDATE probe SET value = 2");
      candidate.close();
    }
  });
});
