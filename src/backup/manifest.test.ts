import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManifest, sha256File, validateManifest, verifyIntegrity } from "./manifest.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-manifest-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  tempDirs.length = 0;
});

describe("sha256File", () => {
  it("computes deterministic SHA-256", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "test.txt");
    await fs.writeFile(file, "hello world");
    const hash = await sha256File(file);
    // Known SHA-256 of "hello world"
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  it("produces different hashes for different content", async () => {
    const dir = await makeTempDir();
    const f1 = path.join(dir, "a.txt");
    const f2 = path.join(dir, "b.txt");
    await fs.writeFile(f1, "content A");
    await fs.writeFile(f2, "content B");
    const h1 = await sha256File(f1);
    const h2 = await sha256File(f2);
    expect(h1).not.toBe(h2);
  });
});

describe("buildManifest", () => {
  it("builds a manifest from staging directory", async () => {
    const staging = await makeTempDir();
    await fs.mkdir(path.join(staging, "config"), { recursive: true });
    await fs.writeFile(path.join(staging, "config", "openclaw.json"), '{"key": "value"}');
    await fs.writeFile(path.join(staging, "README"), "backup readme");

    const manifest = await buildManifest({
      stagingDir: staging,
      components: ["config"],
      openclawVersion: "2026.1.1",
      label: "test-backup",
    });

    expect(manifest.version).toBe(1);
    expect(manifest.openclawVersion).toBe("2026.1.1");
    expect(manifest.components).toEqual(["config"]);
    expect(manifest.label).toBe("test-backup");
    expect(manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.entries).toHaveLength(2);

    const configEntry = manifest.entries.find((e) =>
      e.path.replace(/\\/g, "/").includes("config/openclaw.json"),
    );
    expect(configEntry).toBeDefined();
    expect(configEntry!.sha256).toHaveLength(64);
    expect(configEntry!.size).toBeGreaterThan(0);
  });

  it("marks encrypted when option is set", async () => {
    const staging = await makeTempDir();
    await fs.writeFile(path.join(staging, "test.txt"), "data");

    const manifest = await buildManifest({
      stagingDir: staging,
      components: ["config"],
      openclawVersion: "2026.1.1",
      encrypted: true,
    });

    expect(manifest.encrypted).toBe(true);
  });

  it("handles empty staging directory", async () => {
    const staging = await makeTempDir();

    const manifest = await buildManifest({
      stagingDir: staging,
      components: ["config"],
      openclawVersion: "2026.1.1",
    });

    expect(manifest.entries).toHaveLength(0);
  });
});

describe("validateManifest", () => {
  const validManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    openclawVersion: "2026.1.1",
    components: ["config"],
    entries: [],
  };

  it("returns empty for valid manifest", () => {
    expect(validateManifest(validManifest)).toEqual([]);
  });

  it("rejects null", () => {
    const errors = validateManifest(null);
    expect(errors).toContain("manifest is not an object");
  });

  it("rejects non-object", () => {
    const errors = validateManifest("string");
    expect(errors).toContain("manifest is not an object");
  });

  it("rejects wrong version", () => {
    const errors = validateManifest({ ...validManifest, version: 99 });
    expect(errors.some((e) => e.includes("unsupported manifest version"))).toBe(true);
  });

  it("rejects missing createdAt", () => {
    const { createdAt: _, ...noCreatedAt } = validManifest;
    const errors = validateManifest(noCreatedAt);
    expect(errors.some((e) => e.includes("createdAt"))).toBe(true);
  });

  it("rejects missing openclawVersion", () => {
    const { openclawVersion: _, ...noVersion } = validManifest;
    const errors = validateManifest(noVersion);
    expect(errors.some((e) => e.includes("openclawVersion"))).toBe(true);
  });

  it("rejects empty components", () => {
    const errors = validateManifest({ ...validManifest, components: [] });
    expect(errors.some((e) => e.includes("components"))).toBe(true);
  });

  it("rejects missing entries", () => {
    const { entries: _, ...noEntries } = validManifest;
    const errors = validateManifest(noEntries);
    expect(errors.some((e) => e.includes("entries"))).toBe(true);
  });
});

describe("verifyIntegrity", () => {
  it("passes when checksums match", async () => {
    const dir = await makeTempDir();
    const content = "file content for integrity check";
    await fs.writeFile(path.join(dir, "test.txt"), content);
    const hash = await sha256File(path.join(dir, "test.txt"));

    const manifest = {
      version: 1 as const,
      createdAt: new Date().toISOString(),
      openclawVersion: "2026.1.1",
      components: ["config" as const],
      entries: [{ path: "test.txt", sha256: hash, size: Buffer.byteLength(content) }],
    };

    const mismatched = await verifyIntegrity(manifest, dir);
    expect(mismatched).toHaveLength(0);
  });

  it("reports mismatched checksums", async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, "test.txt"), "actual content");

    const manifest = {
      version: 1 as const,
      createdAt: new Date().toISOString(),
      openclawVersion: "2026.1.1",
      components: ["config" as const],
      entries: [{ path: "test.txt", sha256: "0".repeat(64), size: 14 }],
    };

    const mismatched = await verifyIntegrity(manifest, dir);
    expect(mismatched).toHaveLength(1);
    expect(mismatched[0].path).toBe("test.txt");
  });

  it("reports missing files as mismatched", async () => {
    const dir = await makeTempDir();

    const manifest = {
      version: 1 as const,
      createdAt: new Date().toISOString(),
      openclawVersion: "2026.1.1",
      components: ["config" as const],
      entries: [{ path: "nonexistent.txt", sha256: "abc", size: 0 }],
    };

    const mismatched = await verifyIntegrity(manifest, dir);
    expect(mismatched).toHaveLength(1);
  });
});
