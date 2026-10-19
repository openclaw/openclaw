import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  runSqliteReadOnlyWorker,
  runSqliteReadOnlyWorkerSync,
  withSqliteReadOnlyWorkerScope,
} from "./sqlite-readonly-worker.js";
import { withRetainedUpdateRuntime } from "./update-retained-runtime.js";

const fixture = vi.hoisted(() => ({ moduleUrl: "" }));
vi.mock("./runtime-process-entrypoints.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-process-entrypoints.js")>();
  const entry = (key: "sqliteReadOnly" | "sqliteSourceRevision") => ({
    ...actual.runtimeProcessEntrypoints[key],
    get currentModuleUrl() {
      return fixture.moduleUrl || actual.runtimeProcessEntrypoints[key].currentModuleUrl;
    },
  });
  return {
    ...actual,
    runtimeProcessEntrypoints: {
      ...actual.runtimeProcessEntrypoints,
      sqliteReadOnly: entry("sqliteReadOnly"),
      sqliteSourceRevision: entry("sqliteSourceRevision"),
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  fixture.moduleUrl = "";
});

it("launches read-only workers from retained code after removing the loaded package", async () => {
  const base = await fs.realpath(tempDirs.make("sqlite-retained-generation-"));
  const root = path.join(base, "openclaw");
  await fs.mkdir(path.join(root, "dist/infra"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
  const modulePath = path.join(root, "dist/updater.mjs");
  await fs.writeFile(modulePath, "export const moduleUrl = import.meta.url;");
  const loaded: { moduleUrl: string } = await import(pathToFileURL(modulePath).href);
  fixture.moduleUrl = loaded.moduleUrl;
  const worker = `
import { fileURLToPath } from "node:url";
const location = fileURLToPath(import.meta.url);
const result = mode => mode === "content-version"
  ? { ok: true, contentVersion: "a".repeat(64) } : { ok: true, location };
if (process.argv[3] === "session") {
  process.on("message", message => {
    if (message === "close") process.disconnect();
    else process.send({ id: message.id, result: result(message.args[0]) });
  });
} else process.stdout.write(JSON.stringify(result(process.argv[3])));
`;
  for (const name of ["sqlite-readonly-location.worker", "sqlite-source-revision.worker"]) {
    await fs.writeFile(path.join(root, "dist/infra", `${name}.js`), worker);
  }
  const request = () => runSqliteReadOnlyWorker(base, { mode: "sync" });
  const retainedPaths: string[] = [];
  await withSqliteReadOnlyWorkerScope(async () => {
    expect(await request()).toBe(path.join(root, "dist/infra/sqlite-readonly-location.worker.js"));
    await withRetainedUpdateRuntime(loaded.moduleUrl, async (retain) => {
      await retain({ mutationRoots: [root], timeoutMs: 30_000, assertCurrent() {} });
      await fs.rm(root, { recursive: true });
      retainedPaths.push(
        runSqliteReadOnlyWorkerSync(base, undefined),
        await runSqliteReadOnlyWorker(base, { mode: "async" }),
        await request(),
      );
      expect(runSqliteReadOnlyWorkerSync(base, undefined, "content-version")).toBe("a".repeat(64));
      for (const workerPath of retainedPaths) {
        expect(workerPath.startsWith(root + path.sep)).toBe(false);
      }
    });
    for (const workerPath of retainedPaths) {
      expect(await fs.readFile(workerPath, "utf8")).toBe(worker);
    }
  });
});
