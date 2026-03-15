import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Bytes, sha256File, verifyHashConsistency } from "./hash-skill.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "hash-skill-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("hash-skill", () => {
  it("hashes buffers deterministically", () => {
    expect(sha256Bytes("hello")).toBe(sha256Bytes(Buffer.from("hello")));
  });

  it("hashes files and verifies consistency", async () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "bundle.zip");
    await fs.writeFile(filePath, Buffer.from("zip-binary"));
    const digest = await sha256File(filePath);
    await expect(verifyHashConsistency({ bundlePath: filePath, expectedSha256: digest })).resolves.toBe(
      true,
    );
  });
});
