import { afterEach, expect, it } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { prepareTrajectoryPayload, readTrajectoryPayload } from "../trajectory/runtime-payload.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import {
  cleanupMediaPersistenceFixtures,
  createLegacyDatabaseFixture,
} from "./state-migrations.media-persistence.test-support.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupMediaPersistenceFixtures(tempDirs);
});

it("repairs mixed trajectory storage and preserves the exact representation of unchanged rows", async () => {
  const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "media-trajectory-compression-") };
  const pathname = createLegacyDatabaseFixture({
    env,
    schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    eventsBySession: { session: [] },
  });
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const query = getNodeSqliteKysely<Pick<DB, "trajectory_runtime_events">>(database.db)
    .selectFrom("trajectory_runtime_events")
    .selectAll()
    .orderBy("seq");
  const legacyMessage = {
    role: "user",
    content: "retained exact content 🦞 ".repeat(256),
    MediaPath: "/media/legacy.png",
    MediaType: "image/png",
  };
  const changedJson = JSON.stringify({ data: { messagesSnapshot: [legacyMessage] } });
  const unchangedJson = JSON.stringify({
    data: {
      toolArguments: { MediaPath: "/keep-tool-argument.png" },
      value: "unchanged ".repeat(256),
    },
  });
  for (const [seq, eventJson] of [
    changedJson,
    changedJson,
    unchangedJson,
    unchangedJson,
  ].entries()) {
    const payload =
      seq % 2 === 1
        ? prepareTrajectoryPayload(database.db, eventJson)
        : { event_json: eventJson, event_payload: null, event_codec: null, event_utf8_bytes: null };
    if (seq % 2 === 1) {
      expect(payload.event_codec).not.toBeNull();
    }
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<Pick<DB, "trajectory_runtime_events">>(database.db)
        .insertInto("trajectory_runtime_events")
        .values({ session_id: "session", seq, run_id: "run", created_at: 1, ...payload }),
    );
  }
  const before = executeSqliteQuerySync(database.db, query).rows;
  closeOpenClawAgentDatabasesForTest();

  const result = await migrateLegacyMediaPersistence({ env });

  expect(result.warnings).toEqual([]);
  expect(result.changes).toContain(
    `Migrated media persistence in ${pathname}: 0 transcript session(s), 2 trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
  );
  using repaired = openNodeSqliteDatabase(pathname, { readOnly: true });
  const after = executeSqliteQuerySync(repaired, query).rows;
  expect(after.slice(2)).toEqual(before.slice(2));
  const expectedJson = JSON.stringify({
    data: {
      messagesSnapshot: [
        {
          role: legacyMessage.role,
          content: legacyMessage.content,
          __openclaw: {
            media: [{ path: legacyMessage.MediaPath, contentType: legacyMessage.MediaType }],
          },
        },
      ],
    },
  });
  expect(after.slice(0, 2).map(readTrajectoryPayload)).toEqual([expectedJson, expectedJson]);
  expect(after.slice(0, 2).map((row) => row.event_codec)).toEqual([
    expect.any(String),
    expect.any(String),
  ]);
});
