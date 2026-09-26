import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import type { SessionsListResult } from "./session-utils.types.js";

it("searches cold archives with worker-prepared facts across publications and lifecycle replacement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    setCurrentPluginMetadataSnapshot(createPluginMetadataSnapshotFixture(), {
      config: cfg,
      compatibleConfigs: [cfg],
    });
    const key = "agent:main:acp:archived";
    const target = { agentId: "main", sessionKey: key };
    const entry = {
      sessionId: "archived",
      updatedAt: 1,
      archivedAt: 1,
      lifecycleRevision: "first",
    };
    replaceSessionEntrySync(target, entry);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:other" },
      {
        sessionId: "other",
        updatedAt: 2,
        archivedAt: 1,
      },
    );
    const publishAcp = (backend: string) =>
      writeAcpSessionMetaForMigration({
        sessionKey: key,
        lifecycleRevision: "first",
        meta: {
          backend,
          agent: "main",
          runtimeSessionName: "archived",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 1,
        },
      });
    publishAcp("fixture-runtime-first");
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const list = async (search: string, hasBoard?: boolean) => {
      const reads = observeSqliteReadSql(StatementSync.prototype);
      let result: SessionsListResult | undefined;
      try {
        await sessionReadHandlers["sessions.list"]!({
          req: { type: "req", id: "cold-search", method: "sessions.list" },
          params: { archived: "all", search, hasBoard },
          client: null,
          context,
          isWebchatConnect: () => false,
          respond(ok, value) {
            expect(ok).toBe(true);
            result = value as SessionsListResult;
          },
        });
        expect(result).toBeDefined();
        expect(
          reads.queries.filter((sql) =>
            /acp_sessions|config_machine_state|board_tabs|session_participants/.test(sql),
          ),
          search,
        ).toEqual([]);
        return result!;
      } finally {
        reads.restore();
      }
    };
    try {
      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(0);
      expect((await list("unmatched-search-needle")).sessions).toEqual([]);
      expect(projection.materializedCount).toBe(0);
      const original = await list("fixture-runtime-first");
      expect(original.sessions).toEqual([
        expect.objectContaining({
          key,
          sessionId: "archived",
          archivedAt: 1,
          agentRuntime: expect.objectContaining({ id: "fixture-runtime-first" }),
          runtimeSelectionLocked: true,
        }),
      ]);
      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      const repeated = await list("fixture-runtime-first");
      expect(repeated).toEqual(original);
      sessionChanges.emit({ all: true, scope: "config" });
      await projection.ensureMaterialized();
      publishAcp("fixture-runtime-next");
      expect((await list("fixture-runtime-first")).sessions).toEqual([]);
      expect((await list("fixture-runtime-next")).sessions.map((row) => row.key)).toEqual([key]);
      const board = new SqliteBoardStore({
        resolveSession: ({ sessionKey }) => ({ agentId: "main", sessionKey }),
      });
      await board.putWidget({
        sessionKey: key,
        name: "status",
        content: { kind: "html", html: "<p>Ready</p>" },
      });
      expect((await list("fixture-runtime-next", true)).sessions.map((row) => row.key)).toEqual([
        key,
      ]);
      expect((await list("fixture-runtime-next", false)).sessions).toEqual([]);
      replaceSessionEntrySync(target, { ...entry, lifecycleRevision: "replacement", updatedAt: 2 });
      expect((await list("fixture-runtime-next")).sessions).toEqual([]);
    } finally {
      clock.mockRestore();
      projection.dispose();
      release();
      setCurrentPluginMetadataSnapshot(undefined);
    }
  });
});
