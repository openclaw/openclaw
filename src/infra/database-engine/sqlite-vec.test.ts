import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";

const platformPackage = `sqlite-vec-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const variantPath = `/install/node_modules/${platformPackage}/vec0.so`;

function mockMissingSqliteVecPackage(): void {
  vi.doMock("sqlite-vec", () => {
    const err = new Error("Cannot find package 'sqlite-vec' imported from sqlite-vec.test.ts");
    Object.assign(err, { code: "ERR_MODULE_NOT_FOUND" });
    throw err;
  });
}

function mockFailingSqliteVecPackage(): void {
  vi.doMock("sqlite-vec", () => ({
    getLoadablePath: () => {
      throw new Error("bundled sqlite-vec load failed");
    },
  }));
}

function mockPlatformVariantResolver(extensionPath: string | undefined): void {
  vi.doMock("node:module", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:module")>();
    return {
      createRequire: (filename: Parameters<typeof actual.createRequire>[0]) => {
        const require = actual.createRequire(filename);
        const resolve = require.resolve;
        require.resolve = Object.assign((id: string, options?: { paths?: string[] }) => {
          if (!id.startsWith("sqlite-vec-")) {
            return resolve(id, options);
          }
          if (!extensionPath) {
            throw new Error("native package absent");
          }
          return extensionPath;
        }, resolve);
        return require;
      },
    };
  });
}

function createDbMock(params?: { readonly healthError?: Error }) {
  const get = vi.fn(() => ({ version: "v0.1.9" }));
  const prepare = vi.fn(() => {
    if (params?.healthError) {
      throw params.healthError;
    }
    return { get };
  });
  return {
    db: {
      isOpen: true,
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
      prepare,
    },
    prepare,
  };
}

async function loadMock(
  options: { healthError?: Error; loadError?: Error; extensionPath?: string } = {},
) {
  const { loadSqliteVecExtension } = await import("./sqlite-vec.js");
  const { db, prepare } = createDbMock(options);
  if (options.loadError) {
    db.loadExtension.mockImplementation(() => {
      throw options.loadError;
    });
  }
  const result = await loadSqliteVecExtension({
    db: db as never,
    extensionPath: options.extensionPath,
  });
  return { db, prepare, result };
}

afterEach(() => {
  vi.doUnmock("sqlite-vec");
  vi.doUnmock("node:module");
  vi.resetModules();
});

describe("loadSqliteVecExtension", () => {
  it("rejects a connection revoked while the native module imports", async () => {
    const started = createDeferred();
    const imported = createDeferred();
    vi.doMock("sqlite-vec", async () => {
      started.resolve();
      await imported.promise;
      return { getLoadablePath: () => "/fixture/vec0" };
    });
    mockPlatformVariantResolver(undefined);
    const { loadSqliteVecExtension } = await import("./sqlite-vec.js");
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    // Observe the unsafe call without crashing Node versions that dereference a closed handle.
    const enable = vi.spyOn(db, "enableLoadExtension").mockImplementation(() => {});
    const loading = loadSqliteVecExtension({ db });
    await started.promise;
    db.close();
    imported.resolve();

    const result = await loading;
    expect(enable).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("database is closed"),
    });
  });

  it("rejects a loaded extension when sqlite-vec functions are unavailable", async () => {
    mockMissingSqliteVecPackage();
    const { db, result } = await loadMock({
      healthError: new Error("no such function: vec_version"),
      extensionPath: "/opt/openclaw/sqlite-vec.so",
    });

    expect(result).toEqual({
      ok: false,
      error:
        "sqlite-vec health check failed after loading /opt/openclaw/sqlite-vec.so | no such function: vec_version",
    });
    expect(db.loadExtension).toHaveBeenCalledWith("/opt/openclaw/sqlite-vec.so");
    expect(db.enableLoadExtension).toHaveBeenLastCalledWith(false);
  });

  it("returns a valid memory.search extensionPath hint when sqlite-vec is absent", async () => {
    mockMissingSqliteVecPackage();
    mockPlatformVariantResolver(undefined);
    const { db, result } = await loadMock();

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(
        /^sqlite-vec package is not installed\. Set memory\.search\.store\.vector\.extensionPath, or an agent-specific memory\.search\.store\.vector\.extensionPath, to a sqlite-vec loadable extension path\. Original error: (?:\[vitest\] There was an error when mocking a module\. If you are using "vi\.mock" factory, make sure there are no top level variables inside, since this call is hoisted to top of the file\. Read more: https:\/\/vitest\.dev\/api\/vi\.html#vi-mock \| )?Cannot find package 'sqlite-vec' imported from sqlite-vec\.test\.ts \| ERR_MODULE_NOT_FOUND$/u,
      ),
    });
    expect(result.error).not.toContain("memory.store.vector.extensionPath");
    expect(db.enableLoadExtension).not.toHaveBeenCalled();
    expect(db.loadExtension).not.toHaveBeenCalled();
  });

  it("falls back to the platform variant when bundled sqlite-vec load fails", async () => {
    mockFailingSqliteVecPackage();
    mockPlatformVariantResolver(variantPath);
    const { db, prepare, result } = await loadMock();

    expect(result).toEqual({
      ok: true,
      extensionPath: variantPath,
    });
    expect(db.loadExtension).toHaveBeenCalledWith(variantPath);
    expect(prepare).toHaveBeenCalledWith("SELECT vec_version() AS version");
  });

  it("rejects a platform variant when sqlite-vec functions are unavailable", async () => {
    mockMissingSqliteVecPackage();
    mockPlatformVariantResolver(variantPath);
    const { result } = await loadMock({ healthError: new Error("no such function: vec_version") });

    expect(result).toEqual({
      ok: false,
      error: `sqlite-vec platform variant ${platformPackage} failed to load from /install/node_modules/${platformPackage}/vec0.so. Set memory.search.store.vector.extensionPath, or an agent-specific memory.search.store.vector.extensionPath, to a sqlite-vec loadable extension path. Original error: sqlite-vec health check failed after loading /install/node_modules/${platformPackage}/vec0.so | no such function: vec_version`,
    });
  });

  it("preserves bundled sqlite-vec and platform variant errors when both fail", async () => {
    mockFailingSqliteVecPackage();
    mockPlatformVariantResolver(variantPath);
    const { result } = await loadMock({ loadError: new Error("platform variant failed") });

    expect(result).toEqual({
      ok: false,
      error: `sqlite-vec package failed to load, and platform variant ${platformPackage} failed to load from /install/node_modules/${platformPackage}/vec0.so. Set memory.search.store.vector.extensionPath, or an agent-specific memory.search.store.vector.extensionPath, to a sqlite-vec loadable extension path. Package error: bundled sqlite-vec load failed. Variant error: platform variant failed`,
    });
  });
});
