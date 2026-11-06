import childProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { probeSqliteDatabaseHeaders } from "./sqlite-header-probe.js";

afterEach(() => vi.restoreAllMocks());

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
