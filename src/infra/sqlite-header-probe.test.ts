import childProcess from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { shortenHomePath } from "../utils.js";
import { probeSqliteDatabaseHeaders } from "./sqlite-header-probe.js";
import { injectHeaderReadFailure } from "./sqlite-header-probe.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["EBUSY", "EPERM"])(
  "retries transient Windows %s reads without losing SQLite classification",
  async (code) => {
    const directory = tempDirs.make("sqlite-header-probe-");
    const candidate = path.join(directory, "candidate.db");
    await fs.writeFile(candidate, "SQLite format 3\0");
    const trace = await injectHeaderReadFailure(directory, candidate, code, 2);
    expect(probeSqliteDatabaseHeaders([candidate]).get(candidate)).toBe(true);
    expect(await trace()).toEqual({ reads: 3, delays: [50, 100] });
  },
);

it.each([
  ["EBUSY", "win32", 3],
  ["EPERM", "win32", 3],
  ["EACCES", "win32", 1],
  ["EIO", "win32", 1],
  ["EBUSY", "linux", 1],
] as const)("names the path and %s on %s after bounded reads", async (code, platform, reads) => {
  const directory = tempDirs.make("sqlite-header-probe-");
  vi.stubEnv("OPENCLAW_HOME", directory);
  const candidate = path.join(directory, "unreadable.db");
  await fs.writeFile(candidate, "SQLite format 3\0");
  const trace = await injectHeaderReadFailure(directory, candidate, code, 100, platform);
  let failure: unknown;
  try {
    probeSqliteDatabaseHeaders([candidate]);
  } catch (error) {
    failure = error;
  }
  if (!(failure instanceof Error)) {
    throw new Error("Expected an unreadable-source failure");
  }
  expect(failure.message).toContain(shortenHomePath(candidate));
  expect(failure.message).toContain(code);
  expect(failure.cause).toMatchObject({ code, path: candidate, errno: -4082 });
  expect(await trace()).toEqual({ reads, delays: reads === 3 ? [50, 100] : [] });
});

it.each(["ENOENT", "ELOOP"])("keeps %s classification without retrying", async (code) => {
  const directory = tempDirs.make("sqlite-header-probe-");
  const candidate = path.join(directory, "missing-or-link.db");
  await fs.writeFile(candidate, "SQLite format 3\0");
  const trace = await injectHeaderReadFailure(directory, candidate, code, 100);
  expect(probeSqliteDatabaseHeaders([candidate]).get(candidate)).toBe(false);
  expect(await trace()).toEqual({ reads: 1, delays: [] });
});

const child = { pid: 1, output: [], stderr: "" };
const answered = (...answers: boolean[]) => ({
  ...child,
  stdout: JSON.stringify(answers),
  status: 0,
  signal: null,
});
const failed = (code: string) => ({
  ...child,
  stdout: "",
  status: null,
  signal: "SIGTERM" as const,
  error: Object.assign(new Error(`spawnSync node ${code}`), { code }),
});

it.each([
  ["ETIMEDOUT", /timed out after 10000 ms while checking 4097 backup paths.*alternative-manual/u],
  ["ENOENT", /Check that the backup worker can run and the source files are readable/u],
] as const)("refuses an incomplete inventory on %s", (code, message) => {
  const failure = failed(code);
  vi.spyOn(childProcess, "spawnSync")
    .mockReturnValueOnce(answered(...Array.from({ length: 4096 }, () => false)))
    .mockReturnValue(failure);
  const paths = Array.from({ length: 4097 }, (_, index) => `/backup/file-${index}`);
  expect(() => probeSqliteDatabaseHeaders([...paths, paths[0]!])).toThrowError(
    expect.objectContaining({ cause: failure.error, message: expect.stringMatching(message) }),
  );
});

it("splits a batch that misses its deadline so slow storage still gets an answer", () => {
  const spawn = vi.spyOn(childProcess, "spawnSync").mockReturnValueOnce(failed("ETIMEDOUT"));
  spawn.mockReturnValueOnce(failed("ETIMEDOUT")).mockReturnValueOnce(answered(false, true));
  spawn.mockReturnValueOnce(answered(false)).mockReturnValueOnce(answered(false, true));
  const paths = ["/backup/a", "/backup/b.db", "/backup/c", "/backup/d", "/backup/e.db"];
  const expected = new Map(paths.map((pathname) => [pathname, pathname.endsWith("db")]));
  expect(probeSqliteDatabaseHeaders(paths)).toEqual(expected);
  expect(spawn).toHaveBeenCalledTimes(5);
});
