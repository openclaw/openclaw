import * as sqliteVec from "sqlite-vec";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSqliteVecExtension } from "./sqlite-vec.js";

vi.mock("sqlite-vec", () => ({
  getLoadablePath: vi.fn(() => "/auto/sqlite-vec"),
  load: vi.fn(),
}));

describe("loadSqliteVecExtension", () => {
  const sqliteVecMock = vi.mocked(sqliteVec);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createDbMock() {
    return {
      enableLoadExtension: vi.fn(),
      loadExtension: vi.fn(),
    };
  }

  it("loads explicit extension path via db.loadExtension", async () => {
    const db = createDbMock();

    const result = await loadSqliteVecExtension({
      db: db as never,
      extensionPath: "  /custom/sqlite-vec  ",
    });

    expect(result).toEqual({ ok: true, extensionPath: "/custom/sqlite-vec" });
    expect(db.enableLoadExtension).toHaveBeenCalledWith(true);
    expect(db.loadExtension).toHaveBeenCalledWith("/custom/sqlite-vec");
    expect(sqliteVecMock.load).not.toHaveBeenCalled();
  });

  it("uses sqlite-vec default loader when no extension path is provided", async () => {
    const db = createDbMock();

    const result = await loadSqliteVecExtension({ db: db as never });

    expect(result).toEqual({ ok: true, extensionPath: "/auto/sqlite-vec" });
    expect(db.enableLoadExtension).toHaveBeenCalledWith(true);
    expect(sqliteVecMock.getLoadablePath).toHaveBeenCalledTimes(1);
    expect(sqliteVecMock.load).toHaveBeenCalledWith(db);
    expect(db.loadExtension).not.toHaveBeenCalled();
  });

  it("returns error details when extension load fails", async () => {
    const db = createDbMock();
    sqliteVecMock.load.mockImplementationOnce(() => {
      throw new Error("extension load failed");
    });

    const result = await loadSqliteVecExtension({ db: db as never });

    expect(result).toEqual({ ok: false, error: "extension load failed" });
  });
});
