import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  invalidateSqliteCleanCloseSeal as invalidate,
  readSqliteCleanCloseSeal as readSeal,
  writeSqliteCleanCloseSeal as writeSeal,
} from "./sqlite-clean-close-seal.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const verifiedAt = Date.parse("2026-10-11T12:00:00Z");
const proof = { schemaIdentity: "state:20", verifiedAt, facts: true };

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(verifiedAt);
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const pathname = path.join(tempDirs.make("sqlite-clean-seal-"), "database.sqlite");
  // The seal's file-state contract does not require a native SQLite connection.
  fs.writeFileSync(pathname, "synthetic database bytes");
  const stat = () => fs.statSync(pathname, { bigint: true });
  const refusal = vi.fn();
  const read = () => readSeal(pathname, stat(), refusal);
  const write = () => writeSeal(pathname, "state:20", stat(), proof);
  const reject = (reason: string) => {
    expect(read()).toBeUndefined();
    expect(refusal).toHaveBeenLastCalledWith(reason);
  };
  expect(write()).toBe(true);
  return { pathname, read, write, reject };
}

function editSeal(pathname: string, edit: (contents: string) => string) {
  const seal = `${pathname}.seal`;
  fs.writeFileSync(seal, edit(fs.readFileSync(seal, "utf8")));
}

it.each([
  ["truncated", "malformed-proof", (p: string) => editSeal(p, (s) => s.slice(0, s.length / 2))],
  [
    "changed-payload",
    "malformed-proof",
    (p: string) => editSeal(p, (s) => s.replace('facts\\":true', 'facts\\":false')),
  ],
  ["invalid-envelope", "malformed-proof", (p: string) => editSeal(p, () => "[]")],
  ["contents", "file-mismatch", (p: string) => fs.appendFileSync(p, " changed")],
  ["timestamp", "file-mismatch", (p: string) => fs.utimesSync(p, 1, 2)],
  [
    "replacement",
    "file-mismatch",
    (p: string) => {
      fs.renameSync(p, `${p}.old`);
      fs.copyFileSync(`${p}.old`, p);
    },
  ],
] as const)("rejects %s damage", (_name, reason, damage) => {
  const { pathname, reject } = fixture();
  damage(pathname);
  reject(reason);
});

it.each(["-wal", "-journal"])("requires absent or empty %s files", (suffix) => {
  const { pathname, read, write, reject } = fixture();
  fs.writeFileSync(`${pathname}${suffix}`, "");
  expect(read()).toEqual(proof);
  fs.writeFileSync(`${pathname}${suffix}`, "uncheckpointed pages");
  reject("journal-present");
  expect(write()).toBe(false);
  expect(fs.existsSync(`${pathname}.seal`)).toBe(false);
});

it("requires periodic full verification", () => {
  const { read, reject } = fixture();
  vi.mocked(Date.now).mockReturnValue(verifiedAt + 7 * 24 * 60 * 60 * 1_000);
  expect(read()).toEqual(proof);
  vi.mocked(Date.now).mockReturnValue(verifiedAt + 7 * 24 * 60 * 60 * 1_000 + 1);
  reject("expired-proof");
  vi.mocked(Date.now).mockReturnValue(verifiedAt - 1);
  expect(read()).toBeUndefined();
});

it("treats publication failure as a miss but refuses failed write invalidation", () => {
  const { pathname, write, read, reject } = fixture();
  invalidate(pathname);
  reject("no-proof");
  invalidate(pathname);
  fs.mkdirSync(`${pathname}.seal`);
  expect(write()).toBe(false);
  expect(read()).toBeUndefined();
  expect(() => invalidate(pathname)).toThrow();
});
