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
});
