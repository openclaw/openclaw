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

function createGitFixture(base: string, options: { partial?: boolean } = {}) {
  const remote = path.join(base, "remote.git");
  const source = path.join(base, "source");
  const checkout = path.join(base, "checkout");
  fs.mkdirSync(source);
  git(base, "init", "--bare", "--initial-branch=main", remote);
  git(remote, "config", "uploadpack.allowFilter", "true");
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
  git(
    base,
    "clone",
    ...(options.partial ? ["--filter=blob:none", "--no-checkout"] : []),
    ...(options.partial ? [`file://${remote}`] : [remote]),
    checkout,
  );
  return { checkout, source };
}

async function inspectFailure(root: string): Promise<{ code: string; message: string }> {
  const result = await inspectGitDryRunTargetSchemaVersions({
    root,
    timeoutMs: 5000,
    channel: "dev",
  });
  expect(result.metadataUnreadable).toBeDefined();
  const failureCode = "failureCode" in result ? result.failureCode : "target-git-metadata";
  const code = failureCode ?? "target-git-metadata";
  return {
    code,
    message: createUpdatePreflightFailure(code, result.metadataUnreadable).message,
  };
}

it("distinguishes a stale cached ref from an unreachable remote during a dry-run", async () => {
  const { checkout, source } = createGitFixture(tempDirs.make("update-git-dry-run-"));
  const cachedBefore = git(checkout, "rev-parse", "origin/main");
  fs.writeFileSync(path.join(source, "next.txt"), "next\n");
  git(source, "add", "next.txt");
  git(source, "commit", "-m", "next");
  git(source, "push", "origin", "main");

  const stale = await inspectFailure(checkout);
  expect(stale.message).toContain("cached origin/main differs from current remote origin/main");
  expect(stale.message).toContain("dry-run leaves local refs and objects unchanged");
  expect(stale.message).toContain("openclaw update will fetch and validate the selected target");
  expect(stale.message).not.toContain("Check Git remote access");
  expect(git(checkout, "rev-parse", "origin/main")).toBe(cachedBefore);

  git(checkout, "remote", "set-url", "origin", path.join(checkout, "missing.git"));
  const unreachable = await inspectFailure(checkout);
  expect(unreachable.message).toContain("Check Git remote access");
  expect(unreachable.message).toContain("could not inspect current remote target origin/main");
  expect(unreachable.message).not.toContain("cached origin/main");
});

it("explains when a dry-run cannot hydrate a promised target manifest", async () => {
  const { checkout } = createGitFixture(tempDirs.make("update-git-dry-run-partial-"), {
    partial: true,
  });
  const targetBefore = git(checkout, "rev-parse", "origin/main");

  const missingManifest = await inspectFailure(checkout);
  expect(missingManifest.code).toBe("target-git-cache-stale");
  expect(missingManifest.message).toContain("not fully available in the local checkout");
  expect(missingManifest.message).toContain("dry-run leaves local refs and objects unchanged");
  expect(missingManifest.message).toContain("real openclaw update will fetch and validate");
  expect(missingManifest.message).not.toContain("Check Git remote access");
  expect(git(checkout, "rev-parse", "origin/main")).toBe(targetBefore);
});
