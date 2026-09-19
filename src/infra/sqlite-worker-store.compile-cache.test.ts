import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockNodeBuiltinModule } from "../plugin-sdk/test-helpers/node-builtin-mocks.js";
import { openSqliteWorkerStore } from "./sqlite-worker-store.js";

const { getCompileCacheDir } = vi.hoisted(() => ({
  getCompileCacheDir: vi.fn<() => string | undefined>(),
}));
// Cache enablement cannot be reversed in Vitest; the worker observes Node's real API.
vi.mock("node:module", async (importOriginal) =>
  mockNodeBuiltinModule(() => importOriginal<typeof import("node:module")>(), {
    getCompileCacheDir,
  }),
);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

describe.skipIf(Boolean(process.versions.bun))("SQLite store worker compile cache", () => {
  it.each([
    { label: "active programmatic cache", active: true, cache: undefined, disable: undefined },
    { label: "explicit cache", active: true, cache: "explicit", disable: undefined },
    { label: "empty explicit cache", active: true, cache: "", disable: undefined },
    { label: "disabled cache", active: true, cache: undefined, disable: "1" },
    { label: "empty disable policy", active: true, cache: undefined, disable: "" },
    { label: "disabled explicit cache", active: true, cache: "explicit", disable: "1" },
    { label: "unavailable cache", active: false, cache: undefined, disable: undefined },
  ] as const)("preserves $label through worker retirement", async ({ active, cache, disable }) => {
    const root = tempDirs.make("openclaw-sqlite-store-cache-");
    const activeDirectory = path.join(root, "active");
    const explicitDirectory = path.join(root, "explicit");
    fs.mkdirSync(activeDirectory);
    fs.mkdirSync(explicitDirectory);
    const inheritedCache = cache === "explicit" ? explicitDirectory : cache;
    vi.stubEnv("NODE_COMPILE_CACHE", inheritedCache);
    vi.stubEnv("NODE_DISABLE_COMPILE_CACHE", disable);
    getCompileCacheDir.mockReturnValue(active ? activeDirectory : undefined);
    const modulePath = path.join(root, "backend.mjs");
    fs.writeFileSync(
      modulePath,
      `import { getCompileCacheDir } from "node:module";
       import { DatabaseSync } from "node:sqlite";
       export function createSqliteWorkerBackend(_input, context) {
         const database = new DatabaseSync(context.databasePath);
         return {
           execute() { return getCompileCacheDir(); },
           close() { database.close(); }
         };
       }`,
    );
    const store = await openSqliteWorkerStore<{
      directory: { input: undefined; output: string | undefined };
    }>({
      moduleUrl: pathToFileURL(modulePath),
      databasePath: path.join(root, "store.sqlite"),
      input: undefined,
    });
    const expectedDirectory =
      disable === undefined
        ? cache === "explicit"
          ? explicitDirectory
          : active && cache === undefined
            ? activeDirectory
            : undefined
        : undefined;
    try {
      const directory = await store.execute({ type: "directory", input: undefined });
      if (expectedDirectory) {
        expect(directory?.startsWith(expectedDirectory + path.sep)).toBe(true);
      } else {
        expect(directory).toBeUndefined();
      }
    } finally {
      await store.close();
    }
    const hasCacheFiles = (directory: string) =>
      fs
        .readdirSync(directory, { recursive: true, withFileTypes: true })
        .some((entry) => entry.isFile());
    expect(hasCacheFiles(activeDirectory)).toBe(expectedDirectory === activeDirectory);
    expect(hasCacheFiles(explicitDirectory)).toBe(expectedDirectory === explicitDirectory);
    expect(process.env.NODE_COMPILE_CACHE).toBe(inheritedCache);
    expect(process.env.NODE_DISABLE_COMPILE_CACHE).toBe(disable);
  });
});
