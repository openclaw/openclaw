import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { SQLITE_CAPABILITY_PROBE } from "../../node-sqlite.mjs";

function probeSqlite(Database: unknown): unknown {
  return runInNewContext(SQLITE_CAPABILITY_PROBE, {
    require: () => ({ DatabaseSync: Database }),
    Buffer,
    Error,
    Uint8Array,
  });
}

describe("SQLite NUL capability probe", () => {
  it.each(["none", "text", "trailing", "blob", "json", "throw"] as const)(
    "detects %s corruption and closes the in-memory database",
    (corruption) => {
      const close = vi.fn();
      class FakeDatabase {
        row: Record<string, unknown> = {};
        exec() {}
        prepare(sql: string) {
          return {
            run: (
              text: string | Uint8Array,
              blob: string | Uint8Array,
              json: string | Uint8Array,
            ) => {
              this.row = { text_value: text, blob_value: blob, json_value: json };
            },
            get: () => {
              if (sql.includes("sqlite_version()")) {
                return { version: "3.51.3" };
              }
              if (corruption === "throw") {
                throw new Error("read failed");
              }
              if (corruption === "text") {
                this.row.text_value = "a";
              }
              if (corruption === "trailing") {
                this.row.text_value = "a\0b";
              }
              if (corruption === "blob") {
                this.row.blob_value = new Uint8Array([97]);
              }
              if (corruption === "json") {
                this.row.json_value = '{"value":"a"}';
              }
              return this.row;
            },
          };
        }
        close = close;
      }
      expect(probeSqlite(FakeDatabase)).toEqual({
        available: true,
        version: "3.51.3",
        text: !["text", "trailing", "throw"].includes(corruption),
        blob: !["blob", "throw"].includes(corruption),
        json: !["json", "throw"].includes(corruption),
        ...(corruption === "throw" ? { error: "read failed" } : {}),
      });
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("round-trips NULs through the real loaded SQLite binding", () => {
    expect(probeSqlite(DatabaseSync)).toMatchObject({
      available: true,
      text: true,
      blob: true,
      json: true,
    });
  });

  it("executes the serialized SQLite probe in a fresh Node process", () => {
    const output = execFileSync(
      process.execPath,
      ["-e", `process.stdout.write(JSON.stringify(${SQLITE_CAPABILITY_PROBE}))`],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toMatchObject({
      available: true,
      text: true,
      blob: true,
      json: true,
    });
  });

  it("caches the current process probe", async () => {
    vi.resetModules();
    const { detectCurrentSqliteCapabilities } = await import("../../node-sqlite.mjs");
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      const first = detectCurrentSqliteCapabilities();
      const calls = prepare.mock.calls.length;
      expect(first.text).toBe(true);
      expect(detectCurrentSqliteCapabilities()).toBe(first);
      expect(prepare).toHaveBeenCalledTimes(calls);
    } finally {
      prepare.mockRestore();
    }
  });
});
