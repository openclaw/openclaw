import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";

type PreparedFixture = {
  read: { input: undefined; output: { preparation?: { key: string }; input: unknown } };
};

describe("private SQLite worker opening preparation", () => {
  it("captures preparation once without changing backend identity for ordinary reuse", async () => {
    await withTempDir("openclaw-worker-preparation-", async (root) => {
      const databasePath = path.join(root, "fixture.sqlite");
      const modulePath = path.join(root, "backend.mjs");
      await writeFile(
        modulePath,
        `import { writeFileSync } from "node:fs";
export function createSqliteWorkerBackend(input, context) {
  const preparation = context.preparation;
  writeFileSync(context.databasePath, preparation?.key ?? "ordinary");
  return { execute: () => ({ preparation, input }), close() {} };
}
`,
      );
      const broker = new SqliteWorkerBroker();
      const options = { moduleUrl: pathToFileURL(modulePath), databasePath, input: undefined };
      const preparation = { key: "captured" };
      try {
        const opening = broker.open<PreparedFixture>(options, undefined, undefined, {
          preparation,
        });
        preparation.key = "changed-after-admission";
        const first = await opening;
        assert.ok(first);
        const ordinary = await broker.open<PreparedFixture>(options);
        assert.ok(ordinary);
        const anotherPreparation = await broker.open<PreparedFixture>(
          options,
          undefined,
          undefined,
          { preparation: { key: "must-not-reinitialize" } },
        );
        assert.ok(anotherPreparation);

        expect(await readFile(databasePath, "utf8")).toBe("captured");
        for (const store of [first, ordinary, anotherPreparation]) {
          expect(await store.execute({ type: "read", input: undefined })).toEqual({
            preparation: { key: "captured" },
            input: undefined,
          });
        }
        await Promise.all([first.close(), ordinary.close(), anotherPreparation.close()]);
      } finally {
        await broker.close();
      }
    });
  });
});
