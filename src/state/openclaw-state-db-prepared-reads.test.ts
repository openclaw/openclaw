import { constants } from "node:sqlite";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { assertOpenClawStateWriteAllowed } from "./openclaw-state-ownership.js";

it("keeps prepared queries reusable across ordinary reads and ownership checks", async () => {
  await withOpenClawTestState({ label: "state-prepared-reads" }, async ({ env }) => {
    const { db, path } = openOpenClawStateDatabase({ env });
    db.exec("CREATE TABLE prepared_read (value INTEGER); INSERT INTO prepared_read VALUES (42)");
    let readPreparations = 0;
    db.setAuthorizer((action, table) => {
      if (action === constants.SQLITE_READ && table === "prepared_read") {
        readPreparations++;
      }
      return constants.SQLITE_OK;
    });
    const read = db.prepare("SELECT value FROM prepared_read");
    expect(read.get()).toEqual({ value: 42 });
    expect(readPreparations).toBe(1);

    for (let iteration = 0; iteration < 3; iteration++) {
      expect(withExistingOpenClawStateDatabaseReadOnly(() => read.get(), { env })).toEqual({
        value: 42,
      });
      assertOpenClawStateWriteAllowed({ database: db, databasePath: path, env });
      expect(read.get()).toEqual({ value: 42 });
    }

    expect(readPreparations).toBe(1);
  });
});
