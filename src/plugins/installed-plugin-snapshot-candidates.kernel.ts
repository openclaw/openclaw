import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  compileSqliteQueryBindings,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { PluginSnapshotCandidateOperation } from "./installed-plugin-snapshot-candidates.types.js";
import {
  PluginSourceSnapshotDescriptorSchema,
  type PluginSourceSnapshotDescriptor,
} from "./plugin-source-snapshot.types.js";

const KEY = "plugins.installedSourceSnapshotCandidates";
const schema = z
  .object({ version: z.literal(1), candidates: z.array(PluginSourceSnapshotDescriptorSchema) })
  .strict();
type Operation =
  PluginSnapshotCandidateOperation["plugins.metadata.index.snapshotCandidates"]["input"];

function read(database: EngineConnection): PluginSourceSnapshotDescriptor[] {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<Pick<DB, "config_machine_state">>(database)
      .selectFrom("config_machine_state")
      .select("value_json")
      .where("state_key", "=", KEY),
  );
  return row ? schema.parse(JSON.parse(row.value_json)).candidates : [];
}

function write(database: EngineConnection, candidates: PluginSourceSnapshotDescriptor[]) {
  const { compiled, bind } = compileSqliteQueryBindings<void>(() =>
    getNodeSqliteKysely<Pick<DB, "config_machine_state">>(database)
      .insertInto("config_machine_state")
      .values({
        state_key: KEY,
        value_json: JSON.stringify({ version: 1, candidates }),
        updated_at_ms: Date.now(),
      })
      .onConflict((conflict) =>
        conflict.column("state_key").doUpdateSet((eb) => ({
          value_json: eb.ref("excluded.value_json"),
          updated_at_ms: eb.ref("excluded.updated_at_ms"),
        })),
      ),
  );
  // sqlite-allow-raw: The lifecycle lease and caller's transaction own journal publication.
  database.prepare(compiled.sql).run(...bind());
}

function same(left: PluginSourceSnapshotDescriptor, right: PluginSourceSnapshotDescriptor) {
  return isDeepStrictEqual({ ...left, installedRevision: 0 }, { ...right, installedRevision: 0 });
}

export function mutatePluginSnapshotCandidatesInDatabase(
  database: EngineConnection,
  input: Operation,
) {
  let candidates = read(database);
  if (input.operation === "read") {
    return candidates;
  }
  const changes = input.candidates.map((entry) =>
    PluginSourceSnapshotDescriptorSchema.parse(entry),
  );
  if (input.operation === "retain") {
    for (const entry of changes) {
      const existing = candidates.find(
        (candidate) => candidate.artifact.path === entry.artifact.path,
      );
      if (existing && !same(existing, entry)) {
        throw new Error("Snapshot candidate ownership changed");
      }
      if (!existing) {
        candidates.push(entry);
      }
    }
  } else {
    candidates = candidates.filter((entry) => !changes.some((removed) => same(entry, removed)));
  }
  write(database, candidates);
  return candidates;
}

/** Called inside the index commit: completed publication transfers journal custody atomically. */
export function forgetPublishedPluginSnapshotCandidates(
  database: EngineConnection,
  snapshots: readonly unknown[],
) {
  const live = snapshots.flatMap((value) => {
    const parsed = PluginSourceSnapshotDescriptorSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  if (!live.length) {
    return;
  }
  const candidates = read(database);
  const retained = candidates.filter((entry) => !live.some((snapshot) => same(entry, snapshot)));
  if (retained.length !== candidates.length) {
    write(database, retained);
  }
}
