import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectKyselyGuardrailViolations } from "../../scripts/check-kysely-guardrails.mts";

const updaterPaths = [
  "src/infra/update-database-generations.ts",
  "src/infra/update-database-image.ts",
  "src/infra/update-database-restore-custody.ts",
];

describe("updater native SQLite qualifications", () => {
  it.each(updaterPaths)("qualifies only documented operations in %s", (relativePath) => {
    const source = readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
    expect(collectKyselyGuardrailViolations(source, relativePath)).toEqual([]);

    // Removing the call-site explanations restores enforcement, unlike a file allowlist.
    const unqualified = source.replaceAll(/[/][/] sqlite-allow-raw[^\n]*/gu, "");
    expect(collectKyselyGuardrailViolations(unqualified, relativePath).length).toBeGreaterThan(0);

    // Even these same owners must reject unrelated application reads and writes.
    const applicationSql = `${source}
function applicationQuery(database: DatabaseSync) {
  database.prepare("SELECT value FROM application_records").all();
  database.exec("DELETE FROM application_records");
}
`;
    expect(collectKyselyGuardrailViolations(applicationSql, relativePath)).toEqual([
      { line: expect.any(Number), message: expect.stringContaining("new raw node:sqlite access") },
      { line: expect.any(Number), message: expect.stringContaining("new raw node:sqlite access") },
    ]);
  });
});
