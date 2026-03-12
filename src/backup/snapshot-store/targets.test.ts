import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectCloudDriveTargets } from "./targets.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("detectCloudDriveTargets", () => {
  it("detects iCloud Drive and CloudStorage folders on macOS", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-snapshot-targets-"));
    tempDirs.push(home);
    await fs.mkdir(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), {
      recursive: true,
    });
    await fs.mkdir(path.join(home, "Library", "CloudStorage", "Dropbox"), {
      recursive: true,
    });

    const detected = await detectCloudDriveTargets({
      platform: "darwin",
      homeDir: home,
    });

    expect(detected.map((entry) => entry.label)).toEqual(
      expect.arrayContaining(["iCloud Drive", "Dropbox"]),
    );
    expect(detected[0]?.targetDir).toContain("OpenClaw Backups");
  });
});
