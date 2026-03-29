import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBuildInfo,
  resolveDisplayVersionMarker,
  writeBuildInfo,
} from "../../scripts/write-build-info.js";

const tempDirs: string[] = [];

async function makeTempRepo() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-build-info-"));
  tempDirs.push(rootDir);
  await fs.writeFile(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: "openclaw", version: "9.9.9-test" }),
    "utf8",
  );
  return rootDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("write-build-info", () => {
  it("prefers an explicit display version marker over inferred dirty state", () => {
    const execSyncImpl = vi.fn(() => Buffer.from(" M src/entry.ts\n"));

    expect(
      resolveDisplayVersionMarker({
        rootDir: "/tmp/openclaw",
        env: { OPENCLAW_DISPLAY_VERSION_MARKER: "harness-local" },
        execSyncImpl,
      }),
    ).toBe("harness-local");
    expect(execSyncImpl).not.toHaveBeenCalled();
  });

  it("marks dirty git builds when the worktree has local changes", () => {
    expect(
      resolveDisplayVersionMarker({
        rootDir: "/tmp/openclaw",
        env: {},
        execSyncImpl: vi.fn(() => Buffer.from("?? src/agents/task-profile.ts\n")),
      }),
    ).toBe("dirty");
  });

  it("writes build-info.json with an inferred dirty marker", async () => {
    const rootDir = await makeTempRepo();
    const distDir = path.join(rootDir, "dist");
    const execSyncImpl = vi.fn((command: string) => {
      if (command === "git rev-parse HEAD") {
        return Buffer.from("abcdef0123456789\n");
      }
      if (command === "git status --porcelain --untracked-files=normal") {
        return Buffer.from(" M src/entry.ts\n");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const buildInfo = writeBuildInfo({
      rootDir,
      distDir,
      now: new Date("2026-03-26T00:00:00.000Z"),
      env: {},
      execSyncImpl,
    });

    expect(buildInfo).toEqual({
      version: "9.9.9-test",
      displayVersionMarker: "dirty",
      commit: "abcdef0123456789",
      builtAt: "2026-03-26T00:00:00.000Z",
    });
    await expect(fs.readFile(path.join(distDir, "build-info.json"), "utf8")).resolves.toContain(
      '"displayVersionMarker": "dirty"',
    );
  });

  it("builds clean metadata without a marker when git status is clean", async () => {
    const rootDir = await makeTempRepo();
    const buildInfo = createBuildInfo({
      rootDir,
      now: new Date("2026-03-26T00:00:00.000Z"),
      env: {},
      execSyncImpl: vi.fn((command: string) => {
        if (command === "git rev-parse HEAD") {
          return Buffer.from("abcdef0123456789\n");
        }
        if (command === "git status --porcelain --untracked-files=normal") {
          return Buffer.from("");
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    });

    expect(buildInfo.displayVersionMarker).toBeNull();
  });
});
