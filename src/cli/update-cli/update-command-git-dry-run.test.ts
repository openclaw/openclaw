import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createUpdatePreflightFailure } from "../../infra/update-preflight-details.js";
import { inspectGitDryRunTargetSchemaVersions } from "./update-command-git.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function createGitFixture(base: string) {
  const remote = path.join(base, "remote.git");
  const source = path.join(base, "source");
  const checkout = path.join(base, "checkout");
  fs.mkdirSync(source);
  git(base, "init", "--bare", "--initial-branch=main", remote);
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "OpenClaw Test");
  git(source, "config", "user.email", "openclaw@example.com");
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.1" }),
  );
  git(source, "add", "package.json");
  git(source, "commit", "-m", "initial");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "--set-upstream", "origin", "main");
  git(base, "clone", remote, checkout);
  return { checkout, source };
}

async function inspectFailure(root: string): Promise<string> {
  const result = await inspectGitDryRunTargetSchemaVersions({
    root,
    timeoutMs: 5000,
    channel: "dev",
  });
  expect(result.metadataUnreadable).toBeDefined();
  const failureCode = "failureCode" in result ? result.failureCode : "target-git-metadata";
  return createUpdatePreflightFailure(
    failureCode ?? "target-git-metadata",
    result.metadataUnreadable,
  ).message;
}

it("distinguishes a stale cached ref from an unreachable remote during a dry-run", async () => {
  const { checkout, source } = createGitFixture(tempDirs.make("update-git-dry-run-"));
  const cachedBefore = git(checkout, "rev-parse", "origin/main");
  fs.writeFileSync(path.join(source, "next.txt"), "next\n");
  git(source, "add", "next.txt");
  git(source, "commit", "-m", "next");
  git(source, "push", "origin", "main");

  const stale = await inspectFailure(checkout);
  expect(stale).toContain("cached origin/main differs from current remote origin/main");
  expect(stale).toContain("dry-run leaves local refs unchanged");
  expect(stale).toContain("openclaw update will fetch and validate the current remote target");
  expect(stale).not.toContain("Check Git remote access");
  expect(git(checkout, "rev-parse", "origin/main")).toBe(cachedBefore);

  git(checkout, "remote", "set-url", "origin", path.join(checkout, "missing.git"));
  const unreachable = await inspectFailure(checkout);
  expect(unreachable).toContain("Check Git remote access");
  expect(unreachable).toContain("could not inspect current remote target origin/main");
  expect(unreachable).not.toContain("cached origin/main");
});
