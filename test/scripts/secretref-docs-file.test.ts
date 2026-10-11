import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, describe, expect, it } from "vitest";
import {
  readSecretRefDocsFile,
  writeSecretRefDocsFile,
} from "../../scripts/lib/secretref-docs-file.js";

const roots: string[] = [];

function makeDocsFile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "secretref-docs-file-"));
  roots.push(root);
  const referenceRoot = path.join(root, "docs", "reference");
  fs.mkdirSync(referenceRoot, { recursive: true });
  const filePath = path.join(referenceRoot, "matrix.json");
  fs.writeFileSync(filePath, "original");
  return { root, filePath, referenceRoot };
}

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("SecretRef docs file boundary", () => {
  it("checks repository artifacts when invoked outside the repository", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "secretref-docs-cwd-"));
    roots.push(cwd);
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(repoRoot, "scripts/tsx.mjs"),
        path.join(repoRoot, "scripts/generate-secretref-docs.ts"),
        "--check",
      ],
      { cwd, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SecretRef reference docs are up to date.");
  }, 60_000);

  it("loads source-owned channel security surfaces when bundled plugins are disabled", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(repoRoot, "scripts/tsx.mjs"),
        path.join(repoRoot, "scripts/generate-secretref-docs.ts"),
        "--check",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SecretRef reference docs are up to date.");
  }, 60_000);

  it("reads and writes a regular file under docs/reference", async () => {
    const { root, filePath } = makeDocsFile();
    expect(readSecretRefDocsFile(root, filePath)).toBe("original");
    await writeSecretRefDocsFile(root, filePath, "updated");
    expect(fs.readFileSync(filePath, "utf8")).toBe("updated");
  });

  it.runIf(process.platform !== "win32")("rejects a symlinked output file", async () => {
    const { root, filePath } = makeDocsFile();
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.rmSync(filePath);
    fs.symlinkSync(outside, filePath);
    expect(() => readSecretRefDocsFile(root, filePath)).toThrow();
    await expect(writeSecretRefDocsFile(root, filePath, "changed")).rejects.toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it.runIf(process.platform !== "win32")("rejects a hardlinked output file", async () => {
    const { root, filePath } = makeDocsFile();
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.rmSync(filePath);
    fs.linkSync(outside, filePath);
    await expect(writeSecretRefDocsFile(root, filePath, "changed")).rejects.toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it.runIf(process.platform !== "win32")(
    "rejects a hardlink created after validation without mutating it",
    async () => {
      const { root, filePath } = makeDocsFile();
      const outside = path.join(root, "outside.txt");
      const canonicalFilePath = fs.realpathSync(filePath);
      let linked = false;
      __setFsSafeTestHooksForTest({
        beforePinnedWriteParentAdmission: (targetPath) => {
          if (!linked && fs.realpathSync(targetPath) === canonicalFilePath) {
            linked = true;
            fs.linkSync(filePath, outside);
          }
        },
      });

      await expect(writeSecretRefDocsFile(root, filePath, "updated")).rejects.toThrow();

      expect(fs.readFileSync(filePath, "utf8")).toBe("original");
      expect(fs.readFileSync(outside, "utf8")).toBe("original");
    },
  );

  it.runIf(process.platform !== "win32")("rejects a symlinked parent directory", async () => {
    const { root, filePath, referenceRoot } = makeDocsFile();
    const outside = path.join(root, "outside");
    fs.renameSync(referenceRoot, outside);
    fs.symlinkSync(outside, referenceRoot);
    expect(() => readSecretRefDocsFile(root, filePath)).toThrow();
    await expect(writeSecretRefDocsFile(root, filePath, "changed")).rejects.toThrow();
    expect(fs.readFileSync(path.join(outside, "matrix.json"), "utf8")).toBe("original");
  });

  it.runIf(process.platform !== "win32")(
    "does not follow a parent directory replaced during publication",
    async () => {
      const { root, filePath, referenceRoot } = makeDocsFile();
      const retained = path.join(root, "retained-reference");
      const outside = path.join(root, "outside-reference");
      const outsideFile = path.join(outside, path.basename(filePath));
      const canonicalFilePath = fs.realpathSync(filePath);
      fs.mkdirSync(outside);
      fs.writeFileSync(outsideFile, "outside");
      let replaced = false;
      __setFsSafeTestHooksForTest({
        beforePinnedWriteParentAdmission: (targetPath) => {
          if (!replaced && fs.realpathSync(targetPath) === canonicalFilePath) {
            replaced = true;
            fs.renameSync(referenceRoot, retained);
            fs.symlinkSync(outside, referenceRoot);
          }
        },
      });

      await expect(writeSecretRefDocsFile(root, filePath, "changed")).rejects.toThrow();

      expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside");
    },
  );
});
