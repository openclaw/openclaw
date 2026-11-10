import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { standaloneManifestFixture } from "../daemon/standalone-manifest.test-support.js";
import {
  ensureSqliteLibrarySelected,
  mockBunSqliteNativeBoundary,
} from "./bun-sqlite-library.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it("selects bundled SQLite from a renamed standalone executable in generic mode", () => {
  const root = directories.make("sqlite-generic-sidecar-");
  const executable = path.join(root, "renamed-openclaw");
  const bundled = path.join(root, "runtime", "lib", "libsqlite3.dylib");
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify(standaloneManifestFixture("aot", "renamed-openclaw", "1", "1")),
  );
  const native = mockBunSqliteNativeBoundary();
  const originalExecutable = process.execPath;
  try {
    process.execPath = executable;
    expect(ensureSqliteLibrarySelected()).toMatchObject({ source: "bundled", path: bundled });
    expect(native.select).toHaveBeenCalledExactlyOnceWith(bundled);
  } finally {
    process.execPath = originalExecutable;
  }
});

it.each([undefined, "/operator/libsqlite3.dylib"])(
  "keeps external-runtime artifact selection behind the operator override %s",
  (override) => {
    const native = mockBunSqliteNativeBoundary({
      env: { OPENCLAW_SQLITE_LIBRARY: override },
    });
    const selected = ensureSqliteLibrarySelected({ standaloneRoot: "/artifact/runtime" });
    const expected = override ?? "/artifact/runtime/lib/libsqlite3.dylib";
    expect(selected).toMatchObject({ source: override ? "env" : "bundled", path: expected });
    expect(native.select).toHaveBeenCalledExactlyOnceWith(expected);
    expect(native.probe).toHaveBeenCalledExactlyOnceWith(expected);
  },
);
