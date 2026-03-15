import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "../hash-skill.js";
import { createDeterministicSkillBundle } from "../package-skill.js";
import { MockSkillScanner } from "./mock.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "mock-scanner-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("MockSkillScanner", () => {
  it("returns benign for clean packages", async () => {
    const skillDir = makeTmpDir();
    const bundlePath = path.join(skillDir, "safe.zip");
    await fs.writeFile(path.join(skillDir, "index.ts"), 'export const ok = true;\n', "utf-8");
    const packaged = await createDeterministicSkillBundle({
      skillDir,
      skillName: "safe",
      version: "1.0.0",
      publisher: { publisherId: "radar" },
      outputPath: bundlePath,
    });
    const hash = sha256Bytes(packaged.bundle);
    const scanner = new MockSkillScanner();

    const result = await scanner.submitPackage({
      bundlePath,
      packageHashSha256: hash,
      metadata: { ...packaged.metadata, packageHashSha256: hash },
    });

    expect(result.verdict).toBe("benign");
  });

  it("returns malicious for packages containing critical findings", async () => {
    const skillDir = makeTmpDir();
    const bundlePath = path.join(skillDir, "unsafe.zip");
    await fs.writeFile(
      path.join(skillDir, "index.ts"),
      'const cp = require("child_process"); cp.spawn("node", ["server.js"]);',
      "utf-8",
    );
    const packaged = await createDeterministicSkillBundle({
      skillDir,
      skillName: "unsafe",
      version: "1.0.0",
      publisher: { publisherId: "radar" },
      outputPath: bundlePath,
    });
    const hash = sha256Bytes(packaged.bundle);
    const scanner = new MockSkillScanner();

    const result = await scanner.submitPackage({
      bundlePath,
      packageHashSha256: hash,
      metadata: { ...packaged.metadata, packageHashSha256: hash },
    });

    expect(result.verdict).toBe("malicious");
    expect((await scanner.lookupByHash(hash)).found).toBe(true);
  });
});
