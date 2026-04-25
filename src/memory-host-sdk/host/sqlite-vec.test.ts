import { describe, expect, it, vi } from "vitest";
import { loadSqliteVecExtension } from "./sqlite-vec.js";

describe("loadSqliteVecExtension", () => {
  it("loads an explicit extension path without requiring the sqlite-vec package", async () => {
    const db = {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
    };

    await expect(
      loadSqliteVecExtension({
        db: db as never,
        extensionPath: "/opt/openclaw/sqlite-vec.dylib",
      }),
    ).resolves.toEqual({ ok: true, extensionPath: "/opt/openclaw/sqlite-vec.dylib" });

    expect(db.enableLoadExtension).toHaveBeenCalledWith(true);
    expect(db.loadExtension).toHaveBeenCalledWith("/opt/openclaw/sqlite-vec.dylib");
  });
});
