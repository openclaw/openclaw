// Covers the SQLite WAL-reset corruption safety floor.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { setEnvironmentData } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  ensureSqliteLibrarySelected,
  mockBunSqliteNativeBoundary,
} from "./bun-sqlite-library.test-support.js";
import {
  openNodeSqliteDatabase,
  resolveExistingSqliteFileUri,
  resolveImmutableSqliteFileUri,
  resolveNodeSqliteLocation,
} from "./node-sqlite.js";

const originalPrepare = Reflect.get(DatabaseSync.prototype, "prepare") as DatabaseSync["prepare"];

async function loadNodeSqliteWithVersion(version: string, extensionLoadingOmitted?: number) {
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql,
  ) {
    if (
      sql ===
        "SELECT sqlite_version() AS version, sqlite_compileoption_used('OMIT_LOAD_EXTENSION') AS omitted" ||
      sql === "SELECT sqlite_version() AS version"
    ) {
      const statement = originalPrepare.call(this, sql);
      const capabilities = statement.get();
      vi.spyOn(statement, "get").mockReturnValue({
        ...capabilities,
        version,
        ...(extensionLoadingOmitted === undefined ? {} : { omitted: extensionLoadingOmitted }),
      });
      return statement;
    }
    return originalPrepare.call(this, sql);
  });
  return { ...(await import("./node-sqlite.js")), prepare };
}

async function withNodeSharedSqliteValue(value: unknown, run: () => Promise<void>): Promise<void> {
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, "config");
  if (!originalDescriptor) {
    throw new Error("process.config descriptor is unavailable");
  }
  try {
    // Node freezes process.config.variables, so replace and then restore its exact descriptor.
    Object.defineProperty(process, "config", {
      value: {
        ...process.config,
        variables: { ...process.config.variables, node_shared_sqlite: value },
      },
      writable: false,
      configurable: true,
    });
    await run();
  } finally {
    Object.defineProperty(process, "config", originalDescriptor);
  }
}

function expectedUnsafeSqliteError(version: string, shared: boolean): string {
  const wording = shared ? "uses shared system" : "embeds";
  const remediation = shared
    ? "Upgrade the system SQLite library to one of those safe versions, or use a Node build embedding a safe version."
    : "Upgrade to Node 24.16.0+ or 26.1.0+ before retrying.";
  return (
    "SQLite support is unavailable or unsafe in this Node runtime. " +
    "OpenClaw requires SQLite 3.51.3+, 3.50.7+ within 3.50.x, or 3.44.6+ within 3.44.x for WAL safety; " +
    `Node ${process.versions.node} ${wording} SQLite ${version}, which is affected by the upstream WAL-reset ` +
    `database corruption bug. ${remediation}`
  );
}

