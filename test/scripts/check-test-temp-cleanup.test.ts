import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectTestTempCleanupFindings, main } from "../../scripts/check-test-temp-cleanup.mjs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createFixtureRepo(params: { relativePath: string; source: string }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-test-temp-cleanup-"));
  tempDirs.push(root);
  await fs.mkdir(path.join(root, path.dirname(params.relativePath)), { recursive: true });
  await fs.writeFile(path.join(root, params.relativePath), params.source, "utf8");
  execFileSync("git", ["init"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  execFileSync("git", ["add", params.relativePath], {
    cwd: root,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return root;
}

describe("check-test-temp-cleanup", () => {
  it("reports fixture files that use mkdtemp without obvious cleanup", async () => {
    const root = await createFixtureRepo({
      relativePath: "src/leaky.test.ts",
      source: `import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\nconst dir = fs.mkdtempSync(path.join(os.tmpdir(), "leaky-"));\nconsole.log(dir);\n`,
    });

    await expect(collectTestTempCleanupFindings(root)).resolves.toEqual([
      expect.objectContaining({
        file: "src/leaky.test.ts",
        severity: "error",
        cleanup: expect.objectContaining({
          hasCleanupCall: false,
          hasAfterEach: false,
          hasAfterAll: false,
          hasFinally: false,
        }),
      }),
    ]);
  });

  it("keeps files with hooks but no cleanup call in the result set", async () => {
    const root = await createFixtureRepo({
      relativePath: "src/mixed-hooks.test.ts",
      source: `import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\nimport { afterEach } from "vitest";\nafterEach(() => { resetMocks(); });\nconst dir = fs.mkdtempSync(path.join(os.tmpdir(), "leaky-"));\nconsole.log(dir);\n`,
    });

    await expect(collectTestTempCleanupFindings(root)).resolves.toEqual([
      expect.objectContaining({
        file: "src/mixed-hooks.test.ts",
        severity: "error",
        cleanup: expect.objectContaining({
          hasCleanupCall: false,
          hasAfterEach: true,
          hasAfterAll: false,
          hasFinally: false,
        }),
      }),
    ]);
  });

  it("suppresses files that combine cleanup calls with lifecycle cleanup scope", async () => {
    const root = await createFixtureRepo({
      relativePath: "src/clean.test.ts",
      source: `import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\nimport { afterEach } from "vitest";\nconst dir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-"));\nafterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });\n`,
    });

    await expect(collectTestTempCleanupFindings(root)).resolves.toEqual([]);
  });

  it("skips sparse-missing tracked files", async () => {
    const root = await createFixtureRepo({
      relativePath: "src/missing.test.ts",
      source: `import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\nconst dir = fs.mkdtempSync(path.join(os.tmpdir(), "missing-"));\nconsole.log(dir);\n`,
    });
    await fs.rm(path.join(root, "src", "missing.test.ts"), { force: true });

    await expect(collectTestTempCleanupFindings(root)).resolves.toEqual([]);
  });

  it("supports json output for tooling", async () => {
    let stdout = "";
    const exitCode = await main(["--json"], {
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: () => 0 },
    });

    expect(exitCode).toBe(1);
    expect(() => JSON.parse(stdout)).not.toThrow();
    const parsed = JSON.parse(stdout) as Array<{ file?: unknown; severity?: unknown }>;
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.some((entry) => typeof entry.file === "string")).toBe(true);
    expect(parsed.some((entry) => entry.severity === "error" || entry.severity === "warning")).toBe(
      true,
    );
  });
});
