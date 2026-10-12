import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  invalidateSqliteCleanCloseSeal,
  readSqliteCleanCloseSeal,
  writeSqliteCleanCloseSeal,
} from "./sqlite-clean-close-seal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const verifiedAt = Date.parse("2026-10-11T12:00:00Z");
const proof = { verifiedAt, facts: { readiness: true, schemaVersion: 20 } };

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(verifiedAt);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fixture() {
  const pathname = path.join(tempDirs.make("sqlite-clean-seal-"), "database.sqlite");
  // The seal's file-state contract does not require a native SQLite connection.
  fs.writeFileSync(pathname, "synthetic database bytes");
  const stat = () => fs.statSync(pathname, { bigint: true });
  const read = (schemaIdentity = "state:20") =>
    readSqliteCleanCloseSeal(pathname, schemaIdentity, stat());
  expect(writeSqliteCleanCloseSeal(pathname, "state:20", stat(), proof)).toBe(true);
  return { pathname, stat, read };
}

describe("SQLite clean-close seals", () => {
  it("persists validated facts until the first write invalidates them", () => {
    const { pathname, read } = fixture();
    expect(read()).toEqual(proof);
    invalidateSqliteCleanCloseSeal(pathname);
    expect(read()).toBeUndefined();
    expect(() => invalidateSqliteCleanCloseSeal(pathname)).not.toThrow();
  });

  it.each(["truncated", "changed-payload", "invalid-envelope"])(
    "falls back to full validation after a %s seal",
    (damage) => {
      const { pathname, read } = fixture();
      const contents = fs.readFileSync(`${pathname}.seal`, "utf8");
      fs.writeFileSync(
        `${pathname}.seal`,
        damage === "truncated"
          ? contents.slice(0, contents.length / 2)
          : damage === "changed-payload"
            ? contents.replace('readiness\\":true', 'readiness\\":false')
            : "[]",
      );
      expect(read()).toBeUndefined();
    },
  );

  it.each(["contents", "timestamp", "replacement"])("rejects external %s changes", (change) => {
    const { pathname, read } = fixture();
    if (change === "contents") {
      fs.appendFileSync(pathname, " changed");
    } else if (change === "timestamp") {
      fs.utimesSync(pathname, 1, 2);
    } else {
      const displaced = `${pathname}.old`;
      fs.renameSync(pathname, displaced);
      fs.copyFileSync(displaced, pathname);
    }
    expect(read()).toBeUndefined();
  });

  it.each(["-wal", "-journal"])("requires absent or empty %s files", (suffix) => {
    const { pathname, stat, read } = fixture();
    fs.writeFileSync(`${pathname}${suffix}`, "");
    expect(read()).toEqual(proof);
    fs.writeFileSync(`${pathname}${suffix}`, "uncheckpointed pages");
    expect(read()).toBeUndefined();
    expect(writeSqliteCleanCloseSeal(pathname, "state:20", stat(), proof)).toBe(false);
    expect(fs.existsSync(`${pathname}.seal`)).toBe(false);
  });

  it("requires the current schema identity and periodic full verification", () => {
    const { read } = fixture();
    expect(read("state:21")).toBeUndefined();
    vi.mocked(Date.now).mockReturnValue(verifiedAt + 7 * 24 * 60 * 60 * 1_000);
    expect(read()).toEqual(proof);
    vi.mocked(Date.now).mockReturnValue(verifiedAt + 7 * 24 * 60 * 60 * 1_000 + 1);
    expect(read()).toBeUndefined();
    vi.mocked(Date.now).mockReturnValue(verifiedAt - 1);
    expect(read()).toBeUndefined();
  });

  it("treats publication failure as a miss but refuses failed write invalidation", () => {
    const { pathname, stat, read } = fixture();
    fs.unlinkSync(`${pathname}.seal`);
    fs.mkdirSync(`${pathname}.seal`);
    expect(writeSqliteCleanCloseSeal(pathname, "state:20", stat(), proof)).toBe(false);
    expect(read()).toBeUndefined();
    expect(() => invalidateSqliteCleanCloseSeal(pathname)).toThrow();
  });
});
