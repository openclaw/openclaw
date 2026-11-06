import childProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { probeSqliteDatabaseHeaders } from "./sqlite-header-probe.js";

afterEach(() => vi.restoreAllMocks());

it.each(["ETIMEDOUT", "ENOENT"] as const)(
  "refuses an incomplete header inventory with actionable %s guidance",
  (code) => {
    const cause = Object.assign(new Error(`spawnSync node ${code}`), { code });
    vi.spyOn(childProcess, "spawnSync")
      .mockReturnValueOnce({
        pid: 1,
        output: [],
        stdout: JSON.stringify(Array.from({ length: 4096 }, () => false)),
        stderr: "",
        status: 0,
        signal: null,
      })
      .mockReturnValue({
        pid: 2,
        output: [],
        stdout: "",
        stderr: "",
        status: null,
        signal: "SIGTERM",
        error: cause,
      });
    const paths = Array.from({ length: 4097 }, (_, index) => `/backup/file-${index}`);
    expect(() => probeSqliteDatabaseHeaders([...paths, paths[0]!])).toThrowError(
      expect.objectContaining({
        cause,
        message:
          code === "ETIMEDOUT"
            ? expect.stringMatching(
                /SQLite header probe timed out after 10000 ms while checking 4097 backup paths\..*https:\/\/docs\.openclaw\.ai\/install\/updating\/update-methods#alternative-manual-npm-pnpm-or-bun/u,
              )
            : expect.stringContaining(
                "Check that the backup worker can run and the source files are readable",
              ),
      }),
    );
  },
);

it("splits a batch that misses its deadline so slow storage still gets an answer", () => {
  const error = Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" });
  const sizes: number[] = [];
  vi.spyOn(childProcess, "spawnSync").mockImplementation(((_file, _argv, options) => {
    const batch = JSON.parse(options?.input as string) as string[];
    sizes.push(batch.length);
    const base = { pid: 1, output: [], stderr: "" };
    return batch.length > 2
      ? { ...base, stdout: "", status: null, signal: "SIGTERM", error }
      : {
          ...base,
          stdout: JSON.stringify(batch.map((pathname) => pathname.endsWith("db"))),
          status: 0,
          signal: null,
        };
  }) as typeof childProcess.spawnSync);
  const paths = ["/backup/a", "/backup/b.db", "/backup/c", "/backup/d", "/backup/e.db"];
  expect([...probeSqliteDatabaseHeaders(paths)]).toEqual(
    paths.map((pathname) => [pathname, pathname.endsWith("db")]),
  );
  expect(sizes).toEqual([5, 3, 2, 1, 2]);
});
