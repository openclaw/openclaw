import { describe, expect, it } from "vitest";
import { collectKyselyGuardrailViolations } from "../../scripts/check-kysely-guardrails.mjs";

function messagesFor(content: string, relativePath = "src/example/store.sqlite.ts"): string[] {
  return collectKyselyGuardrailViolations(content, relativePath).map(
    (violation) => violation.message,
  );
}

describe("Kysely guardrails", () => {
  it("rejects explicit sync-helper row generics for builder queries", () => {
    expect(
      messagesFor(`
        import { executeSqliteQuerySync } from "../infra/kysely-sync.js";

        executeSqliteQuerySync<{ id: string }>(db, query);
      `),
    ).toContain("sync helper row generic at call site; let Kysely infer builder result rows");
  });

  it("rejects persisted row casts to enum-like types in SQLite stores", () => {
    expect(
      messagesFor(`
        type TaskStatus = "running" | "succeeded";

        function rowToRecord(row: { status: string }) {
          return {
            status: row.status as TaskStatus,
          };
        }
      `),
    ).toContain(
      "persisted SQLite enum-like values must be parsed through closed validators, not cast",
    );
  });

  it("allows explicit local escape hatches for reviewed persisted casts", () => {
    expect(
      messagesFor(`
        type TaskStatus = "running" | "succeeded";

        function rowToRecord(row: { status: string }) {
          return {
            status: row.status as TaskStatus, // sqlite-allow-persisted-cast
          };
        }
      `),
    ).toEqual([]);
  });

  it("rejects typed raw SQL outside allowlisted boundaries", () => {
    expect(
      messagesFor(
        `
          import { sql } from "kysely";

          const count = sql<number>\`COUNT(*)\`;
        `,
        "src/example/report.ts",
      ),
    ).toContain("typed raw sql snippet needs a small helper or allowlisted boundary");
  });

  it("rejects direct raw node:sqlite prepare in new production files", () => {
    expect(
      messagesFor(
        `
          import { requireNodeSqlite } from "../infra/node-sqlite.js";

          const sqlite = requireNodeSqlite();
          const db = new sqlite.DatabaseSync(":memory:");
          db.prepare("select 1").get();
        `,
        "src/example/raw-store.ts",
      ),
    ).toContain(
      "new raw node:sqlite access requires Kysely or an explicit raw SQLite allowlist entry",
    );
  });

  it("keeps ordinary static Kysely reference strings valid", () => {
    expect(
      messagesFor(`
        import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";

        const query = getNodeSqliteKysely<{ task_runs: { task_id: string } }>(db)
          .selectFrom("task_runs")
          .select(["task_id"])
          .where("task_id", "=", taskId);
        executeSqliteQuerySync(db, query);
      `),
    ).toEqual([]);
  });
});