describe("node SQLite locations", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  it.each(["absolute", "relative"])(
    "writes existing %s URI-escaped paths without creating missing databases",
    (kind) => {
      const pathname = path.join(
        dirs.make(".sqlite-existing-uri-", kind === "relative" ? process.cwd() : undefined),
        "state ?#%.sqlite",
      );
      const uri =
        kind === "relative"
          ? `file:${path.relative(process.cwd(), pathname).split(path.sep).map(encodeURIComponent).join("/")}?mode=rw`
          : resolveExistingSqliteFileUri(pathname);
      expect(() => openNodeSqliteDatabase(uri)).toThrow();
      expect(fs.existsSync(pathname)).toBe(false);
      const initial = openNodeSqliteDatabase(uri.replace(/\?mode=rw$/u, ""));
      initial.exec("CREATE TABLE retained(value TEXT) STRICT");
      initial.close();
      const existing = openNodeSqliteDatabase(uri);
      try {
        existing.prepare("INSERT INTO retained(value) VALUES(?)").run("written");
        expect(existing.prepare("SELECT value FROM retained").all()).toEqual([
          { value: "written" },
        ]);
      } finally {
        existing.close();
      }
    },
  );
  it("preserves Windows long paths in non-creating writable URIs", () => {
    const pathname = String.raw`C:\deep state\openclaw.sqlite`;
    expect(resolveExistingSqliteFileUri(pathname, "win32")).toBe(
      `file:${encodeURIComponent(path.win32.toNamespacedPath(pathname))}?mode=rw`,
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["", ":memory:", "file:///tmp/openclaw.sqlite?mode=ro&immutable=1"])(
    "preserves special location %j",
    (location) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      expect(resolveNodeSqliteLocation(location)).toBe(location);
    },
  );

  it("keeps ordinary filesystem paths unchanged outside Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(resolveNodeSqliteLocation("relative/openclaw.sqlite")).toBe("relative/openclaw.sqlite");
  });

  it.each([
    ":memory:",
    "file::memory:",
    "file::memory:?cache=shared",
    "file:checkonce-memory?mode=memory&cache=shared",
  ])("opens in-memory location %s without creating a disk file", (location) => {
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((filename, flags, mode) => {
      // Keep the regression from leaving a literal :memory: file in the checkout.
      if (filename === ":memory:") {
        throw new Error("In-memory SQLite attempted to create a disk file");
      }
      return open(filename, flags, mode);
    });
    const database = openNodeSqliteDatabase(location, { timeout: 5000 });
    try {
      expect(database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
      const identity = " a\0🦞 ";
      expect(database.prepare("SELECT CAST(? AS TEXT) AS identity").get(identity)).toEqual({
        identity,
      });
    } finally {
      database.close();
    }
  });

  it("normalizes ordinary filesystem paths through the Windows VFS boundary", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const resolveSpy = vi.spyOn(path, "resolve").mockReturnValue("resolved-openclaw.sqlite");
    const namespacedSpy = vi
      .spyOn(path, "toNamespacedPath")
      .mockReturnValue(String.raw`\\?\C:\resolved-openclaw.sqlite`);

    expect(resolveNodeSqliteLocation("relative/openclaw.sqlite")).toBe(
      String.raw`\\?\C:\resolved-openclaw.sqlite`,
    );
    expect(resolveSpy).toHaveBeenCalledWith("relative/openclaw.sqlite");
    expect(namespacedSpy).toHaveBeenCalledWith("resolved-openclaw.sqlite");
  });

  it("keeps UNC and namespaced Windows paths on the Windows VFS path boundary", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const resolvedPaths = new Map([
      [
        String.raw`\\server\share\state\openclaw.sqlite`,
        String.raw`\\server\share\state\openclaw.sqlite`,
      ],
      ["//server/share/state/openclaw.sqlite", String.raw`\\server\share\state\openclaw.sqlite`],
      ["relative/openclaw.sqlite", String.raw`\\server\share\workdir\relative\openclaw.sqlite`],
      [
        String.raw`\\?\C:\deep\state\openclaw.sqlite`,
        String.raw`\\?\C:\deep\state\openclaw.sqlite`,
      ],
      [
        String.raw`\\?\UNC\server\share\state\openclaw.sqlite`,
        String.raw`\\?\UNC\server\share\state\openclaw.sqlite`,
      ],
    ]);
    const resolveSpy = vi.spyOn(path, "resolve").mockImplementation((pathname) => {
      return resolvedPaths.get(pathname) ?? pathname;
    });
    const namespacedSpy = vi
      .spyOn(path, "toNamespacedPath")
      .mockImplementation((pathname) => pathname);

    for (const [pathname, resolvedPath] of resolvedPaths) {
      expect(resolveNodeSqliteLocation(pathname)).toBe(resolvedPath);
    }
    expect(resolveSpy).toHaveBeenCalledTimes(resolvedPaths.size);
    expect(namespacedSpy).toHaveBeenCalledTimes(resolvedPaths.size);
  });

  it("preserves the Windows long-path namespace in immutable SQLite URIs", () => {
    const pathname = String.raw`C:\deep state\openclaw.sqlite`;
    const namespacedPath = String.raw`\\?\C:\deep state\openclaw.sqlite`;

    expect(resolveImmutableSqliteFileUri(pathname, "win32")).toBe(
      `file:${encodeURIComponent(namespacedPath)}?mode=ro&immutable=1`,
    );
  });
});

