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

  it("flags writes through property access on legacy path variables", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const storePath = "sessions.json";
        await writeTextAtomic(storePath.toString(), "{}\\n");
      `,
      "src/runtime/legacy-path-property-access.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
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

  it("flags string-literal fs write aliases from destructuring", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const { "writeFile": persist } = fs;
        await persist("sessions.json", "{}\\n", "utf8");
      `,
      "src/runtime/string-literal-fs-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags CommonJS fs write aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const fs = require("node:fs");
        const { appendFileSync } = require("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
        appendFileSync("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/commonjs-fs-aliases.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("does not treat local require bindings as CommonJS fs", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function save(require: (specifier: string) => { writeFileSync(path: string, value: string): void }) {
          const fs = require("node:fs");
          fs.writeFileSync("sessions.json", "");
        }
        save(customRequire);
      `,
      "src/runtime/local-require-binding.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags createRequire-backed CommonJS fs writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        const require = createRequire(import.meta.url);
        const fs = require("node:fs");
        fs.writeFileSync("sessions.json", "{}\\n");
      `,
      "src/runtime/create-require-fs.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("does not treat shadowed createRequire bindings as Node require", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { createRequire } from "node:module";
        function save(createRequire: (url: string) => (specifier: string) => { writeFileSync(path: string, value: string): void }) {
          const require = createRequire("custom");
          const fs = require("node:fs");
          fs.writeFileSync("sessions.json", "");
        }
        save(customCreateRequire);
      `,
      "src/runtime/shadowed-create-require.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags CommonJS fs promises aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const { promises: fs } = require("node:fs");
        const { promises } = require("node:fs");
        await fs.writeFile("sessions.json", "{}\\n");
        await promises.appendFile("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/commonjs-fs-promises-aliases.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags nested CommonJS fs promises write aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const { promises: { writeFile } } = require("node:fs");
        await writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/nested-commonjs-fs-promises-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 3 }]);
  });

  it("flags inline CommonJS fs writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        require("node:fs").writeFileSync("sessions.json", "{}\\n");
        require("node:fs").promises.writeFile("cron/jobs.json", "{}\\n");
      `,
      "src/runtime/inline-commonjs-fs-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 2 },
      { kind: "legacy store filesystem write", line: 3 },
    ]);
  });

  it("flags bracketed fs writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs";
        await fs["writeFile"]("sessions.json", "{}\\n");
        await fs.promises["writeFile"]("cron/runs/job.jsonl", "{}\\n");
        require("node:fs")["writeFileSync"]("sessions.json", "{}\\n");
      `,
      "src/runtime/bracketed-fs-writes.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 3 },
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags dynamic fs import writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const fs = await import("node:fs/promises");
        const nodeFs = await import("node:fs");
        await fs.writeFile("sessions.json", "{}\\n");
        await nodeFs.promises.appendFile("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/dynamic-fs-import-write.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags dynamic fs import write aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const { writeFile } = await import("node:fs/promises");
        const { promises } = await import("node:fs");
        await writeFile("sessions.json", "{}\\n");
        await promises.appendFile("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/dynamic-fs-import-aliases.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 4 },
      { kind: "legacy store filesystem write", line: 5 },
    ]);
  });

  it("flags dynamic fs import promise callback writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        await import("node:fs/promises").then((fs) =>
          fs.writeFile("sessions.json", "{}\\n"),
        );
      `,
      "src/runtime/dynamic-fs-import-promise-callback.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 3 }]);
  });

  it("flags destructured dynamic fs import promise callback writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        await import("node:fs/promises").then(({ writeFile }) =>
          writeFile("sessions.json", "{}\\n"),
        );
        await import("node:fs").then(({ promises }) =>
          promises.appendFile("cron/runs/job.jsonl", "{}\\n"),
        );
        await import("node:fs").then(({ promises: { writeFile: persist } }) =>
          persist("sessions.json", "{}\\n"),
        );
      `,
      "src/runtime/destructured-dynamic-fs-import-promise-callback.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 3 },
      { kind: "legacy store filesystem write", line: 6 },
      { kind: "legacy store filesystem write", line: 9 },
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

  it("flags fs write method aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const persist = fs.writeFile;
        await persist("sessions.json", "{}\\n");
      `,
      "src/runtime/fs-write-method-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags write aliases destructured from local fs module aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        {
          const storage = fs;
          const { writeFile } = storage;
          await writeFile("sessions.json", "{}\\n");
        }
      `,
      "src/runtime/local-fs-module-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags nested write aliases destructured from local fs module aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const nodeFs = require("node:fs");
        const { promises: { writeFile } } = nodeFs;
        await writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/nested-local-fs-module-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("clears fs module aliases after reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let writer = fs;
        writer = customWriter;
        await writer.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/reassigned-fs-module-alias.ts",
    );

    expect(violations).toEqual([]);
  });

  it("uses branch-local fs module aliases after conditional assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let writer;
        if (ready) {
          writer = fs;
          await writer.writeFile("sessions.json", "{}\\n");
        }
      `,
      "src/runtime/conditional-fs-module-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("keeps fs module aliases after conditional assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let writer;
        if (ready) {
          writer = fs;
        }
        await writer.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/conditional-retained-fs-module-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("keeps fs write aliases after conditional assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let persist;
        if (ready) {
          persist = fs.writeFile;
        }
        await persist("sessions.json", "{}\\n");
      `,
      "src/runtime/conditional-retained-fs-write-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("clears fs module aliases after exhaustive conditional reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let writer = fs;
        if (ready) {
          writer = customWriter;
        } else {
          writer = otherWriter;
        }
        await writer.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/exhaustive-reassigned-fs-module-alias.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps uninitialized fs aliases assigned from nested blocks", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let writer;
        let persist;
        {
          writer = fs;
          persist = fs.writeFile;
        }
        await writer.writeFile("sessions.json", "{}\\n");
        await persist("cron/jobs.json", "{}\\n");
      `,
      "src/runtime/nested-assigned-uninitialized-fs-aliases.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 9 },
      { kind: "legacy store filesystem write", line: 10 },
    ]);
  });

  it("flags fs write aliases stored on object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const writer = { writeFile: fs.writeFile };
        await writer.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/object-fs-write-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("flags fs module handles stored on object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const deps = { fs };
        const io = { storage: fs };
        await deps.fs.writeFile("sessions.json", "{}\\n");
        await io.storage.appendFile("cron/runs/job.jsonl", "{}\\n");
      `,
      "src/runtime/object-fs-module-alias.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 5 },
      { kind: "legacy store filesystem write", line: 6 },
    ]);
  });

  it("clears fs write object aliases after object reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let writer = { writeFile: fs.writeFile };
        writer = customWriter;
        await writer.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/reassigned-object-fs-write-alias.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears fs module object aliases after object reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        let deps = { fs };
        deps = customDeps;
        await deps.fs.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/reassigned-object-fs-module-alias.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags fs write aliases assigned to object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const writer: any = {};
        writer.writeFile = fs.writeFile;
        await writer.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/assigned-object-fs-write-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags fs module handles assigned to object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const deps: any = {};
        deps.fs = fs;
        await deps.fs.writeFile("sessions.json", "{}\\n");
      `,
      "src/runtime/assigned-object-fs-module-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("uses branch-local fs object aliases after conditional reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const writer = { writeFile: fs.writeFile };
        if (ready) {
          writer.writeFile = customSink;
          await writer.writeFile("sessions.json", "{}\\n");
        }
      `,
      "src/runtime/conditional-object-fs-write-alias-reassignment.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not leak local fs module aliases outside their scope", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        {
          const storage = fs;
          const { writeFile } = storage;
          await writeFile(currentSqlitePath, "{}\\n");
        }
        {
          const storage = customWriter;
          const { writeFile } = storage;
          await writeFile("sessions.json", "{}\\n");
        }
      `,
      "src/runtime/local-fs-module-alias-scope.ts",
    );

    expect(violations).toEqual([]);
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

  it("flags legacy paths passed through wrapper object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import path from "node:path";
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const ledgerPath = path.join(stateDir, "acp", "event-ledger.json");
        await persist({ filePath: ledgerPath });
      `,
      "src/runtime/object-property-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags legacy paths passed through named wrapper options", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const store = "sessions.json";
        const params = { store };
        await persist(params);
      `,
      "src/runtime/named-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags legacy paths passed through destructured wrapper options", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags legacy paths passed through positional wrapper parameters", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(filePath: string) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist("sessions.json");
      `,
      "src/runtime/positional-wrapper-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags legacy paths from defaulted wrapper parameters", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persistPath(filePath = "sessions.json") {
          return writeTextAtomic(filePath, "{}\\n");
        }
        function persistOptions(options: { filePath?: string } = { filePath: "cron/jobs.json" }) {
          return writeTextAtomic(options.filePath ?? currentSqlitePath, "{}\\n");
        }
        function persistDestructured({ filePath = "cron/runs/job.jsonl" }: { filePath?: string } = {}) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        persistPath();
        persistPath(undefined);
        persistOptions();
        persistDestructured({});
        persistDestructured({ filePath: undefined });
        persistDestructured({ filePath: currentSqlitePath });
      `,
      "src/runtime/defaulted-wrapper-paths.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 12 },
      { kind: "legacy store filesystem write", line: 13 },
      { kind: "legacy store filesystem write", line: 14 },
      { kind: "legacy store filesystem write", line: 15 },
      { kind: "legacy store filesystem write", line: 16 },
    ]);
  });

  it("clears wrapper object parameter paths after reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          params = { filePath: currentSqlitePath };
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-wrapper-object-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears wrapper object parameter paths after nested block reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          {
            params = { filePath: currentSqlitePath };
          }
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/nested-reassigned-wrapper-object-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not let block-local wrapper parameter shadows clear outer paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          {
            const params = { filePath: currentSqlitePath };
            await use(params);
          }
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/block-local-wrapper-object-options-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("clears destructured wrapper option paths after reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          filePath = currentSqlitePath;
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears wrapper object property paths after reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          params.filePath = currentSqlitePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-wrapper-property-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("updates wrapper object property paths after reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          params.filePath = legacy.filePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-wrapper-property-from-parameter.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("keeps wrapper object property paths after conditional reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          if (ready) params.filePath = currentSqlitePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/conditional-reassigned-wrapper-property-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("keeps wrapper object parameter paths after conditional reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          if (ready) params = { filePath: currentSqlitePath };
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/conditional-reassigned-wrapper-object-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("keeps wrapper object property paths after for-of reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          for (const item of items) {
            params.filePath = currentSqlitePath;
          }
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/for-of-reassigned-wrapper-property-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("keeps wrapper object property paths after try-block reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          try {
            maybeThrow();
            params.filePath = currentSqlitePath;
          } catch {}
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/try-reassigned-wrapper-property-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("clears wrapper object property paths after exhaustive current-path assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          if (ready) params.filePath = currentSqlitePath;
          else params.filePath = currentSqlitePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/exhaustive-current-wrapper-property-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("clears wrapper object parameter paths after exhaustive current-object assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          if (ready) params = { filePath: currentSqlitePath };
          else params = { filePath: currentSqlitePath };
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/exhaustive-current-wrapper-object-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper object property paths after mixed exhaustive assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          if (ready) params.filePath = currentSqlitePath;
          else params.filePath = legacy.filePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/exhaustive-mixed-wrapper-property-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags wrapper object property paths after conditional reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          if (ready) params.filePath = legacy.filePath;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/conditional-reassigned-wrapper-property-from-parameter.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper object paths after conditional reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          if (ready) params = legacy;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/conditional-reassigned-wrapper-object-from-parameter.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags destructured wrapper paths after conditional reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }, legacy: { filePath: string }) {
          if (ready) filePath = legacy.filePath;
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/conditional-reassigned-destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags legacy paths passed through locally destructured wrapper options", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          const { filePath } = params;
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/local-destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags legacy paths passed through local wrapper property aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          const filePath = params.filePath;
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/local-property-alias-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags legacy paths passed through local wrapper object aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          const target = params;
          return writeTextAtomic(target.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/local-object-alias-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper object paths after reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          params = legacy;
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-wrapper-object-from-parameter.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper object property paths after nested block reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }, legacy: { filePath: string }) {
          {
            params.filePath = legacy.filePath;
          }
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/nested-block-reassigned-wrapper-property.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags wrapper destructured paths after nested block reassignment from another parameter", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }, legacy: { filePath: string }) {
          {
            filePath = legacy.filePath;
          }
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: currentSqlitePath }, { filePath: "sessions.json" });
      `,
      "src/runtime/nested-block-reassigned-wrapper-destructured.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not leak block-local wrapper path aliases into the parent block", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          const filePath = currentSqlitePath;
          {
            const filePath = params.filePath;
          }
          return writeTextAtomic(filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/block-local-wrapper-path-alias.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper option paths written through body-local fs aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const { writeFile } = fs;
          return writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/body-local-fs-alias-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper option paths written through body-local fs method aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const save = fs.writeFile;
          return save(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-body-local-fs-method-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper option paths written through body-local fs object aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const writer = { writeFile: fs.writeFile };
          return writer.writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/body-local-fs-object-alias-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper option paths written through bracketed body-local fs object aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const writer = { writeFile: fs.writeFile };
          return writer["writeFile"](params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/body-local-bracket-fs-object-alias-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("clears wrapper body fs object aliases after object reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          let writer = { writeFile: fs.writeFile };
          writer = customWriter;
          return writer.writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-body-local-fs-object-alias-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not let block-local wrapper aliases mutate outer wrapper metadata", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        import { writeFile } from "../infra/custom-writer.js";
        function persist(params: { filePath: string }) {
          return writeFile(params.filePath, "{}\\n");
        }
        {
          const save = persist;
          const { writeFile } = fs;
          await save({ filePath: "sessions.json" });
        }
        await persist({ filePath: "cron/jobs.json" });
      `,
      "src/runtime/block-local-wrapper-alias-metadata.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper option paths written through fs.promises", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs";
        function persist(params: { filePath: string }) {
          return fs.promises.writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-fs-promises-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags wrapper option paths written through outer fs module object aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        const deps = { fs };
        function persist(params: { filePath: string }) {
          return deps.fs.writeFile(params.filePath, "{}\\n");
        }
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-outer-fs-module-object-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags wrapper option paths written through injected fs handles", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function persist(deps: { fs: typeof import("node:fs") }, params: { filePath: string }) {
          return deps.fs.promises.writeFile(params.filePath, "{}\\n");
        }
        await persist(deps, { filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-injected-fs-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("does not treat untyped wrapper fs properties as filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function persist(deps: { fs: { promises: { writeFile: Function } } }, params: { filePath: string }) {
          return deps.fs.promises.writeFile(params.filePath, "{}\\n");
        }
        await persist(deps, { filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-custom-fs-property.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper option paths written through CommonJS fs", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function persist(params: { filePath: string }) {
          const fs = require("node:fs");
          return fs.promises.writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-commonjs-fs-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags wrapper options forwarded to filePath helper objects", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { appendRegularFile, replaceFileAtomic } from "../infra/fs-safe.js";
        function append(options: { filePath: string; content: string }) {
          return appendRegularFile(options);
        }
        function replace(options: { filePath: string; content: string }) {
          return replaceFileAtomic(options);
        }
        append({ filePath: "sessions.json", content: "{}\\n" });
        replace({ filePath: "plugin-state/state.sqlite", content: "" });
      `,
      "src/runtime/forwarded-filepath-helper-options.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 9 },
      { kind: "legacy store filesystem write", line: 10 },
    ]);
  });

  it("flags wrapper options forwarded through another wrapper", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { filePath: string }) {
          return persist(params);
        }
        save({ filePath: "sessions.json" });
      `,
      "src/runtime/transitive-wrapper-forwarding.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags wrapper options spread through another wrapper", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { filePath: string }) {
          return persist({ ...params });
        }
        save({ filePath: "sessions.json" });
      `,
      "src/runtime/transitive-wrapper-spread-forwarding.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("allows wrapper spread forwarding when a later property overrides the path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { filePath: string }) {
          return persist({ ...params, filePath: currentSqlitePath });
        }
        save({ filePath: "sessions.json" });
      `,
      "src/runtime/transitive-wrapper-spread-overridden-forwarding.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper spread forwarding when a later spread restores the path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { filePath: string }) {
          return persist({ filePath: currentSqlitePath, ...params });
        }
        save({ filePath: "sessions.json" });
      `,
      "src/runtime/transitive-wrapper-spread-restored-forwarding.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags wrapper options renamed through another wrapper", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        function save(params: { storePath: string }) {
          return persist({ filePath: params.storePath });
        }
        save({ storePath: "sessions.json" });
      `,
      "src/runtime/transitive-wrapper-renamed-forwarding.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags hoisted wrappers that use write aliases declared later", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          return writeFile(params.filePath, "{}\\n");
        }
        const { writeFile } = fs;
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/late-alias-hoisted-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags hoisted wrappers that use renamed write aliases declared later", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          return write(params.filePath, "{}\\n");
        }
        const { writeFile: write } = fs;
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/late-renamed-alias-hoisted-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags reassigned wrapper variables", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist;
        persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-wrapper-variable.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags aliased wrapper variables", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const save = persist;
        save({ filePath: "sessions.json" });
      `,
      "src/runtime/aliased-wrapper-variable.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags object method wrappers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        writer.persist({ filePath: "sessions.json" });
      `,
      "src/runtime/object-method-wrapper.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags object property wrapper functions", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist: (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n"),
        };
        writer["persist"]({ filePath: "sessions.json" });
      `,
      "src/runtime/object-property-wrapper-function.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("flags object wrapper shorthand aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const writer = { persist };
        await writer.persist({ filePath: "sessions.json" });
      `,
      "src/runtime/object-wrapper-shorthand-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags object wrapper property aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const writer = { save: persist };
        await writer.save({ filePath: "sessions.json" });
      `,
      "src/runtime/object-wrapper-property-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("flags object wrapper methods assigned after declaration", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let writer: any = {};
        writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        await writer.persist({ filePath: "sessions.json" });
      `,
      "src/runtime/assigned-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("clears object wrapper metadata after object reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let writer: any = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        writer = customWriter;
        await writer.persist({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-object-wrapper-method.ts",
    );

    expect(violations).toEqual([]);
  });

  it("uses branch-local object wrapper metadata after conditional reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer: any = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        if (ready) {
          writer.persist = customPersist;
          await writer.persist({ filePath: "sessions.json" });
        }
      `,
      "src/runtime/conditional-object-wrapper-reassignment.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags object wrapper property assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer: any = {};
        writer.persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        await writer.persist({ filePath: "sessions.json" });
      `,
      "src/runtime/object-wrapper-property-assignment.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags extracted object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        const save = writer.persist;
        await save({ filePath: "sessions.json" });
      `,
      "src/runtime/extracted-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags extracted bracket object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        const save = writer["persist"];
        await save({ filePath: "sessions.json" });
      `,
      "src/runtime/extracted-bracket-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags reassigned aliases from object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        let save;
        save = writer.persist;
        await save({ filePath: "sessions.json" });
      `,
      "src/runtime/reassigned-object-wrapper-method-alias.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 10 }]);
  });

  it("flags destructured object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        const { persist } = writer;
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/destructured-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("flags renamed destructured object wrapper methods", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const writer = {
          persist(params: { filePath: string }) {
            return writeTextAtomic(params.filePath, "{}\\n");
          },
        };
        const { persist: save } = writer;
        await save({ filePath: "sessions.json" });
      `,
      "src/runtime/renamed-destructured-object-wrapper-method.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("clears wrapper metadata after non-wrapper reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        persist = customSink;
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/cleared-wrapper-variable.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps wrapper metadata after conditional non-wrapper reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        if (ready) persist = customSink;
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/conditional-cleared-wrapper-variable.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("clears wrapper metadata after exhaustive non-wrapper reassignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        if (ready) persist = customSink;
        else persist = customSink;
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/exhaustive-cleared-wrapper-variable.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps wrapper metadata after try-block non-wrapper reassignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let persist = (params: { filePath: string }) => writeTextAtomic(params.filePath, "{}\\n");
        try {
          maybeThrow();
          persist = customSink;
        } catch {}
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/try-cleared-wrapper-variable.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags wrapper option paths read through bracket property access", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params["filePath"], "{}\\n");
        }
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/bracket-wrapper-property.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 6 }]);
  });

  it("does not treat custom writeFile methods as wrapper filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        function persist(writer: { writeFile: (path: string, content: string) => void }, params: { filePath: string }) {
          return writer.writeFile(params.filePath, "{}\\n");
        }
        persist(customWriter, { filePath: "sessions.json" });
      `,
      "src/runtime/custom-writer-method-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not use outer wrapper metadata for shadowed wrapper names", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        {
          function persist(_options: { store: string }) {
            return "current";
          }
          await persist({ store: "sessions.json" });
        }
      `,
      "src/runtime/shadowed-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not let loop-scoped wrapper names shadow outer wrappers", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        for (const persist of handlers) {
          await persist(currentOptions);
        }
        await persist({ store: "sessions.json" });
      `,
      "src/runtime/loop-scoped-wrapper-name.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("does not use outer wrapper metadata for destructured parameter wrapper names", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        function caller({ persist }: { persist: (options: { store: string }) => void }) {
          persist({ store: "sessions.json" });
        }
      `,
      "src/runtime/destructured-wrapper-name-parameter.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat sibling object metadata as the wrapper path property", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const params = { label: "sessions.json", filePath: currentSqlitePath };
        await persist(params);
      `,
      "src/runtime/current-path-sibling-metadata.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat custom writeFile methods as direct filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const params = { filePath: "sessions.json" };
        await customWriter.writeFile(params.filePath, "{}\\n");
      `,
      "src/runtime/custom-writer-method.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths written through injected fs handles", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const storePath = "sessions.json";
        const params: { deps: { fs: typeof import("node:fs") } } = { deps };
        await params.deps.fs.promises.writeFile(storePath, "{}\\n");
      `,
      "src/runtime/injected-fs-write.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 4 }]);
  });

  it("does not treat custom fs properties as direct filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        const storePath = "sessions.json";
        await client.fs.promises.writeFile(storePath, "{}\\n");
      `,
      "src/runtime/custom-fs-property.ts",
    );

    expect(violations).toEqual([]);
  });

  it("updates object path metadata after property assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        params.filePath = "sessions.json";
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/assigned-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("updates object path metadata after bracket property assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        params["filePath"] = "sessions.json";
        writeTextAtomic(params["filePath"], "{}\\n");
      `,
      "src/runtime/bracket-assigned-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("updates outer object path metadata after nested property assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        {
          params.filePath = "sessions.json";
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/nested-assigned-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("clears object path metadata after current-path assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        params.filePath = currentSqlitePath;
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/reassigned-object-path.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps legacy object metadata after conditional current-path assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        if (ready) params.filePath = currentSqlitePath;
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/conditional-current-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("keeps legacy object metadata after loop current-path assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        while (ready) params.filePath = currentSqlitePath;
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/loop-current-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("does not let for-loop object bindings clear outer object metadata", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        for (const params = { filePath: currentSqlitePath }; ready; advance()) {
          await use(params);
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/for-loop-object-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("does not leak for-loop legacy object bindings after the loop", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        for (const params = { filePath: "sessions.json" }; ready; advance()) {
          await use(params);
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/for-loop-legacy-object-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps legacy object metadata after conditional current-object assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          params = { filePath: currentSqlitePath };
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/conditional-current-object.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 7 }]);
  });

  it("clears object metadata after exhaustive current-object assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          params = { filePath: currentSqlitePath };
        } else {
          params = { filePath: currentSqlitePath };
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/exhaustive-current-object.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps outer object metadata after optional exhaustive current-object assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          if (mode === "a") {
            params = { filePath: currentSqlitePath };
          } else {
            params = { filePath: currentSqlitePath };
          }
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/optional-exhaustive-current-object.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("allows branch-local writes after nested exhaustive current-object assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          if (mode === "a") {
            params = { filePath: currentSqlitePath };
          } else {
            params = { filePath: currentSqlitePath };
          }
          writeTextAtomic(params.filePath, "{}\\n");
        }
      `,
      "src/runtime/branch-local-exhaustive-current-object.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps object metadata when one exhaustive branch keeps a legacy object", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        if (ready) {
          params = { filePath: currentSqlitePath };
        } else {
          params = { filePath: "sessions.json" };
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/exhaustive-mixed-object.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("clears object property metadata after exhaustive current-path assignments", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        if (ready) {
          params.filePath = currentSqlitePath;
        } else {
          params.filePath = currentSqlitePath;
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/exhaustive-current-object-property.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps legacy object metadata after try-block current-object assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        try {
          maybeThrow();
          params = { filePath: currentSqlitePath };
        } catch {}
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/try-current-object.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("clears outer object path metadata after nested current-path assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        {
          params.filePath = currentSqlitePath;
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/nested-reassigned-object-path.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows in-branch writes after object property reassignment to the current path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        if (ready) {
          params.filePath = currentSqlitePath;
          writeTextAtomic(params.filePath, "{}\\n");
        }
      `,
      "src/runtime/branch-reassigned-object-property.ts",
    );

    expect(violations).toEqual([]);
  });

  it("updates object path metadata after whole-object assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: currentSqlitePath };
        params = { filePath: "sessions.json" };
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/reassigned-object.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("clears object path metadata after whole-object current-path assignment", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        let params = { filePath: "sessions.json" };
        params = { filePath: currentSqlitePath };
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/reassigned-current-object.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths destructured from tracked object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        const { filePath } = params;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/destructured-tracked-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("flags legacy paths from nested destructured object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { nested: { filePath: "sessions.json" } };
        const { nested: { filePath } } = params;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/nested-destructured-tracked-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("uses tracked nested current paths before destructured defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { nested: { filePath: currentSqlitePath } };
        const { nested: { filePath = "sessions.json" } } = params;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/nested-destructured-current-object-path.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags legacy paths from destructured default values", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = {};
        const { filePath = "sessions.json" } = params;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/destructured-default-object-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 5 }]);
  });

  it("uses tracked object properties before destructured defaults", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: currentSqlitePath };
        const { filePath = "sessions.json" } = params;
        writeTextAtomic(filePath, "{}\\n");
      `,
      "src/runtime/destructured-default-current-object-path.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper shorthand options destructured from tracked object properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          return writeTextAtomic(params.filePath, "{}\\n");
        }
        const params = { filePath: "sessions.json" };
        const { filePath } = params;
        persist({ filePath });
      `,
      "src/runtime/destructured-shorthand-wrapper-path.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("does not treat unrelated property names as destructured wrapper paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          return writeTextAtomic(current.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/unrelated-property-name-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("flags wrapper option paths forwarded through object aliases", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        const forwarded = params;
        await persist(forwarded);
      `,
      "src/runtime/forwarded-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags wrapper option paths forwarded through object spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        const forwarded = { ...params };
        await persist(forwarded);
      `,
      "src/runtime/spread-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 8 }]);
  });

  it("flags wrapper option paths passed through inline object spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        await persist({ ...params });
        await persist({ store: currentSqlitePath, ...params });
      `,
      "src/runtime/inline-spread-wrapper-options.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 7 },
      { kind: "legacy store filesystem write", line: 8 },
    ]);
  });

  it("flags wrapper option paths passed through inline object literal spreads", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        await persist({ ...{ store: "sessions.json" } });
        const params = { ...{ store: "sessions.json" } };
        await persist(params);
      `,
      "src/runtime/inline-object-literal-spread-wrapper-options.ts",
    );

    expect(violations).toEqual([
      { kind: "legacy store filesystem write", line: 6 },
      { kind: "legacy store filesystem write", line: 8 },
    ]);
  });

  it("allows inline object spreads when a later property overrides the legacy path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        await persist({ ...params, store: currentSqlitePath });
      `,
      "src/runtime/inline-spread-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows inline object literal spreads when a later property overrides the legacy path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        await persist({ ...{ store: "sessions.json" }, store: currentSqlitePath });
        await persist({ store: "sessions.json", ...{ store: currentSqlitePath } });
      `,
      "src/runtime/inline-object-literal-spread-current-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("allows inline object spreads when a later spread overrides the legacy path", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const currentOptions = { store: currentSqlitePath };
        await persist({ store: "sessions.json", ...currentOptions });
      `,
      "src/runtime/inline-current-spread-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not copy wrapper option metadata from shadowed source objects", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeJson } from "../infra/json-files.js";
        function persist(options: { store: string }) {
          return writeJson(options.store, {});
        }
        const params = { store: "sessions.json" };
        {
          const params = currentSqlitePath;
          const forwarded = params;
          await persist(forwarded);
        }
      `,
      "src/runtime/shadowed-forwarded-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat shadowed fs alias names as wrapper filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeFile } from "node:fs/promises";
        function persist(writeFile: (path: string, value: string) => void, params: { filePath: string }) {
          return writeFile(params.filePath, "{}\\n");
        }
        await persist(customSink, { filePath: "sessions.json" });
      `,
      "src/runtime/shadowed-fs-alias-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat block-shadowed fs alias names as wrapper filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeFile } from "node:fs/promises";
        {
          const writeFile = customSink;
          function persist(params: { filePath: string }) {
            return writeFile(params.filePath, "{}\\n");
          }
          persist({ filePath: "sessions.json" });
        }
      `,
      "src/runtime/block-shadowed-fs-alias-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat destructures from shadowed fs module names as wrapper filesystem writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          const fs = customFs;
          const { writeFile } = fs;
          return writeFile(params.filePath, "{}\\n");
        }
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/shadowed-fs-module-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not treat shadowed wrapper parameter objects as argument paths", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          {
            const params = { filePath: currentSqlitePath };
            writeTextAtomic(params.filePath, "{}\\n");
          }
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/shadowed-wrapper-parameter-object.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not keep object metadata for uninitialized local shadows", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        {
          let params;
          writeTextAtomic(params.filePath, "{}\\n");
        }
      `,
      "src/runtime/uninitialized-object-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps catch binding shadows scoped to the catch block", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        try {
          await load();
        } catch (params) {
          writeTextAtomic(params.filePath, "{}\\n");
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `,
      "src/runtime/catch-object-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
  });

  it("keeps wrapper catch binding shadows scoped to the catch block", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist(params: { filePath: string }) {
          try {
            await load();
          } catch (params) {
            await recover(params);
          }
          writeTextAtomic(params.filePath, "{}\\n");
        }
        persist({ filePath: "sessions.json" });
      `,
      "src/runtime/wrapper-catch-object-shadow.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 11 }]);
  });

  it("does not keep object metadata for destructured local shadows", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        {
          const { params } = source;
          writeTextAtomic(params.filePath, "{}\\n");
        }
      `,
      "src/runtime/destructured-object-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not let unrelated nested fs aliases mark custom writes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        import { writeFile } from "./custom-writer.js";
        await writeFile("sessions.json", "{}\\n");
        function later() {
          const { writeFile } = fs;
          return writeFile(currentSqlitePath, "{}\\n");
        }
      `,
      "src/runtime/custom-writer-shadow.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not use caller block fs aliases for outer wrapper bodies", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        import { writeFile } from "./custom-writer.js";
        function persist(params: { filePath: string }) {
          return writeFile(params.filePath, "{}\\n");
        }
        {
          const { writeFile } = fs;
          await persist({ filePath: "sessions.json" });
        }
      `,
      "src/runtime/caller-block-alias-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("does not leak block-scoped fs aliases across wrapper body scopes", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import fs from "node:fs/promises";
        function persist(params: { filePath: string }) {
          {
            const { writeFile } = fs;
            writeFile(currentSqlitePath, "{}\\n");
          }
          return writeFile(params.filePath, "{}\\n");
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/block-scoped-fs-alias-wrapper.ts",
    );

    expect(violations).toEqual([]);
  });

  it("ignores shadowed destructured wrapper option names", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          {
            const filePath = currentSqlitePath;
            writeTextAtomic(filePath, "{}\\n");
          }
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/shadowed-destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([]);
  });

  it("keeps earlier destructured wrapper option uses before later shadowing", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        function persist({ filePath }: { filePath: string }) {
          writeTextAtomic(filePath, "{}\\n");
          {
            const filePath = currentSqlitePath;
          }
        }
        await persist({ filePath: "sessions.json" });
      `,
      "src/runtime/late-shadowed-destructured-wrapper-options.ts",
    );

    expect(violations).toEqual([{ kind: "legacy store filesystem write", line: 9 }]);
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

  it("lets inner object properties shadow outer legacy path properties", () => {
    const violations = collectDatabaseFirstLegacyStoreViolations(
      `
        import { writeTextAtomic } from "../infra/json-files.js";
        const params = { filePath: "sessions.json" };
        {
          const params = { filePath: currentSqlitePath };
          await writeTextAtomic(params.filePath, "{}\\n");
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
