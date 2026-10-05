import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("SecretRef docs file boundary", () => {
  it("reads and writes a regular file under docs/reference", () => {
    const { root, filePath } = makeDocsFile();
    expect(readSecretRefDocsFile(root, filePath)).toBe("original");
    writeSecretRefDocsFile(root, filePath, "updated");
    expect(fs.readFileSync(filePath, "utf8")).toBe("updated");
  });

  it.runIf(process.platform !== "win32")("rejects a symlinked output file", () => {
    const { root, filePath } = makeDocsFile();
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.rmSync(filePath);
    fs.symlinkSync(outside, filePath);
    expect(() => readSecretRefDocsFile(root, filePath)).toThrow();
    expect(() => writeSecretRefDocsFile(root, filePath, "changed")).toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it.runIf(process.platform !== "win32")("rejects a hardlinked output file", () => {
    const { root, filePath } = makeDocsFile();
    const outside = path.join(root, "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.rmSync(filePath);
    fs.linkSync(outside, filePath);
    expect(() => writeSecretRefDocsFile(root, filePath, "changed")).toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it.runIf(process.platform !== "win32")("rejects a symlinked parent directory", () => {
    const { root, filePath, referenceRoot } = makeDocsFile();
    const outside = path.join(root, "outside");
    fs.renameSync(referenceRoot, outside);
    fs.symlinkSync(outside, referenceRoot);
    expect(() => readSecretRefDocsFile(root, filePath)).toThrow();
    expect(() => writeSecretRefDocsFile(root, filePath, "changed")).toThrow();
    expect(fs.readFileSync(path.join(outside, "matrix.json"), "utf8")).toBe("original");
  });
});