describe("node SQLite safety", () => {
  let inheritedAdmission: Parameters<typeof setEnvironmentData>[1];
  beforeEach(() => {
    const workerThreads = process.getBuiltinModule("node:worker_threads");
    inheritedAdmission = workerThreads.getEnvironmentData("openclaw.sqliteNativeRuntimeAdmission");
    // Observe the library independently of the test runner's earlier admission.
    workerThreads.setEnvironmentData("openclaw.sqliteNativeRuntimeAdmission", undefined);
    vi.resetModules();
  });

  afterEach(() => {
    process
      .getBuiltinModule("node:worker_threads")
      .setEnvironmentData("openclaw.sqliteNativeRuntimeAdmission", inheritedAdmission);
    vi.restoreAllMocks();
  });

  it.each([0, 1])(
    "detects the loaded library's extension capability (omitted=%s)",
    async (omitted) => {
      const { captureSqliteNativeRuntimeAdmission, supportsNodeSqliteExtensionLoading, prepare } =
        await loadNodeSqliteWithVersion("3.51.3", omitted);
      expect(captureSqliteNativeRuntimeAdmission()).toBeUndefined();
      expect(prepare).not.toHaveBeenCalled();
      expect(supportsNodeSqliteExtensionLoading()).toBe(omitted === 0);
      expect(captureSqliteNativeRuntimeAdmission()).toMatchObject({
        version: "3.51.3",
        extensionLoadingSupported: omitted === 0,
        iteratorBehavior: {
          nextAfterDoneIsTerminal: expect.any(Boolean),
          returnAfterDoneIsInert: expect.any(Boolean),
        },
      });
      expect(prepare).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { version: "3.51.3", jsonb: true, walNoop: false },
    { version: "3.52.0", jsonb: true, walNoop: false },
    { version: "3.53.0", jsonb: true, walNoop: true },
    { version: "4.0.0", jsonb: true, walNoop: true },
    { version: "3.50.7", jsonb: true, walNoop: false },
    { version: "3.44.6", jsonb: false, walNoop: false },
    { version: "3.44.7", jsonb: false, walNoop: false },
  ])(
    "accepts patched SQLite $version and reuses its JSONB and WAL capabilities",
    async ({ version, jsonb, walNoop }) => {
      const { requireNodeSqlite, supportsNodeSqliteJsonb, prepare } =
        await loadNodeSqliteWithVersion(version);
      const { readSqliteWalState } = await import("./sqlite-wal-checkpoint.js");
      expect(() => requireNodeSqlite()).not.toThrow();
      const queries = prepare.mock.calls.length;
      expect(queries).toBe(1);
      expect(supportsNodeSqliteJsonb()).toBe(jsonb);
      expect(supportsNodeSqliteJsonb()).toBe(jsonb);
      expect(prepare.mock.calls).toHaveLength(queries);
      const database = new DatabaseSync(":memory:");
      try {
        for (let observation = 0; observation < 2; observation++) {
          expect(readSqliteWalState(database) !== undefined).toBe(walNoop);
        }
        // WAL state remains fresh; only the already-admitted library capability is reused.
        expect(prepare.mock.calls.slice(queries).map(([sql]) => sql)).toEqual(
          walNoop ? ["PRAGMA main.wal_checkpoint(NOOP)", "PRAGMA main.wal_checkpoint(NOOP)"] : [],
        );
      } finally {
        database.close();
      }
    },
  );

  it.each(["3.51.2", "3.50.6", "3.49.1", "3.44.5", "invalid", "3.51"])(
    "rejects vulnerable or unknown SQLite %s",
    async (version) => {
      const { requireNodeSqlite } = await loadNodeSqliteWithVersion(version);
      expect(() => requireNodeSqlite()).toThrow(`SQLite ${version}, which is affected`);
    },
  );

  it.each([true, "true"])(
    "rejects vulnerable shared SQLite with system-library remediation (%j)",
    async (nodeSharedSqlite) => {
      await withNodeSharedSqliteValue(nodeSharedSqlite, async () => {
        const { requireNodeSqlite } = await loadNodeSqliteWithVersion("3.51.2");
        expect(() => requireNodeSqlite()).toThrow(expectedUnsafeSqliteError("3.51.2", true));
      });
    },
  );

  it.each([false, "false"])(
    "rejects vulnerable embedded SQLite with Node-upgrade remediation (%j)",
    async (nodeSharedSqlite) => {
      await withNodeSharedSqliteValue(nodeSharedSqlite, async () => {
        const { requireNodeSqlite } = await loadNodeSqliteWithVersion("3.51.2");
        expect(() => requireNodeSqlite()).toThrow(expectedUnsafeSqliteError("3.51.2", false));
      });
    },
  );

  it.each([
    "unchanged",
    "pid",
    "executable",
    "nodeVersion",
    "bunVersion",
    "library",
    "format",
    "malformed",
  ] as const)(
    "inherits admitted SQLite capabilities only for its original process and library (%s)",
    async (changed) => {
      const native = mockBunSqliteNativeBoundary({ isBun: false });
      const parent = await loadNodeSqliteWithVersion("3.44.6", 1);
      parent.requireNodeSqlite();
      const iteratorBehavior = parent.captureSqliteNativeRuntimeAdmission()?.iteratorBehavior;
      parent.prepare.mockRestore();
      const receiptKey = "openclaw.sqliteNativeRuntimeAdmission";
      const receipt = native.environment.get(receiptKey);
      if (changed !== "unchanged") {
        const value = receipt && typeof receipt === "object" ? receipt : {};
        const runtime = "runtime" in value ? value.runtime : undefined;
        native.environment.set(receiptKey, {
          ...value,
          ...(changed === "malformed"
            ? { extensionLoadingSupported: "yes" }
            : changed === "format"
              ? { format: 2 }
              : {
                  runtime: {
                    ...(runtime && typeof runtime === "object" ? runtime : {}),
                    [changed]: {
                      pid: process.pid + 1,
                      executable: `${process.execPath}.other`,
                      nodeVersion: "99.0.0",
                      bunVersion: "1.0.0",
                      library: {
                        source: "discovered",
                        path: "/other/sqlite.dylib",
                        version: "3.53.4",
                        extensionLoadingSupported: true,
                      },
                    }[changed],
                  },
                }),
        });
      }
      const forwarded = native.environment.get(receiptKey);
      native.environment.delete(receiptKey);
      parent.installSqliteNativeRuntimeAdmission(forwarded);
      expect(native.environment.get(receiptKey)).toEqual(
        changed === "unchanged" ? receipt : undefined,
      );
      native.environment.set(receiptKey, forwarded);
      native.mainThread = false;
      vi.resetModules();
      const worker = await loadNodeSqliteWithVersion("3.53.4", 0);
      expect(worker.supportsNodeSqliteJsonb()).toBe(changed !== "unchanged");
      expect(worker.supportsNodeSqliteExtensionLoading()).toBe(changed !== "unchanged");
      expect(worker.supportsNodeSqliteWalCheckpointNoop()).toBe(changed !== "unchanged");
      if (changed === "unchanged") {
        expect(worker.prepare).not.toHaveBeenCalled();
        expect(worker.captureSqliteNativeRuntimeAdmission()?.iteratorBehavior).toEqual(
          iteratorBehavior,
        );
      } else {
        expect(worker.prepare).toHaveBeenCalled();
      }
    },
  );

  it("applies the current WAL safety floor to inherited runtime admission", async () => {
    const native = mockBunSqliteNativeBoundary({ isBun: false });
    const parent = await loadNodeSqliteWithVersion("3.53.4", 0);
    parent.requireNodeSqlite();
    parent.prepare.mockRestore();
    const receiptKey = "openclaw.sqliteNativeRuntimeAdmission";
    const receipt = native.environment.get(receiptKey);
    const unsafeAdmission = {
      ...(receipt && typeof receipt === "object" ? receipt : {}),
      version: "3.51.2",
    };
    native.environment.delete(receiptKey);
    parent.installSqliteNativeRuntimeAdmission(unsafeAdmission);
    expect(native.environment.has(receiptKey)).toBe(false);
    native.environment.set(receiptKey, unsafeAdmission);
    expect(parent.captureSqliteNativeRuntimeAdmission()).toBeUndefined();
    native.mainThread = false;
    vi.resetModules();
    const worker = await loadNodeSqliteWithVersion("3.53.4", 0);
    expect(() => worker.requireNodeSqlite()).toThrow("SQLite 3.51.2, which is affected");
    expect(worker.prepare).not.toHaveBeenCalled();
  });
});

