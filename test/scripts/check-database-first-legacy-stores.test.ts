// Database-first legacy-store guard tests cover runtime state-file regressions.
import { describe, expect, it } from "vitest";
import { collectDatabaseFirstLegacyStoreViolations } from "../../scripts/check-database-first-legacy-stores.mjs";

describe("check-database-first-legacy-stores", () => {
  it("flags runtime writes to legacy sessions.json stores", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        export async function save(dir: string) {
          await fs.writeFile(path.join(dir, "sessions.json"), "{}\\n", "utf8");
        }
      `,
      "src/runtime/session-writer.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags writes through local variables initialized from legacy store paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        export async function save(dir: string) {
          const storePath = path.join(dir, "sessions.json");
          await fs.writeFile(storePath, "{}\\n", "utf8");
        }
      `,
      "src/runtime/session-writer.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags legacy paths split across path.join segments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        await fs.writeFile(path.join(stateDir, "cron", "jobs.json"), "{}\\n", "utf8");
        const sidecarPath = path.join(root, "plugin-state", "state.sqlite");
        await fs.writeFile(sidecarPath, "");
      `,
      "src/runtime/legacy-state.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 6 },
    ]);
  });

  it("flags legacy paths assembled from filename constants", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        import path from "node:path";
        const STORE_FILE = "sessions.json";
        const storePath = path.join(dir, STORE_FILE);
        await fs.writeFile(storePath, "{}\\n", "utf8");
      `,
      "src/runtime/constant-session-store.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags imported and destructured fs write aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs, { writeFile as persist } from "node:fs/promises";
        const { appendFile: append } = fs;
        await persist("sessions.json", "{}\\n", "utf8");
        await append("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/aliased-fs.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags write aliases destructured from fs.promises", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import * as fs from "node:fs";
        const { writeFile: persist } = fs.promises;
        const fsp = fs.promises;
        const { appendFile } = fsp;
        await persist("sessions.json", "{}\\n", "utf8");
        await appendFile("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/fs-promises-aliases.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 6 },
      { kind: "legacy store filesystem write", line: 7 },
    ]);
  });

  it("flags legacy paths written through regular-file helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { appendRegularFile as appendSafe } from "openclaw/plugin-sdk/security-runtime";
        const filePath = "session.trajectory.jsonl";
        await appendSafe({ filePath, content: "{}\\n" });
      `,
      "src/runtime/regular-file-helper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags legacy paths written through JSON and atomic helpers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson, writeTextAtomic } from "../infra/json-files.js";
        import { replaceFileAtomicSync } from "../infra/replace-file.js";
        await writeJson("restart-sentinel.json", {});
        await writeTextAtomic("gateway-restart-intent.json", "{}\\n");
        replaceFileAtomicSync({ filePath: "plugin-state/state.sqlite", content: "" });
      `,
      "src/runtime/write-helper-regressions.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
      { kind: "legacy store filesystem write", line: 6 },
    ]);
  });

  it("does not leak legacy path variable names across lexical scopes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        {
          const storePath = "sessions.json";
        }
        export async function save(storePath: string) {
          await fs.writeFile(storePath, "{}\\n", "utf8");
        }
      `,
      "src/runtime/current-store-writer.ts",
    );

    expect(violations).toEqual([]);
  });

  it("lets inner bindings shadow outer legacy path variables", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const storePath = "sessions.json";
        {
          const storePath = currentSqlitePath;
          await fs.writeFile(storePath, "{}\\n", "utf8");
        }
      `,
      "src/runtime/current-store-writer.ts",
    );

    expect(violations).toEqual([]);
  });

  it("ignores legacy filenames in write payloads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        await fs.writeFile(reportPath, "sessions.json\\n", "utf8");
        await fs.appendFile(currentLogPath, "cron/runs/job.jsonl\\n", "utf8");
      `,
      "src/runtime/report-writer.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags runtime writes to sidecar SQLite and JSONL stores", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs";
        fs.appendFileSync("cron/runs/job.jsonl", "{}\\n");
        fs.writeFileSync("plugin-state/state.sqlite", "");
      `,
      "extensions/example/src/store.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 3 },
      { kind: "legacy store filesystem write", line: 4 },
    ]);
  });

  it("allows doctor and migration owners to import or archive legacy files", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        await fs.rename("cron/jobs.json", "cron/jobs.json.migrated");
        await fs.writeFile("sessions.json", "{}\\n", "utf8");
      `,
      "src/commands/doctor/cron/legacy-store-migration.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows plugin doctor migration owners to archive legacy files", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const statePath = "plugin-state/state.sqlite";
        await fs.rename(statePath, "plugin-state/state.sqlite.migrated");
      `,
      "extensions/example/doctor-contract-api.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows exact QA fixture owners to materialize legacy files", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { promises as fs } from "node:fs";
        const authStorePath = "auth-profiles.json";
        await fs.writeFile(authStorePath, "{}\\n", "utf8");
      `,
      "extensions/qa-lab/src/providers/shared/auth-store.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy transcript bridge markers in runtime source", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        export const transcriptLocator = "sqlite-transcript://session";
      `,
      "src/runtime/transcript-bridge.ts",
    );

    expect(violations).toEqual([{ kind: "legacy transcript bridge marker", line: 2 }]);
  });
});
