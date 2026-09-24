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
    expect(readdirSync(quarantineDir).sort()).toEqual(optional);
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

  it("fails without mutating the source or creating a destination when no optional chunk exists", () => {
    const root = tempDirs.make("openclaw-browser-cdp-no-optional-");
    const distDir = path.join(root, "dist");
    const quarantineDir = path.join(root, "quarantine");
    const preserved = ["pw-ai-module-loader.js", "pw-ai-state-shared.mjs"];
    mkdirSync(distDir);
    for (const filename of preserved) {
      writeFileSync(path.join(distDir, filename), filename);
    }

    const result = runQuarantine(distDir, quarantineDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no optional Playwright AI snapshot chunk found");
    expect(result.stdout).toBe("");
    expect(existsSync(quarantineDir)).toBe(false);
    expect(readdirSync(distDir).sort()).toEqual(preserved);
    for (const filename of preserved) {
      expect(readFileSync(path.join(distDir, filename), "utf8")).toBe(filename);
    }
  });

  it("does not report a chunk as disabled when the move fails", () => {
    const root = tempDirs.make("openclaw-browser-cdp-move-failure-");
    const distDir = path.join(root, "dist");
    const quarantineDir = path.join(root, "quarantine");
    const filename = "pw-ai-optional.js";
    mkdirSync(distDir);
    writeFileSync(path.join(distDir, filename), "optional chunk");
    mkdirSync(path.join(quarantineDir, filename), { recursive: true });

    const result = runQuarantine(distDir, quarantineDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed to disable Playwright AI snapshot chunk");
    expect(result.stdout).toBe("");
    expect(readFileSync(path.join(distDir, filename), "utf8")).toBe("optional chunk");
    expect(lstatSync(path.join(quarantineDir, filename)).isDirectory()).toBe(true);
  });
});

describe("browser CDP snapshot assertions", () => {
  it.each([undefined, "", " 1024 ", "9007199254740991"])("accepts snapshot limit %j", (limit) => {
    const root = tempDirs.make("openclaw-browser-cdp-snapshot-");
    const snapshotPath = path.join(root, "snapshot.txt");
    writeFileSync(
      snapshotPath,
      [
        'button "Save"',
        'link "Docs" https://docs.openclaw.ai/browser-cdp-live',
        'generic "Clickable Card" cursor:pointer',
        'Iframe "Child"',
        'button "Inside"',
      ].join("\n"),
      "utf8",
    );

    const result = runAssertSnapshot(snapshotPath, {
      OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: limit,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok\n");
    expect(result.stderr).toBe("");
  });

  it.each([" \t ", "0", "-1", "1.5", "1e3", "1kb", "9007199254740992"])(
    "rejects snapshot limit %j with the untrimmed value",
    (limit) => {
      const root = tempDirs.make("openclaw-browser-cdp-snapshot-");
      const result = runAssertSnapshot(path.join(root, "snapshot.txt"), {
        OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: limit,
      });

      expect(result.status).toBe(1);
      expect(result.stderr.split("\n").find((line) => line.startsWith("Error: "))).toBe(
        `Error: OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES must be a positive integer; got: ${limit}`,
      );
    },
  );

  it.each([undefined, ""])("keeps the default snapshot limit for %j", (limit) => {
    const root = tempDirs.make("openclaw-browser-cdp-snapshot-");
    const snapshotPath = path.join(root, "snapshot.txt");
    writeFileSync(snapshotPath, "x".repeat(512 * 1024 + 1), "utf8");

    const result = runAssertSnapshot(snapshotPath, {
      OPENCLAW_BROWSER_CDP_SNAPSHOT_MAX_BYTES: limit,
    });

    expect(result.status).toBe(1);
    expect(result.stderr.split("\n").find((line) => line.startsWith("Error: "))).toBe(
      "Error: browser CDP snapshot exceeded 524288 bytes: 524289 bytes",
    );
  });

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
