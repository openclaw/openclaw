import { randomUUID } from "node:crypto";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { expect, it } from "vitest";
import { boardFixture, htmlWidget } from "../../boards/board-store.fixtures.test-support.js";
import { closeBoardDatabases } from "../../boards/board-store.test-support.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { assertEngineStoreExecutionAllowed, withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

it.skipIf(!connection)(
  "publishes and updates HTML and native reports through the PG worker without host SQL",
  async () => {
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    let namespace: string | undefined;
    try {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        installDatabaseEngineSelection({
          effectiveEngines: resolveDatabaseFamilyEngines({
            database: { families: { agent: { engine: "postgres" } } },
          }),
          postgres: {
            connection: connection!,
            schemaPrefix: `board_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          },
        });
        try {
          // Fixture creation alone has explicit synchronous admission; tested writes do not.
          const seeded = withEngineStoreAdmission(() => {
            const value = boardFixture(state.stateDir, "agent:main:ci-duration");
            namespace = getPostgresPhysicalFacts(value.database.db)!.namespace;
            return value;
          });
          await closeOpenClawAgentDatabasesAsync();
          expect(() => assertEngineStoreExecutionAllowed()).toThrow(
            "PostgreSQL connections must run in a worker",
          );
          const store = new SqliteBoardStore(seeded.storeOptions);
          expect((await store.getSnapshot(seeded.target)).revision).toBe(0);
          const created = await store.putWidget(
            htmlWidget(seeded.sessionKey, "duration", "<p>initial</p>"),
          );
          const updated = await store.putWidget(
            htmlWidget(seeded.sessionKey, "duration", "<p>updated</p>"),
          );
          expect(updated.revision).toBe(created.revision + 1);
          expect(updated.widgets.map((widget) => widget.name)).toEqual(["duration"]);
          expect(
            await store.useWidgetDocument(seeded.target, "duration", (document) => document),
          ).toMatchObject({ html: "<p>updated</p>" });
          const report = { blocks: [{ type: "text", text: "Native report persisted" }] };
          const published = await store.putWidget({
            ...seeded.target,
            name: "report",
            content: { kind: "plugin", pluginKind: "session:report", props: report },
          });
          expect(published.revision).toBe(updated.revision + 1);
          expect(published.widgets).toContainEqual(
            expect.objectContaining({
              name: "report",
              pluginKind: "session:report",
              props: report,
            }),
          );
          await closeOpenClawAgentDatabasesAsync();
          expect(
            await new SqliteBoardStore(seeded.storeOptions).getSnapshot(seeded.target),
          ).toMatchObject({ revision: published.revision, widgets: published.widgets });
          expect(() => assertEngineStoreExecutionAllowed()).toThrow(
            "PostgreSQL connections must run in a worker",
          );
        } finally {
          await closeBoardDatabases();
          resetDatabaseEngineSelectionForTest();
        }
      });
    } finally {
      if (namespace) {
        await client.query(`DROP SCHEMA "${namespace.replaceAll('"', '""')}" CASCADE`);
      }
      await client.end();
    }
  },
);
