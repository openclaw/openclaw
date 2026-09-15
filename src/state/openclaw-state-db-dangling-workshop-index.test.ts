import { constants, DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { hasDanglingSkillWorkshopCollectionReviewIndex } from "./openclaw-state-db-dangling-workshop-index.js";

it("keeps prepared reads reusable when the legacy Workshop index is absent", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "CREATE TABLE prepared_read (value INTEGER); INSERT INTO prepared_read VALUES (42)",
    );
    let readPreparations = 0;
    database.setAuthorizer((action, table) => {
      if (action === constants.SQLITE_READ && table === "prepared_read") {
        readPreparations++;
      }
      return constants.SQLITE_OK;
    });
    const read = database.prepare("SELECT value FROM prepared_read");
    expect(read.get()).toEqual({ value: 42 });
    expect(readPreparations).toBe(1);

    for (let iteration = 0; iteration < 3; iteration++) {
      expect(hasDanglingSkillWorkshopCollectionReviewIndex(database)).toBe(false);
      expect(read.get()).toEqual({ value: 42 });
    }

    expect(readPreparations).toBe(1);
  } finally {
    database.close();
  }
});
