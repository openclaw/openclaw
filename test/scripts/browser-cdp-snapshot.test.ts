// Browser CDP snapshot tests cover optional chunk quarantine and bounded snapshot assertions.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT_PATH = "scripts/e2e/lib/browser-cdp-snapshot/assert-snapshot.mjs";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();

function runAssertSnapshot(snapshotPath: string, env: Record<string, string | undefined> = {}) {
  return spawnSync(testNodeExecPath, [SCRIPT_PATH, snapshotPath], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: undefined, ...env },
  });
}

function runQuarantine(distDir: string, quarantineDir: string) {
  const harness = readFileSync("scripts/e2e/browser-cdp-snapshot-docker.sh", "utf8");
  const definition = harness.match(
    /^quarantine_browser_cdp_pw_ai_chunks\(\) \{\n[\s\S]*?^\}/m,
  )?.[0];
  expect(definition).toBeDefined();
  return spawnSync(
    "bash",
    [
      "-c",
      ["set -euo pipefail", definition, 'quarantine_browser_cdp_pw_ai_chunks "$1" "$2"'].join("\n"),
      "browser-cdp-quarantine",
      distDir,
      quarantineDir,
    ],
    { encoding: "utf8" },
  );
}

describe("browser CDP optional AI chunk quarantine", () => {
  it("moves optional js/mjs chunks while preserving the loader, state, and other entries", () => {
    const root = tempDirs.make("openclaw-browser-cdp-quarantine-");
    const distDir = path.join(root, "dist with spaces");
    const quarantineDir = path.join(root, "quarantine");
    const optional = ["pw-ai-optional.js", "pw-ai-optional.mjs"];
    const preserved = [
      "pw-ai-module-loader.js",
      "pw-ai-module-loader.mjs",
      "pw-ai-state-shared.js",
      "pw-ai-state-shared.mjs",
      "shared.js",
      "errors.mjs",
      "pw-ai-optional.js.map",
      "pw-ai-optional.cjs",
      "nested/pw-ai-nested.mjs",
    ];
    mkdirSync(path.join(distDir, "nested"), { recursive: true });
    mkdirSync(path.join(distDir, "pw-ai-directory.js"));
    for (const filename of [...optional, ...preserved]) {
      writeFileSync(path.join(distDir, filename), filename);
    }
    symlinkSync("shared.js", path.join(distDir, "pw-ai-linked.js"));
    symlinkSync("missing.mjs", path.join(distDir, "pw-ai-broken.mjs"));

    const result = runQuarantine(distDir, quarantineDir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(readdirSync(quarantineDir).toSorted()).toEqual(optional);
    for (const filename of optional) {
      expect(existsSync(path.join(distDir, filename))).toBe(false);
      expect(readFileSync(path.join(quarantineDir, filename), "utf8")).toBe(filename);
    }
    for (const filename of preserved) {
      expect(readFileSync(path.join(distDir, filename), "utf8")).toBe(filename);
    }
    expect(lstatSync(path.join(distDir, "pw-ai-directory.js")).isDirectory()).toBe(true);
    expect(readlinkSync(path.join(distDir, "pw-ai-linked.js"))).toBe("shared.js");
    expect(readlinkSync(path.join(distDir, "pw-ai-broken.mjs"))).toBe("missing.mjs");
    expect(result.stdout.trim().split("\n")).toEqual([
      "Disabled Playwright AI snapshot chunk: pw-ai-optional.js",
      "Disabled Playwright AI snapshot chunk: pw-ai-optional.mjs",
    ]);
  });
});

describe("browser CDP snapshot assertions", () => {
  it("rejects oversized snapshots before reading them into diagnostics", () => {
    const root = tempDirs.make("openclaw-browser-cdp-snapshot-");
    const snapshotPath = path.join(root, "snapshot.txt");
    writeFileSync(snapshotPath, "x".repeat(33), "utf8");

    const result = runAssertSnapshot(snapshotPath, {
      OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: "32",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("browser CDP snapshot exceeded 32 bytes");
    expect(result.stderr).not.toContain("x".repeat(33));
  });

  it("bounds missing-needle snapshot diagnostics", () => {
    const root = tempDirs.make("openclaw-browser-cdp-snapshot-");
    const snapshotPath = path.join(root, "snapshot.txt");
    writeFileSync(snapshotPath, `${"old snapshot line\n".repeat(6 * 1024)}recent tail`, "utf8");

    const result = runAssertSnapshot(snapshotPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("recent tail");
    expect(result.stderr).toContain("truncated snapshot diagnostic");
    expect(result.stderr.length).toBeLessThan(80 * 1024);
  });
});
