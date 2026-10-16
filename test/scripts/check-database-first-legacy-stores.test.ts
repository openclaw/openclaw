// Database-first legacy-store guard tests cover runtime state-file regressions.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  collectDatabaseFirstNativeLegacyStoreViolations,
  collectDatabaseFirstLegacyStoreSourceFiles,
  collectDatabaseFirstLegacyStoreViolations,
} from "../../scripts/check-database-first-legacy-stores.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function parseFixture(content: string, fileName: string) {
  return [content, fileName, parser.parseSourceFile(fileName, content)] as const;
}

type LegacyStoreViolations = ReturnType<typeof collectDatabaseFirstLegacyStoreViolations>;
type UnnamedViolationCase = {
  source: string;
  filename: string;
  expected: LegacyStoreViolations;
};

function filesystemWriteViolations(...lines: number[]): LegacyStoreViolations {
  return lines.map((line) => ({ kind: "legacy store filesystem write", line }));
}

function createSourceCase(source: string) {
  return (filename: string, expected: LegacyStoreViolations): UnnamedViolationCase => ({
    source,
    filename: filename.includes("/") ? filename : `src/runtime/${filename}`,
    expected,
  });
}

function sourceCase(source: TemplateStringsArray) {
  return createSourceCase(source.join(""));
}

function importedSourceCase(
  importStatement: string,
  prefix: readonly string[] = [],
  suffix: readonly string[] = [],
) {
  return (source: TemplateStringsArray) => {
    const body = source.join("");
    const closingIndent = /\n([\t ]*)$/.exec(body);
    if (!closingIndent) {
      throw new Error("Source fixtures must end with an indented closing line.");
    }

    // Restore each envelope at its original indentation so reported source lines stay identical.
    const indent = `${closingIndent[1]}  `;
    const renderLines = (lines: readonly string[]) =>
      lines.map((line) => `\n${indent}${line}`).join("");
    const restored = `${renderLines([importStatement, ...prefix])}${body.slice(
      0,
      closingIndent.index,
    )}${renderLines(suffix)}${body.slice(closingIndent.index)}`;
    return createSourceCase(restored);
  };
}

const filesystemImport = 'import { promises as fs } from "node:fs";';
const atomicImport = 'import { writeTextAtomic } from "../infra/json-files.js";';
const promisesImport = 'import fs from "node:fs/promises";';
const writeFileImport = 'import { writeFile } from "node:fs/promises";';
const requireImport = 'import { createRequire } from "node:module";';
const privateStoreImport =
  'import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";';

const fsCase = importedSourceCase(filesystemImport);
const atomicCase = importedSourceCase(atomicImport);
const fsPromisesCase = importedSourceCase(promisesImport);
const writeFileCase = importedSourceCase(writeFileImport);
const requireCase = importedSourceCase(requireImport);
const privateStoreCase = importedSourceCase(privateStoreImport);
const fsPathCase = importedSourceCase(filesystemImport, ['import path from "node:path";']);
const fsPersistCase = importedSourceCase(
  filesystemImport,
  ["function persist(filePath: string) {"],
  ["}", 'await persist("sessions.json");'],
);
const atomicPersistCase = importedSourceCase(
  atomicImport,
  ["function persist(params: { filePath: string }) {"],
  ["}", 'await persist({ filePath: "sessions.json" });'],
);
const fsPromisesPersistCase = importedSourceCase(
  promisesImport,
  ["function persist(params: { filePath: string }) {"],
  ["}", 'await persist({ filePath: "sessions.json" });'],
);
const writeFileOptionsCase = importedSourceCase(writeFileImport, [
  "function persist(params: { filePath: string }) {",
  '  return writeFile(params.filePath, "{}\\n");',
  "}",
]);

function namedCases(cases: Record<string, UnnamedViolationCase>) {
  return Object.entries(cases).map(([name, { source, filename, expected }]) => ({
    name,
    source,
    filename,
    expected,
  }));
}

async function collectFixtureSources(filenames: string[], roots: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-db-first-guard-"));
  try {
    for (const filename of filenames) {
      const filePath = path.join(root, filename);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "export {};\n");
    }
    const files = await collectDatabaseFirstLegacyStoreSourceFiles(
      roots.map((entry) => path.join(root, entry)),
    );
    return files.map((file) => path.relative(root, file).replaceAll(path.sep, "/")).toSorted();
  } finally {
    await fs.rm(root, { force: true, recursive: true });
  }
}

