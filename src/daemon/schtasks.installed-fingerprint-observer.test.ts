import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNestedGitEnv } from "../../test/helpers/temp-repo.js";
import { verifyInstalledFingerprintSource } from "./schtasks.installed-fingerprint-observer.test-support.mts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixturePath = "src/daemon/schtasks.integration-xml.test.ts";
const productionPath = "src/daemon/service.ts";

function createRepository() {
  const cwd = tempDirs.make("openclaw-fingerprint-source-");
  const env = {
    ...createNestedGitEnv(),
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: "Synthetic Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "commit.gpgsign=false", "-c", `core.hooksPath=${path.join(cwd, "no-hooks")}`, ...args],
      { cwd, env, encoding: "utf8", stdio: "pipe" },
    ).trim();
  const write = (filename: string, content = "fixture change\n") => {
    const target = path.join(cwd, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const commit = () => {
    git("add", "--all");
    git("commit", "--quiet", "-m", "Synthetic source fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet", "--template=");
  write(productionPath, "export const production = true;\n");
  write(fixturePath, "initial fixture\n");
  const sourceSha = commit();
  return { cwd, sourceSha, git, write, commit };
}

describe("installed fingerprint source qualification", () => {
  it.each([false, true])(
    "accepts clean candidate owners with reviewed tooling changes=%s",
    (changed) => {
      const repo = createRepository();
      const paths = changed
        ? [fixturePath, "src/daemon/schtasks.installed-package.test-support.ts"]
        : [];
      for (const filename of paths) {
        repo.write(filename);
      }
      const toolingSha = changed ? repo.commit() : repo.sourceSha;
      if (changed) {
        expect(toolingSha).not.toBe(repo.sourceSha);
      }
      expect(verifyInstalledFingerprintSource({ ...repo, toolingSha })).toEqual(paths.toSorted());
    },
  );

  it.each(["production", "unreviewed test", "rename"])(
    "rejects %s changes outside reviewed fixtures",
    (kind) => {
      const repo = createRepository();
      const filename =
        kind === "unreviewed test" ? "src/daemon/schtasks.unreviewed.test.ts" : productionPath;
      if (kind === "rename") {
        repo.git("mv", "--force", productionPath, fixturePath);
      } else {
        repo.write(filename);
      }
      const toolingSha = repo.commit();
      expect(() => verifyInstalledFingerprintSource({ ...repo, toolingSha })).toThrow(
        `Candidate source differs outside reviewed proof fixtures: ${filename}`,
      );
    },
  );

  it.each(["wrong HEAD", "staged", "unstaged", "invalid pins"])(
    "rejects an unqualified source checkout: %s",
    (kind) => {
      const repo = createRepository();
      if (kind !== "invalid pins") {
        repo.write(fixturePath);
        if (kind === "wrong HEAD") {
          repo.commit();
        } else if (kind === "staged") {
          repo.git("add", "--", fixturePath);
        }
      }
      const { cwd, sourceSha } = repo;
      const pins =
        kind === "invalid pins"
          ? [
              { sourceSha: sourceSha.slice(0, 12), toolingSha: sourceSha },
              { sourceSha, toolingSha: "HEAD" },
              { sourceSha: "0".repeat(40), toolingSha: sourceSha },
            ]
          : [{ sourceSha, toolingSha: sourceSha }];
      for (const pin of pins) {
        expect(() => verifyInstalledFingerprintSource({ cwd, ...pin })).toThrow();
      }
    },
  );
});
