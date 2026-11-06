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
