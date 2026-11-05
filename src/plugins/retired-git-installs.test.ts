import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  cleanupRetiredGitPluginInstalls,
  rememberRetiredGitPluginInstall,
  retiredGitInstallMarkerDirectory,
} from "./retired-git-installs.js";

function retiredCheckout() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-retired-git-"));
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const repo = path.join(stateDir, "git", "git-old", "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "kept.txt"), "old");
  return {
    env,
    repo,
    parentDir: path.dirname(repo),
    replacement: path.join(stateDir, "git", "git-new", "repo"),
    [Symbol.dispose]() {
      fs.rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

async function remember(directory: ReturnType<typeof retiredCheckout>) {
  expect(
    await rememberRetiredGitPluginInstall({
      pluginId: "demo-slow",
      env: directory.env,
      removal: {
        target: directory.repo,
        cleanup: { kind: "git", parentDir: directory.parentDir },
      },
    }),
  ).toBe(true);
}

it("keeps a retired git checkout while that generation is still in use", async () => {
  using directory = retiredCheckout();
  await remember(directory);
  const kept = await cleanupRetiredGitPluginInstalls({
    env: directory.env,
    pluginIds: ["demo-slow"],
    protectPaths: [path.join(directory.repo, "kept.txt")],
  });
  expect(kept.removed).toBe(0);
  expect(fs.readFileSync(path.join(directory.repo, "kept.txt"), "utf8")).toBe("old");
});

it("removes a retired git checkout after the replacement is the only user", async () => {
  using directory = retiredCheckout();
  fs.mkdirSync(directory.replacement, { recursive: true });
  await remember(directory);
  const removed = await cleanupRetiredGitPluginInstalls({
    env: directory.env,
    pluginIds: ["demo-slow"],
    protectPaths: [directory.replacement],
  });
  expect(removed.removed).toBe(1);
  expect(fs.existsSync(directory.repo)).toBe(false);
  expect(fs.existsSync(directory.parentDir)).toBe(false);
});

it("leaves a checkout in place when the marker inode no longer matches", async () => {
  using directory = retiredCheckout();
  await remember(directory);
  const markerDir = retiredGitInstallMarkerDirectory(directory.env);
  const markerName = fs.readdirSync(markerDir).find((name) => name.endsWith(".json"));
  const markerPath = path.join(markerDir, markerName ?? "");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as { ino: string };
  marker.ino = "0";
  fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
  const removed = await cleanupRetiredGitPluginInstalls({
    env: directory.env,
    pluginIds: ["demo-slow"],
    protectPaths: [],
  });
  expect(removed.removed).toBe(0);
  expect(fs.readFileSync(path.join(directory.repo, "kept.txt"), "utf8")).toBe("old");
});

it("does not delete a marker that points outside the managed git root", async () => {
  using directory = retiredCheckout();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-not-a-plugin-"));
  try {
    fs.writeFileSync(path.join(outside, "kept.txt"), "stay");
    const markerDir = retiredGitInstallMarkerDirectory(directory.env);
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, "tamper.json"),
      `${JSON.stringify({
        version: 1,
        pluginId: "demo-slow",
        target: outside,
        parentDir: path.dirname(outside),
        dev: "1",
        ino: "1",
      })}\n`,
    );
    const removed = await cleanupRetiredGitPluginInstalls({
      env: directory.env,
      protectPaths: [],
    });
    expect(removed.removed).toBe(0);
    expect(fs.readFileSync(path.join(outside, "kept.txt"), "utf8")).toBe("stay");
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
