// OpenClaw NPM Publish tests cover publish wrapper argument safety.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = "scripts/openclaw-npm-publish.sh";
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runPublishWrapper(args: string[]) {
  return spawnSync("bash", [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("openclaw npm publish wrapper", () => {
  it("prints help without resolving release metadata", () => {
    const result = runPublishWrapper(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "usage: bash scripts/openclaw-npm-publish.sh --publish [package.tgz]",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects missing publish mode before resolving release metadata", () => {
    const result = runPublishWrapper([]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(
      "usage: bash scripts/openclaw-npm-publish.sh --publish [package.tgz]",
    );
  });

  it("rejects option-like publish targets before npm publish", () => {
    const result = runPublishWrapper(["--publish", "--tag"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("error: unexpected npm publish target option: --tag");
  });

  it("rejects extra publish arguments before npm publish", () => {
    const tempRoot = makeTempDir("openclaw-npm-publish-");
    const tarball = path.join(tempRoot, "openclaw.tgz");
    writeFileSync(tarball, "placeholder", "utf8");

    const result = runPublishWrapper(["--publish", tarball, "extra"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("error: unexpected npm publish argument: extra");
  });
});