const homebrew = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
const intelHomebrew = "/usr/local/opt/sqlite/lib/libsqlite3.dylib";
const safeProbe = { version: "3.53.4", extensionLoadingSupported: true };

function fixture(overrides: Parameters<typeof mockBunSqliteNativeBoundary>[0] = {}) {
  const native = mockBunSqliteNativeBoundary(overrides);
  return { ...native, ensure: ensureSqliteLibrarySelected };
}

describe("Bun SQLite library selection", () => {
  it.each([
    { explicitPath: undefined, expected: "/env/sqlite.dylib" },
    { explicitPath: "/parent/sqlite.dylib", expected: "/parent/sqlite.dylib" },
  ])("honors explicit then environment priority ($expected)", ({ explicitPath, expected }) => {
    const f = fixture({ env: { OPENCLAW_SQLITE_LIBRARY: "  /env/sqlite.dylib  " } });
    expect(f.ensure({ explicitPath })).toEqual({ source: "env", path: expected, ...safeProbe });
    expect(f.probe).toHaveBeenCalledExactlyOnceWith(expected);
    expect(f.select).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each(["explicit", "env"])(
    "rejects an invalid %s override without selecting a library",
    (source) => {
      const libraryPath = "/missing/sqlite.dylib";
      const f = fixture({
        exists: vi.fn(() => false),
        probe: vi.fn(() => {
          throw new Error("dlopen failed");
        }),
        env: source === "env" ? { OPENCLAW_SQLITE_LIBRARY: libraryPath } : {},
      });
      expect(() => f.ensure(source === "explicit" ? { explicitPath: libraryPath } : {})).toThrow(
        `Cannot use SQLite library ${libraryPath}: missing file. Fix or unset OPENCLAW_SQLITE_LIBRARY; install a supported library with brew install sqlite.`,
      );
      expect(f.probe).toHaveBeenCalledExactlyOnceWith(libraryPath);
      expect(f.select).not.toHaveBeenCalled();
    },
  );

  it("reports the real defect of a loadable library that has no file on disk", () => {
    // Apple's SQLite is served from the dyld shared cache: dlopen succeeds, stat does not.
    const f = fixture({
      exists: vi.fn(() => false),
      probe: vi.fn(() => ({ ...safeProbe, extensionLoadingSupported: false })),
      env: { OPENCLAW_SQLITE_LIBRARY: "/usr/lib/libsqlite3.dylib" },
    });
    expect(() => f.ensure()).toThrow(
      "Cannot use SQLite library /usr/lib/libsqlite3.dylib: built with SQLITE_OMIT_LOAD_EXTENSION",
    );
    expect(f.select).not.toHaveBeenCalled();
  });

  it.each([
    {
      probe: () => {
        throw new Error("dlopen: incompatible architecture");
      },
      reason: "dlopen: incompatible architecture",
    },
    {
      probe: () => ({ ...safeProbe, version: "3.51.2" }),
      reason: "SQLite version 3.51.2 below the WAL safety floor",
    },
    {
      probe: () => ({ ...safeProbe, extensionLoadingSupported: false }),
      reason: "built with SQLITE_OMIT_LOAD_EXTENSION",
    },
  ])("reports override validation failure: $reason", ({ probe, reason }) => {
    const f = fixture({ env: { OPENCLAW_SQLITE_LIBRARY: "/custom/sqlite.dylib" }, probe });
    expect(() => f.ensure()).toThrow(`Cannot use SQLite library /custom/sqlite.dylib: ${reason}`);
    expect(f.select).not.toHaveBeenCalled();
  });

  it.each([
    { ...safeProbe, version: "3.51.2" },
    { ...safeProbe, extensionLoadingSupported: false },
  ])("skips unusable discovered libraries (%j)", (firstProbe) => {
    const f = fixture({
      probe: vi.fn().mockReturnValueOnce(firstProbe).mockReturnValue(safeProbe),
    });
    expect(f.ensure()).toEqual({ source: "discovered", path: intelHomebrew, ...safeProbe });
    expect(f.select).toHaveBeenCalledExactlyOnceWith(intelHomebrew);
  });

  it("skips missing and unloadable candidates and reaches MacPorts", () => {
    const f = fixture({
      env: { HOMEBREW_PREFIX: "/custom-brew" },
      exists: vi.fn(
        (libraryPath) => libraryPath !== "/custom-brew/opt/sqlite/lib/libsqlite3.dylib",
      ),
      probe: vi.fn((libraryPath) => {
        if (libraryPath !== "/opt/local/lib/libsqlite3.dylib") {
          throw new Error("dlopen failed");
        }
        return safeProbe;
      }),
    });
    expect(f.ensure()).toEqual({
      source: "discovered",
      path: "/opt/local/lib/libsqlite3.dylib",
      ...safeProbe,
    });
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it("prefers HOMEBREW_PREFIX and memoizes the selection without probing again", () => {
    const f = fixture({ env: { HOMEBREW_PREFIX: "/custom-brew" } });
    const selected = f.ensure();
    expect(selected).toEqual({
      source: "discovered",
      path: "/custom-brew/opt/sqlite/lib/libsqlite3.dylib",
      ...safeProbe,
    });
    expect(f.ensure({ explicitPath: "/different.dylib" })).toBe(selected);
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it("keeps the runtime default when no library exists, including a blank override", () => {
    const f = fixture({
      exists: vi.fn(() => false),
      probe: vi.fn(() => {
        throw new Error("dlopen failed");
      }),
      env: { OPENCLAW_SQLITE_LIBRARY: "  " },
    });
    const selection = f.ensure();
    expect(selection).toEqual({ source: "runtime" });
    expect(f.ensure()).toBe(selection);
    expect(f.exists).toHaveBeenCalledTimes(3);
    expect(f.probe).toHaveBeenCalledTimes(3);
    expect(f.select).not.toHaveBeenCalled();
  });

  it("never retries the one-shot hook after a selection failure", () => {
    const f = fixture({
      select: vi.fn(() => {
        throw new Error("SQLite already loaded");
      }),
    });
    expect(() => f.ensure()).toThrow(
      `Cannot use SQLite library ${homebrew}: SQLite already loaded`,
    );
    expect(() => f.ensure()).toThrow("SQLite already loaded");
    expect(f.probe).toHaveBeenCalledTimes(1);
    expect(f.select).toHaveBeenCalledTimes(1);
  });

  it.each([
    { isBun: false, platform: "darwin" },
    { isBun: true, platform: "linux" },
    { isBun: true, platform: "win32" },
  ])("leaves unsupported runtimes untouched (%j)", (runtime) => {
    for (const env of [{}, { OPENCLAW_SQLITE_LIBRARY: "/custom/sqlite.dylib" }]) {
      const f = fixture({ ...runtime, env });
      expect(f.ensure()).toEqual(
        env.OPENCLAW_SQLITE_LIBRARY
          ? { source: "runtime", ignoredOverride: "OPENCLAW_SQLITE_LIBRARY requires Bun on macOS" }
          : { source: "runtime" },
      );
      expect(f.exists).not.toHaveBeenCalled();
      expect(f.probe).not.toHaveBeenCalled();
      expect(f.select).not.toHaveBeenCalled();
    }
  });
});
