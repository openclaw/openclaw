import { expect, it } from "vitest";
import {
  ensureSqliteLibrarySelected,
  mockBunSqliteNativeBoundary,
} from "./bun-sqlite-library.test-support.js";

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
