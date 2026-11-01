import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCliStartupBuild,
  hasCliStartupBuild,
  resolveCliStartupBuildTimeoutMs,
} from "../../scripts/ensure-cli-startup-build.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);
const timeout = (value?: string) =>
  resolveCliStartupBuildTimeoutMs(
    value === undefined ? {} : { OPENCLAW_CLI_STARTUP_BUILD_TIMEOUT_MS: value },
  );

function makeTempRoot(entry?: string): string {
  const root = tempRoots.make("openclaw-cli-startup-build-");
  if (entry) {
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", entry), "export {};\n");
    writeFileSync(
      path.join(root, "dist", "cli-startup-metadata.json"),
      '{"rootHelpText":"help\\n"}\n',
    );
  }
  return root;
}

describe("ensure-cli-startup-build", () => {
  it.each(["entry.js", "entry.mjs"])("detects and reuses an existing %s build", (entry) => {
    const rootDir = makeTempRoot(entry);
    expect(hasCliStartupBuild({ rootDir })).toBe(true);
    expect(
      ensureCliStartupBuild({
        rootDir,
        spawnSync: () => {
          throw new Error("unexpected build");
        },
      }),
    ).toEqual({ built: false });
  });

  it("uses the configured cliStartup build timeout", () => {
    const spawnSync = vi.fn(() => ({ status: 0 }));
    ensureCliStartupBuild({
      rootDir: makeTempRoot(),
      env: { OPENCLAW_CLI_STARTUP_BUILD_TIMEOUT_MS: "1234" },
      spawnSync,
      stdio: "pipe",
    });
    expect(spawnSync.mock.calls).toEqual([
      [expect.any(String), expect.any(Array), expect.objectContaining({ timeout: 1234 })],
    ]);
  });

  it.each([
    [{ status: 1 }, "cliStartup build profile failed with exit code 1"],
    [{ error: new Error("spawn denied") }, "spawn denied"],
  ] as const)("reports build failure %j", (result, message) => {
    expect(() =>
      ensureCliStartupBuild({
        rootDir: makeTempRoot(),
        spawnSync: () => result,
        stdio: "pipe",
      }),
    ).toThrow(message);
  });
});

describe("resolveCliStartupBuildTimeoutMs", () => {
  it("parses only positive integer environment timeouts", () => {
    expect(timeout()).toBe(10 * 60 * 1000);
    expect(timeout("")).toBe(10 * 60 * 1000);
    expect(timeout("4321")).toBe(4321);

    for (const raw of ["nope", "10m", "1e3", "0", "-1", "9007199254740992"]) {
      expect(() => timeout(raw)).toThrow(`invalid OPENCLAW_CLI_STARTUP_BUILD_TIMEOUT_MS: ${raw}`);
    }
  });
});
