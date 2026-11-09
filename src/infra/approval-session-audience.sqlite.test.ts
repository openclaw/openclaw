import { expect, it } from "vitest";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import { createSubagentStoreRunFixture } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  bindSessionNode,
  bindSessionRoot,
} from "../config/sessions/session-accessor.sqlite-session-row.js";
import { validateCanonicalSessionRow } from "../config/sessions/session-canonical-row.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { resolveApprovalSessionAudienceWithFallback } from "../gateway/approval-session-audience.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import { createCurrentOpenClawAgentDatabaseFixtures } from "../state/openclaw-agent-db.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

it.each(["custom", "default"] as const)(
  "reads %s-store ancestors and gives committed registry parents precedence",
  async (mode) => {
    await withOpenClawTestState(
      {
        scenario: "minimal",
        prepareProfileCatalog: false,
        env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" },
      },
      async (state) => {
        const agentId = "work";
        const store =
          mode === "custom" ? state.statePath("approval-{agentId}", "sessions.json") : undefined;
        const storePath = resolveSessionStorePathCore(store, { agentId, env: state.env });
        const databasePath = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath).path;
        const child = "agent:work:child";
        const storedParent = "agent:work:metadata-parent";
        const controller = "agent:work:registry-controller";
        const requester = "agent:work:registry-requester";
        const runId = "approval-audience-registry-conflict-" + mode;
        let registered = false;
        setRuntimeConfigSnapshot({ session: { store } });
        try {
          // Closed current-schema fixture input; the real reader must admit it itself.
          const targets = [{ path: databasePath, parent: storedParent }];
          if (mode === "custom") {
            const defaultStore = resolveSessionStorePathCore(undefined, {
              agentId,
              env: state.env,
            });
            targets.push({
              path: resolveUnsuffixedSqliteTargetFromSessionStorePath(defaultStore).path,
              parent: "agent:work:foreign-default-parent",
            });
          }
          createCurrentOpenClawAgentDatabaseFixtures(
            state.path("template.sqlite"),
            targets.map(({ path }) => ({ agentId, path })),
          );
          for (const { path, parent } of targets) {
            using database = openNodeSqliteDatabase(path);
            runSqliteImmediateTransactionSync(database, () => {
              const query = getNodeSqliteKysely<DB>(database);
              for (const [sessionKey, entry] of [
                [child, { sessionId: "audience-child", updatedAt: 1, parentSessionKey: parent }],
                [parent, { sessionId: "audience-stored-parent", updatedAt: 1 }],
                [controller, { sessionId: "audience-controller", updatedAt: 1 }],
                [requester, { sessionId: "audience-requester", updatedAt: 1 }],
              ] as const) {
                const node = bindSessionNode({
                  entry,
                  sessionKey,
                  entryJson: JSON.stringify(entry),
                  updatedAt: 1,
                });
                validateCanonicalSessionRow({ ...node, retained_window_id: null });
                // These synthetic entries have no extended-range predicate timestamp.
                const sessionStartedAt = node.session_started_at;
                if (typeof sessionStartedAt === "bigint") {
                  throw new Error("Synthetic lineage fixture requires a safe numeric timestamp");
                }
                executeSqliteQuerySync(
                  database,
                  query.insertInto("session_nodes").values({
                    ...node,
                    session_started_at: sessionStartedAt,
                  }),
                );
                executeSqliteQuerySync(
                  database,
                  query
                    .insertInto("session_windows")
                    .values(bindSessionRoot({ entry, sessionKey, updatedAt: 1 })),
                );
              }
            });
          }
          const readChild = () =>
            readSessionEntryReadOnlyInWorker({
              agentId,
              sessionKey: child,
              storePath,
              env: state.env,
              hydrateSkillPromptRefs: false,
            });
          expect((await readChild())?.parentSessionKey).toBe(storedParent);
          expect(await resolveApprovalSessionAudienceWithFallback(child, "main")).toEqual([
            child,
            storedParent,
          ]);

          const run = createSubagentStoreRunFixture({
            runId,
            childSessionKey: child,
            childAgentId: agentId,
            controllerSessionKey: controller,
            controllerStorePath: storePath,
            requesterSessionKey: requester,
            requesterAgentId: agentId,
            requesterStorePath: storePath,
          });
          // Normal isolated shared-state bootstrap retains its credential-directory admission.
          openOpenClawStateDatabase({ env: state.env });
          // The supported registry mutation commits and publishes its own real receipt.
          await mutateSubagentRuns([runId], () => ({
            value: undefined,
            postimages: new Map([[runId, run]]),
          }));
          registered = true;
          expect((await readChild())?.parentSessionKey).toBe(storedParent);
          expect(await resolveApprovalSessionAudienceWithFallback(child, "main")).toEqual([
            child,
            controller,
            requester,
          ]);
        } finally {
          if (registered) {
            await mutateSubagentRuns([runId], () => ({
              value: undefined,
              postimages: new Map([[runId, null]]),
            }));
          }
          clearRuntimeConfigSnapshot();
        }
      },
    );
  },
);
