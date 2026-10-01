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
  it("accepts the identical clean candidate checkout", () => {
    const { cwd, sourceSha } = createRepository();
    expect(verifyInstalledFingerprintSource({ cwd, sourceSha, toolingSha: sourceSha })).toEqual([]);
  });

  it("reuses candidate owners across the exact reviewed fixture-only tooling changes", () => {
    const repo = createRepository();
    const changed = [
      "src/daemon/schtasks.integration-observation.test-support.ts",
      "src/daemon/schtasks.integration.e2e.test.ts",
      fixturePath,
      "src/daemon/schtasks.installed-diagnostics.test-support.ts",
      "src/daemon/schtasks.installed-authority.test-support.ts",
      "src/daemon/schtasks.installed.integration.test-support.ts",
      "src/daemon/schtasks.installed-startup.test-support.ts",
      "src/daemon/schtasks.installed-fingerprint-observer.test-support.mts",
      "src/daemon/schtasks.installed-fingerprint-observer.test.ts",
      "src/config/sessions/session-sharing-store.test.ts",
      ".github/workflows/windows-testbox-probe.yml",
      "test/helpers/gateway/config-rpc-gateway.ts",
      "src/daemon/schtasks.installed-powershell-context.test-support.mts",
      "src/daemon/schtasks.installed-package.test-support.ts",
      "src/daemon/schtasks.installed-package.test.ts",
    ];
    for (const filename of changed) {
      repo.write(filename);
    }
    const toolingSha = repo.commit();
    expect(toolingSha).not.toBe(repo.sourceSha);
    expect(verifyInstalledFingerprintSource({ ...repo, toolingSha })).toEqual(changed.toSorted());
  });

  it.each([
    productionPath,
    "package.json",
    "pnpm-lock.yaml",
    "src/daemon/schtasks.unreviewed.test.ts",
  ])("rejects a committed change to %s", (filename) => {
    const repo = createRepository();
    repo.write(filename);
    const toolingSha = repo.commit();
    expect(() => verifyInstalledFingerprintSource({ ...repo, toolingSha })).toThrow(
      `Candidate source differs outside reviewed proof fixtures: ${filename}`,
    );
  });

  it("rejects moving production bytes into an admitted fixture path", () => {
    const repo = createRepository();
    repo.git("mv", "--force", productionPath, fixturePath);
    const toolingSha = repo.commit();
    expect(() => verifyInstalledFingerprintSource({ ...repo, toolingSha })).toThrow(
      `Candidate source differs outside reviewed proof fixtures: ${productionPath}`,
    );
  });

  it("rejects a tooling pin that is not the checked-out HEAD", () => {
    const repo = createRepository();
    repo.write(fixturePath);
    repo.commit();
    expect(() =>
      verifyInstalledFingerprintSource({ ...repo, toolingSha: repo.sourceSha }),
    ).toThrow();
  });

  it.each([false, true])("rejects dirty tracked fixture bytes (staged=%s)", (staged) => {
    const repo = createRepository();
    repo.write(fixturePath);
    if (staged) {
      repo.git("add", "--", fixturePath);
    }
    expect(() =>
      verifyInstalledFingerprintSource({ ...repo, toolingSha: repo.sourceSha }),
    ).toThrow();
  });

  it("requires full commit pins and an available candidate commit", () => {
    const { cwd, sourceSha } = createRepository();
    for (const pins of [
      { sourceSha: sourceSha.slice(0, 12), toolingSha: sourceSha },
      { sourceSha, toolingSha: "HEAD" },
      { sourceSha: "0".repeat(40), toolingSha: sourceSha },
    ]) {
      expect(() => verifyInstalledFingerprintSource({ cwd, ...pins })).toThrow();
    }
  });
});
