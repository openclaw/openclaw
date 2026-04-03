import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHotspotInputTexts } from "../../scripts/test-update-memory-hotspots-sources.mjs";

const tempFiles = [];

afterEach(() => {
  for (const tempFile of tempFiles.splice(0)) {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Ignore temp cleanup races in tests.
    }
  }
});

describe("test-update-memory-hotspots source loading", () => {
  it("loads local log files with basename-derived source names", () => {
    const tempLog = path.join(os.tmpdir(), `openclaw-hotspots-${Date.now()}.log`);
    tempFiles.push(tempLog);
    fs.writeFileSync(tempLog, "local log");

    expect(loadHotspotInputTexts({ logPaths: [tempLog] })).toEqual([
      { sourceName: path.basename(tempLog, ".log"), text: "local log" },
    ]);
  });

  it("loads GitHub Actions job logs through gh", () => {
    const execFileSyncImpl = vi.fn(() => "remote log");

    expect(
      loadHotspotInputTexts({
        ghJobs: ["69804189668"],
        execFileSyncImpl,
      }),
    ).toEqual([{ sourceName: "gh-job-69804189668", text: "remote log" }]);
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "gh",
      ["run", "view", "--job", "69804189668", "--log"],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  });

  it("loads GitHub Actions run jobs and filters by job name", () => {
    const execFileSyncImpl = vi.fn((command, args) => {
      if (
        command === "gh" &&
        args[0] === "run" &&
        args[1] === "view" &&
        args[2] === "23933168654" &&
        args[3] === "--json" &&
        args[4] === "jobs"
      ) {
        return JSON.stringify({
          jobs: [
            { databaseId: 69804189668, name: "checks-fast-extensions-1" },
            { databaseId: 69804189669, name: "build-smoke" },
          ],
        });
      }
      if (command === "gh" && args[0] === "run" && args[1] === "view" && args[2] === "--job") {
        return `job-log-${args[3]}`;
      }
      throw new Error("unexpected gh call");
    });

    expect(
      loadHotspotInputTexts({
        ghRuns: ["23933168654"],
        ghRunJobMatches: ["extensions"],
        execFileSyncImpl,
      }),
    ).toEqual([{ sourceName: "gh-job-69804189668", text: "job-log-69804189668" }]);
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "gh",
      ["run", "view", "23933168654", "--json", "jobs"],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    const jobLogCalls = execFileSyncImpl.mock.calls.filter(
      (call) => call[0] === "gh" && call[1][2] === "--job",
    );
    expect(jobLogCalls).toEqual([
      [
        "gh",
        ["run", "view", "--job", "69804189668", "--log"],
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        },
      ],
    ]);
  });
});