describe("check-database-first-legacy-stores", () => {
  it("skips generated extension asset, renderer, and dist bundles", async () => {
    expect(
      await collectFixtureSources(
        [
          "extensions/diffs/assets/viewer-runtime.js",
          "extensions/diffs/dist/assets/viewer-runtime.js",
          "extensions/diffs/src/runtime.js",
          "extensions/canvas/src/host/a2ui/a2ui.bundle.js",
          "extensions/canvas/src/host/a2ui/bootstrap.js",
          "packages/plugin-sdk/dist/index.js",
          "packages/plugin-sdk/src/index.js",
        ],
        ["extensions", "packages"],
      ),
    ).toEqual([
      "extensions/canvas/src/host/a2ui/bootstrap.js",
      "extensions/diffs/src/runtime.js",
      "packages/plugin-sdk/src/index.js",
    ]);
  });

  it("keeps legacy restart sentinel filesystem access in its sole migration owner", () => {
    const runtimeViolations = collectDatabaseFirstLegacyStoreViolations(
      ...parseFixture(
        `
        import { readFile } from "node:fs/promises";
        import path from "node:path";
        const legacyFilename = "restart-sentinel.json";
      `,
        "src/infra/restart-sentinel.ts",
      ),
    );
    const migrationViolations = collectDatabaseFirstLegacyStoreViolations(
      ...parseFixture(
        `
        import { readFile } from "node:fs/promises";
        import path from "node:path";
        const legacyFilename = "restart-sentinel.json";
      `,
        "src/infra/state-migrations.restart-sentinel.ts",
      ),
    );

    expect(runtimeViolations).toEqual([
      { kind: "legacy restart sentinel filesystem import", line: 2 },
      { kind: "legacy restart sentinel filesystem import", line: 3 },
      { kind: "legacy restart sentinel reference", line: 4 },
    ]);
    expect(migrationViolations).toEqual([]);
  });

  it("keeps exec approvals legacy paths and stable URI identity in their exact owners", () => {
    const runtimeViolations = collectDatabaseFirstLegacyStoreViolations(
      ...parseFixture(
        `
        import fs from "node:fs";
        const legacyFilename = "exec-approvals.json";
      `,
        "src/infra/exec-approvals-store.ts",
      ),
    );
    const migrationViolations = collectDatabaseFirstLegacyStoreViolations(
      ...parseFixture(
        `
        import fs from "node:fs";
        const legacyFilename = "exec-approvals.json";
      `,
        "src/infra/state-migrations.exec-approvals.ts",
      ),
    );
    const configViolations = collectDatabaseFirstLegacyStoreViolations(
      ...parseFixture(
        'const EXEC_APPROVALS_FILE = "exec-approvals.json";',
        "src/infra/exec-approvals-config.ts",
      ),
    );
    const stableUriViolations = collectDatabaseFirstLegacyStoreViolations(
      ...parseFixture(
        'export const EXEC_APPROVALS_POLICY_URI = "oc://exec-approvals.json";',
        "extensions/policy/src/exec-approvals-uri.ts",
      ),
    );
    const copiedUriViolations = collectDatabaseFirstLegacyStoreViolations(
      ...parseFixture(
        'const copied = "oc://exec-approvals.json";',
        "extensions/policy/src/doctor/copied-uri.ts",
      ),
    );

    expect(runtimeViolations).toEqual([
      { kind: "legacy exec approvals filesystem import", line: 2 },
      { kind: "legacy exec approvals reference", line: 3 },
    ]);
    expect(migrationViolations).toEqual([]);
    expect(configViolations).toEqual([]);
    expect(stableUriViolations).toEqual([]);
    expect(copiedUriViolations).toEqual([{ kind: "legacy exec approvals reference", line: 1 }]);
  });

  it("preserves boundary family order and distinct duplicate policies in migration paths", () => {
    const content = String.raw`
      type ApprovalPath = "exec\x2dapprovals.json";
      const sentinels = ["restart-sentinel.json", "restart-sentinel.json"];
      type SentinelPath = "restart\x2dsentinel.json";
      const approvals = ["exec-approvals.json", "exec-approvals.json"];
    `;

    expect(
      collectDatabaseFirstLegacyStoreViolations(
        ...parseFixture(content, "src/commands/doctor/boundaries.ts"),
      ),
    ).toEqual([
      { kind: "legacy restart sentinel reference", line: 3 },
      { kind: "legacy restart sentinel reference", line: 4 },
      { kind: "legacy exec approvals reference", line: 2 },
      { kind: "legacy exec approvals reference", line: 5 },
      { kind: "legacy exec approvals reference", line: 5 },
    ]);
  });

  // Legacy paths and literal propagation.
  it.each(
    namedCases({
      "allows the CLI preflight to detect exact legacy restart sentinel inputs": sourceCase`
        import fs from "node:fs";
        [
          path.join(stateDir, "restart-sentinel.json"),
          path.join(stateDir, "restart-sentinel.json.doctor-importing"),
        ].some(fs.existsSync);
      `("src/cli/program/config-guard.ts", []),
      "flags a shadowed filesystem import in CLI preflight detection": sourceCase`
        import fs from "node:fs";
        function detect(fs) {
          return [path.join(stateDir, "restart-sentinel.json")].some(fs.existsSync);
        }
      `("src/cli/program/config-guard.ts", [
        { kind: "legacy restart sentinel reference", line: 4 },
      ]),
      "flags direct legacy restart sentinel reads from the CLI preflight": sourceCase`
        await readFile(path.join(stateDir, "restart-sentinel.json"), "utf8");
        await readFile(path.join(stateDir, "restart-sentinel.json.doctor-importing"), "utf8");
      `("src/cli/program/config-guard.ts", [
        { kind: "legacy restart sentinel reference", line: 2 },
        { kind: "legacy restart sentinel reference", line: 3 },
      ]),
      "flags runtime writes to retired system-agent rescue approval stores": fsPathCase`
        await fs.writeFile(path.join(stateDir, "openclaw", "rescue-pending", \`\${key}.json\`), "{}\\n");
        await fs.writeFile(path.join(stateDir, "crestodian", "rescue-pending", "old.json"), "{}\\n");
      `("src/system-agent/rescue-writer.ts", filesystemWriteViolations(4, 5)),
      "flags fs-safe factory aliases writing legacy paths": privateStoreCase`
        import * as fsSafe from "openclaw/plugin-sdk/security-runtime";
        const makePrivateStore = privateFileStore;
        const makeRoot = fsSafe.root;
        const { privateFileStore: makeFromNamespace } = fsSafe;
        await makePrivateStore(stateDir).writeJson("thread-bindings.json", {});
        await (await makeRoot(stateDir)).writeJson("plugin-binding-approvals.json", {});
        await makeFromNamespace(stateDir).writeJson("gateway-restart-intent.json", {});
      `("fs-safe-factory-alias-write.ts", filesystemWriteViolations(7, 8, 9)),
      "flags fs-safe store root writes to legacy paths": privateStoreCase`
        const state = await privateFileStore(stateDir).root();
        await state.writeJson("thread-bindings.json", {});
        await (await privateFileStore(stateDir).root()).writeJson("plugin-binding-approvals.json", {});
      `("fs-safe-store-root-write.ts", filesystemWriteViolations(4, 5)),
      "flags direct fs-safe package store writes to legacy paths": sourceCase`
        import { fileStore, jsonStore } from "@openclaw/fs-safe/store";
        await fileStore({ rootDir: stateDir }).writeJson("thread-bindings.json", {});
        const options = { filePath: "plugin-binding-approvals.json" };
        await jsonStore(options).write({});
        await jsonStore({ filePath: "gateway-restart-intent.json" }).update((current) => current ?? {});
      `("direct-fs-safe-store-write.ts", filesystemWriteViolations(3, 5, 6)),
      "flags fs-safe store object aliases writing legacy paths": privateStoreCase`
        const jsonBindings = privateFileStore(stateDir).json("plugin-binding-approvals.json");
        const stores = {
          state: privateFileStore(stateDir),
          bindings: jsonBindings,
        };
        await stores.state.writeJson("thread-bindings.json", {});
        await stores.bindings.write({});
        stores.state = customStore;
        stores.bindings = privateFileStore(stateDir).json("gateway-restart-intent.json");
        await stores.state.writeJson("thread-bindings.json", {});
        await stores.bindings.update((current) => current ?? {});
      `("fs-safe-store-object-alias-write.ts", filesystemWriteViolations(8, 9, 13)),
      "clears nested fs-safe store object aliases after exhaustive property reassignment":
        privateStoreCase`
        const stores = { inner: { bindings: privateFileStore(stateDir).json("thread-bindings.json") } };
        if (flag) {
          stores.inner = { bindings: customA };
        } else {
          stores.inner = { bindings: customB };
        }
        await stores.inner.bindings.write({});
      `("exhaustive-nested-fs-safe-store-property-reassignment.ts", []),
      "allows read-only fs open calls and flags write modes": fsPromisesCase`
        await fs.open("sessions.json");
        await fs.open("sessions.json", "r");
        await fs.open("sessions.json", "r+");
        await fs.open("sessions.json", "w");
      `("open-flags.ts", filesystemWriteViolations(5, 6)),
      "allows fs copy calls reading from legacy store paths": fsPromisesCase`
        import syncFs from "node:fs";
        await fs.copyFile("sessions.json", "state/openclaw.sqlite.import");
        await fs.cp("cron/jobs.json", "state/openclaw.sqlite.import");
        syncFs.copyFileSync("auth-profiles.json", "state/openclaw.sqlite.import");
        syncFs.cpSync("cache/models.json", "state/openclaw.sqlite.import");
      `("fs-copy-legacy-store-source.ts", []),
      "flags legacy paths destructured from for-of tuple entries": sourceCase`
        import path from "node:path";
        import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
        const CLAIMS_DIGEST_PATH = ".openclaw-wiki/cache/claims.jsonl";
        const claimsDigestPath = path.join(rootDir, CLAIMS_DIGEST_PATH);
        for (const [filePath, content] of [[claimsDigestPath, claimsDigest]]) {
          const relativePath = path.relative(rootDir, filePath);
          const root = await fsRoot(rootDir);
          await root.write(relativePath, content);
        }
      `("for-of-destructured-legacy-path.ts", filesystemWriteViolations(9)),
      "does not treat shadowed createRequire bindings as Node require": requireCase`
        function save(createRequire: (url: string) => (specifier: string) => { writeFileSync(path: string, value: string): void }) {
          const require = createRequire("custom");
          const fs = require("node:fs");
          fs.writeFileSync("sessions.json", "");
        }
        save(customCreateRequire);
      `("shadowed-create-require.ts", []),
      "flags bracketed fs writes": sourceCase`
        import fs from "node:fs";
        await fs["writeFile"]("sessions.json", "{}\\n");
        await fs.promises["writeFile"]("cron/runs/job.jsonl", "{}\\n");
        require("node:fs")["writeFileSync"]("sessions.json", "{}\\n");
      `("bracketed-fs-writes.ts", filesystemWriteViolations(3, 4, 5)),
      "flags dynamic fs import write aliases": sourceCase`
        const { writeFile } = await import("node:fs/promises");
        const { promises } = await import("node:fs");
        await writeFile("sessions.json", "{}\\n");
        await promises.appendFile("cron/runs/job.jsonl", "{}\\n");
      `("dynamic-fs-import-aliases.ts", filesystemWriteViolations(4, 5)),
      "flags dynamic fs import promise callback writes": sourceCase`
        await import("node:fs/promises").then((fs) =>
          fs.writeFile("sessions.json", "{}\\n"),
        );
      `("dynamic-fs-import-promise-callback.ts", filesystemWriteViolations(3)),
      "flags destructured dynamic fs import promise callback writes": sourceCase`
        await import("node:fs/promises").then(({ writeFile }) =>
          writeFile("sessions.json", "{}\\n"),
        );
        await import("node:fs").then(({ promises }) =>
          promises.appendFile("cron/runs/job.jsonl", "{}\\n"),
        );
        await import("node:fs").then(({ promises: { writeFile: persist } }) =>
          persist("sessions.json", "{}\\n"),
        );
      `("destructured-dynamic-fs-import-promise-callback.ts", filesystemWriteViolations(3, 6, 9)),
      "flags write aliases destructured from fs.promises": sourceCase`
        import * as fs from "node:fs";
        const { writeFile: persist } = fs.promises;
        const fsp = fs.promises;
        const { appendFile } = fsp;
        await persist("sessions.json", "{}\\n", "utf8");
        await appendFile("cron/runs/job.jsonl", "{}\\n");
      `("fs-promises-aliases.ts", filesystemWriteViolations(6, 7)),
      "flags nested write aliases destructured from local fs module aliases": sourceCase`
        const nodeFs = require("node:fs");
        const { promises: { writeFile } } = nodeFs;
        await writeFile("sessions.json", "{}\\n");
      `("nested-local-fs-module-alias.ts", filesystemWriteViolations(4)),
      "flags legacy paths written through regular-file helpers": sourceCase`
        import { appendRegularFile as appendSafe } from "openclaw/plugin-sdk/security-runtime";
        const filePath = "session.trajectory.jsonl";
        await appendSafe({ filePath, content: "{}\\n" });
      `("regular-file-helper.ts", filesystemWriteViolations(4)),
      "flags forwarded top-level helper object binding literal defaults": fsCase`
        function writePath({ path = "sessions.json" } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist() {
          return writePath({});
        }
        await persist();
      `("top-level-helper-object-binding-literal-default.ts", filesystemWriteViolations(7)),
      "flags direct top-level helper calls with assignment defaults from earlier arguments": fsCase`
        let cached = "current-state.json";
        function writePath(filePath: string, path = (cached = filePath)) {
          return fs.writeFile(path, "{}\\n");
        }
        await writePath("sessions.json");
      `(
        "top-level-helper-direct-assignment-earlier-parameter-default.ts",
        filesystemWriteViolations(7),
      ),
      "does not force object binding defaults after exhaustive unknown object branch merges":
        fsCase`
        declare function loadOptions(): { path?: string };
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        let options;
        if (Math.random() > 0.5) {
          options = { path: "current-state.json" };
        } else {
          options = loadOptions();
        }
        await writePath("sessions.json", options);
      `("top-level-helper-object-binding-branch-unknown-default.ts", []),
      "keeps known-missing object properties after exhaustive branch merges": fsCase`
        function writePath(filePath: string, { path = filePath } = {}) {
          return fs.writeFile(path, "{}\\n");
        }
        let options;
        if (Math.random() > 0.5) {
          options = { path: "current-state.json" };
        } else {
          options = {};
        }
        await writePath("sessions.json", options);
      `(
        "top-level-helper-object-binding-branch-known-missing-default.ts",
        filesystemWriteViolations(12),
      ),
      "flags default expressions that combine multiple earlier parameters": fsCase`
        function writePath(prefix: string, filePath: string, path = prefix + filePath) {
          return fs.writeFile(path, "{}\\n");
        }
        function persist(filePath: string) {
          return writePath("state/", filePath);
        }
        await persist("sessions.json");
      `("top-level-helper-multiple-earlier-parameter-default.ts", filesystemWriteViolations(9)),
      "does not treat named function expression self-bindings as captured write aliases":
        fsPersistCase`
          const writeFile = fs.writeFile;
          const inner = function writeFile() {
            return writeFile(filePath);
          };
          return inner();
      `("named-function-expression-write-alias-shadow.ts", []),
      "flags var nested helper object methods declared in blocks": fsPersistCase`
          function inner() {
            {
              var writer = {
                save() {
                  return fs.writeFile(filePath, "{}\\n");
                },
              };
            }
            return writer.save();
          }
          return inner();
      `("nested-wrapper-var-block-helper-object-method.ts", filesystemWriteViolations(16)),
      "uses the last object literal property before nested helper destructuring defaults":
        fsPersistCase`
          const safe = () => undefined;
          const { save = () => fs.writeFile(filePath, "{}\\n") } = {
            save: safe,
            save: undefined,
          };
          return save?.();
      `("nested-wrapper-object-literal-duplicate-default.ts", filesystemWriteViolations(11)),
      "flags legacy paths forwarded through local nested object helper aliases": fsPersistCase`
          function inner() {
            const writer = {
              save() {
                return fs.writeFile(filePath, "{}\\n");
              },
            };
            const save = writer.save;
            return save();
          }
          return inner();
      `(
        "nested-object-wrapper-local-method-alias-closed-over-path.ts",
        filesystemWriteViolations(15),
      ),
      "flags legacy paths after exhaustive nested object wrapper assignments": fsCase`
        function persist(filePath: string, useJson: boolean) {
          let writer: { inner(nextPath: string): Promise<void> };
          if (useJson) {
            writer = {
              inner(nextPath: string) {
                return fs.writeFile(nextPath, "{}\\n");
              },
            };
          } else {
            writer = {
              inner(nextPath: string) {
                return fs.writeFile(nextPath, "[]\\n");
              },
            };
          }
          return writer.inner(filePath);
        }
        await persist("sessions.json", true);
      `("nested-object-wrapper-branch-assignment.ts", filesystemWriteViolations(20)),
      "flags legacy paths after exhaustive nested object wrapper parameter assignments": fsCase`
        function persist(
          filePath: string,
          writer: { inner?: (nextPath: string) => Promise<void> },
          useJson: boolean,
        ) {
          if (useJson) {
            writer.inner = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          } else {
            writer.inner = (nextPath: string) => fs.writeFile(nextPath, "[]\\n");
          }
          return writer.inner?.(filePath);
        }
        await persist("sessions.json", {}, true);
      `("nested-object-wrapper-parameter-branch-assignment.ts", filesystemWriteViolations(15)),
      "keeps wrapper object property paths after for-of reassignment": atomicPersistCase`
          for (const item of items) {
            params.filePath = currentSqlitePath;
          }
          return writeTextAtomic(params.filePath, "{}\\n");
      `("for-of-reassigned-wrapper-property-options.ts", filesystemWriteViolations(9)),
      "clears wrapper object parameter paths after exhaustive current-object assignments":
        atomicPersistCase`
          if (ready) params = { filePath: currentSqlitePath };
          else params = { filePath: currentSqlitePath };
          return writeTextAtomic(params.filePath, "{}\\n");
      `("exhaustive-current-wrapper-object-options.ts", []),
      "flags wrapper option paths written through bracketed body-local fs object aliases":
        fsPromisesPersistCase`
          const writer = { writeFile: fs.writeFile };
          return writer["writeFile"](params.filePath, "{}\\n");
      `("body-local-bracket-fs-object-alias-wrapper.ts", filesystemWriteViolations(7)),
      "flags wrapper option paths written through outer fs module object aliases": fsPromisesCase`
        const deps = { fs };
        function persist(params: { filePath: string }) {
          return deps.fs.writeFile(params.filePath, "{}\\n");
        }
        persist({ filePath: "sessions.json" });
      `("wrapper-outer-fs-module-object-alias.ts", filesystemWriteViolations(7)),
      "flags wrapper options forwarded to filePath helper objects": sourceCase`
        import { appendRegularFile, replaceFileAtomic } from "../infra/fs-safe.js";
        function append(options: { filePath: string; content: string }) {
          return appendRegularFile(options);
        }
        function replace(options: { filePath: string; content: string }) {
          return replaceFileAtomic(options);
        }
        append({ filePath: "sessions.json", content: "{}\\n" });
        replace({ filePath: "plugin-state/state.sqlite", content: "" });
      `("forwarded-filepath-helper-options.ts", filesystemWriteViolations(9, 10)),

      // Object-backed wrapper discovery and alias tracking.
      "keeps fs-safe store aliases copied into their own descendant": privateStoreCase`
        const stores = { state: privateFileStore(stateDir) };
        stores.child = { ...stores };
        await stores.child.state.writeJson("thread-bindings.json", {});
      `("descendant-fs-safe-store-spread.ts", filesystemWriteViolations(5)),
      "keeps wrapper aliases copied into their own descendant": fsCase`
        const writer = {
          save(filePath) {
            return fs.writeFile(filePath, "");
          },
        };
        writer.child = { nested: writer };
        await writer.child.nested.save("sessions.json");
      `("descendant-wrapper-object-alias.ts", filesystemWriteViolations(9)),
      "flags object wrapper methods copied through property access aliases": fsPersistCase`
          const writer = {
            save(nextPath: string) {
              return fs.writeFile(nextPath, "{}\\n");
            },
          };
          const proxy = { save: writer.save };
          return proxy.save(filePath);
      `("object-wrapper-property-access-alias.ts", filesystemWriteViolations(12)),
      "flags nested object wrapper methods copied through property access spreads": atomicCase`
        const writer: any = {
          nested: {
            save(params: { filePath: string }) {
              return writeTextAtomic(params.filePath, "{}\\n");
            },
          },
        };
        const copy = { ...writer.nested };
        await copy.save({ filePath: "sessions.json" });
      `("nested-object-wrapper-property-access-spread.ts", filesystemWriteViolations(11)),
      "does not use destructured wrapper defaults after unknown spreads": fsCase`
        function persist(filePath: string, options: { save?: () => Promise<void> }) {
          const writer = { save: undefined, ...options };
          const { save = () => fs.writeFile(filePath, "{}\\n") } = writer;
          return save();
        }
        await persist("sessions.json", { save: async () => {} });
      `("object-wrapper-destructuring-default-unknown-spread.ts", []),
      "keeps branch-only property assigned object wrapper methods after exhaustive merge": fsCase`
        function persist(filePath: string, enabled: boolean) {
          let writer = {};
          if (enabled) {
            writer.save = () => fs.writeFile(filePath, "{}\\n");
          } else {
            writer = {};
          }
          return writer.save?.();
        }
        await persist("sessions.json", true);
      `("branch-only-property-object-wrapper-method.ts", filesystemWriteViolations(12)),
      "keeps prior nested wrapper values when only one branch assigns": fsCase`
        function persist(filePath: string, disabled: boolean) {
          let save = (nextPath: string) => fs.writeFile(nextPath, "{}\\n");
          if (disabled) {
            save = async () => {};
          } else {
          }
          return save(filePath);
        }
        await persist("sessions.json", false);
      `("prior-wrapper-value-branch-assignment.ts", filesystemWriteViolations(11)),
      "copies unknown computed property facts through object spreads": writeFileCase`
        declare const key: string;
        const base = { [key]: "sessions.json" };
        function persist(params: Record<string, string>) {
          return writeFile(params[key], "{}\\n");
        }
        persist({ ...base });
      `("spread-unknown-computed-property.ts", filesystemWriteViolations(8)),
      "retains a conservative fallback for computed key cross products": {
        source: [
          'import { writeFile } from "node:fs/promises";',
          `let outerKey; ${Array.from(
            { length: 5 },
            (_, index) =>
              `${index === 0 ? "" : "else "}if (outer${index}) outerKey = "outer${index}";`,
          ).join(" ")} else outerKey = "paths";`,
          `let innerKey; ${Array.from(
            { length: 5 },
            (_, index) =>
              `${index === 0 ? "" : "else "}if (inner${index}) innerKey = "inner${index}";`,
          ).join(" ")} else innerKey = "filePath";`,
          'function persist(params) { return writeFile(params[outerKey][innerKey], "{}\\n"); }',
          'persist({ paths: { filePath: "sessions.json" } });',
        ].join("\n"),
        filename: "src/runtime/computed-key-cross-product-cap.ts",
        expected: filesystemWriteViolations(5),
      },
      "keeps outer computed-key facts visible through loop property overlays": writeFileCase`
        declare const key: string;
        function persist(params: { filePath: string }, key: string) {
          while (ready) {
            params.currentPath = "state/openclaw.sqlite";
            return writeFile(params[key], "{}\\n");
          }
        }
        persist({ filePath: "sessions.json" }, key);
      `("loop-computed-key-overlay.ts", filesystemWriteViolations(10)),
      "keeps outer computed-key facts visible through try property overlays": writeFileCase`
        declare const key: string;
        function persist(params: { filePath: string }, key: string) {
          try {
            params.currentPath = "state/openclaw.sqlite";
            return writeFile(params[key], "{}\\n");
          } catch {}
        }
        persist({ filePath: "sessions.json" }, key);
      `("try-computed-key-overlay.ts", filesystemWriteViolations(10)),
      "keeps nested computed-key facts visible through property overlays": writeFileCase`
        declare const key: string;
        function persist(params: { paths: { filePath: string } }, key: string) {
          if (ready) {
            params.paths.currentPath = "state/openclaw.sqlite";
            return writeFile(params.paths[key], "{}\\n");
          }
        }
        persist({ paths: { filePath: "sessions.json" } }, key);
      `("nested-computed-key-overlay.ts", filesystemWriteViolations(10)),
      "expands wrapper spread arguments from tuple bindings": writeFileOptionsCase`
        const args = [{ filePath: "sessions.json" }] as const;
        persist(...args);
      `("tuple-spread-wrapper-argument.ts", filesystemWriteViolations(7)),
      "preserves wrapper positions through prefixed nested spreads": writeFileCase`
        function persist(label: string, params: { filePath: string }) {
          return writeFile(params.filePath, "{}\\n");
        }
        const params = { filePath: "sessions.json" };
        persist("state", ...[...[params]]);
      `("prefixed-nested-spread-wrapper-argument.ts", filesystemWriteViolations(7)),
      "merges object facts across conditional wrapper arguments": writeFileOptionsCase`
        persist(ready ? { filePath: "sessions.json" } : { filePath: currentPath });
      `("conditional-wrapper-argument.ts", filesystemWriteViolations(6)),
      "forwards awaited resolved wrapper arguments": writeFileOptionsCase`
        const params = { filePath: "sessions.json" };
        await persist(await Promise.resolve(params));
      `("awaited-wrapper-argument.ts", filesystemWriteViolations(7)),
      "forwards proxied wrapper arguments": writeFileOptionsCase`
        const params = { filePath: "sessions.json" };
        persist(new Proxy(params, {}));
      `("proxied-wrapper-argument.ts", filesystemWriteViolations(7)),
      "preserves filesystem writer aliases beyond the fact alternative cap": {
        source: [
          'import { writeFile } from "node:fs/promises";',
          'function invoke(callback, filePath) { return callback(filePath, "{}\\n"); }',
          `invoke(${Array.from(
            { length: 32 },
            (_, index) => `condition${index} ? safe${index} : `,
          ).join("")}writeFile, "sessions.json");`,
        ].join("\n"),
        filename: "src/runtime/truncated-filesystem-writer-fact.ts",
        expected: filesystemWriteViolations(3),
      },
      "does not merge branch-local computed property effects after their scope exits": sourceCase`
        function update(groupId: string) {
          if (named) {
            const groups = {};
            groups[groupId] = {};
          } else {
            const groups = {};
            groups[groupId] = {};
          }
        }
        update(event.groupId ?? "");
      `("branch-local-computed-property-effects.ts", []),
      "applies legacy object defaults to possibly undefined arguments": writeFileCase`
        function persist(params = { filePath: "sessions.json" }) {
          return writeFile(params.filePath, "{}\\n");
        }
        const params = { filePath: currentPath };
        persist(ready ? undefined : params);
      `("legacy-object-parameter-default.ts", filesystemWriteViolations(7)),
      "flags legacy paths written through injected fs handles": sourceCase`
        const storePath = "sessions.json";
        const params: { deps: { fs: typeof import("node:fs") } } = { deps };
        await params.deps.fs.promises.writeFile(storePath, "{}\\n");
      `("injected-fs-write.ts", filesystemWriteViolations(4)),
      "does not let for-loop object bindings clear outer object metadata": atomicCase`
        const params = { filePath: "sessions.json" };
        for (const params = { filePath: currentSqlitePath }; ready; advance()) {
          await use(params);
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `("for-loop-object-shadow.ts", filesystemWriteViolations(7)),
      "keeps object metadata when one exhaustive branch keeps a legacy object": atomicCase`
        let params = { filePath: "sessions.json" };
        if (ready) {
          params = { filePath: currentSqlitePath };
        } else {
          params = { filePath: "sessions.json" };
        }
        writeTextAtomic(params.filePath, "{}\\n");
      `("exhaustive-mixed-object.ts", filesystemWriteViolations(9)),
      "flags nested defaults after conditional whole-object rewrites from known aliases":
        atomicCase`
        function persist({ paths: { filePath = "sessions.json" } }: { paths: { filePath?: string } }) {
          return writeTextAtomic(filePath, "{}\\n");
        }
        const source = { paths: {} };
        let options = { paths: { filePath: currentSqlitePath } };
        if (ready) {
          options = source;
        }
        await persist(options);
      `("conditional-whole-object-rewrite-alias-nested-default.ts", filesystemWriteViolations(11)),
      "clears nested wrapper option paths after object literal spread overwrites": fsCase`
        function persist({ paths: { filePath = currentSqlitePath } = {} }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const params = {
          paths: { filePath: "sessions.json" },
          ...{ paths: {} },
        };
        await persist(params);
      `("wrapper-option-path-object-spread-overwrite.ts", []),
      "clears known nested wrapper option paths after parent rewrites": fsCase`
        declare function loadNested(): { filePath?: string };
        function persist({ paths: { nested: { filePath = "sessions.json" } = {} } }) {
          return fs.writeFile(filePath, "{}\\n");
        }
        const options = { paths: { nested: {} } };
        options.paths = { nested: loadNested() };
        await persist(options);
      `("wrapper-option-path-parent-rewrite-unknown-nested.ts", []),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(...parseFixture(source, filename));

    expect(violations).toEqual(expected);
  });

  it("keeps legacy PortGuardian filenames inside the native migration owner", () => {
    const runtimeViolations = collectDatabaseFirstNativeLegacyStoreViolations(
      'let path = root.appendingPathComponent("port-guard.json")\n',
      "apps/macos/Sources/OpenClaw/PortGuardian.swift",
    );
    const migrationViolations = collectDatabaseFirstNativeLegacyStoreViolations(
      'let path = root.appendingPathComponent("port-guard.json")\n',
      "apps/macos/Sources/OpenClaw/PortGuardianRecordStore.swift",
    );

    expect(runtimeViolations).toEqual([{ kind: "legacy PortGuardian file reference", line: 1 }]);
    expect(migrationViolations).toEqual([]);
  });

  // Doctor, plugin, QA, and transcript owner boundaries.
  it.each(
    namedCases({
      "flags legacy transcript bridge markers in runtime source": sourceCase`
        export const transcriptLocator = "sqlite-transcript://session";
        export const dynamicLocator = \`sqlite-transcript://\${sessionId}\`;
      `("transcript-bridge.ts", [
        { kind: "legacy transcript bridge marker", line: 2 },
        { kind: "legacy transcript bridge marker", line: 3 },
      ]),
    }),
  )("$name", ({ source, filename, expected }) => {
    const violations = collectDatabaseFirstLegacyStoreViolations(...parseFixture(source, filename));

    expect(violations).toEqual(expected);
  });
});
