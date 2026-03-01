import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("loadOrCreateSessionSecret", () => {
  let tmpDir: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("generates a secret and persists it to disk", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-secret-test-"));
    vi.stubEnv("OPENCLAW_CONFIG_DIR", tmpDir);

    // Re-import to pick up env change
    const { loadOrCreateSessionSecret } = await import("./session-secret.js");
    const secret1 = loadOrCreateSessionSecret();
    expect(secret1).toBeTruthy();
    expect(secret1.length).toBeGreaterThanOrEqual(32);

    // File should exist
    const filePath = path.join(tmpDir, ".session-secret");
    expect(fs.existsSync(filePath)).toBe(true);
    const fileContent = fs.readFileSync(filePath, "utf-8").trim();
    expect(fileContent).toBe(secret1);
  });

  it("returns the same secret on subsequent calls", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-secret-test-"));
    vi.stubEnv("OPENCLAW_CONFIG_DIR", tmpDir);

    const { loadOrCreateSessionSecret } = await import("./session-secret.js");
    const _secret1 = loadOrCreateSessionSecret();

    // Write a known secret to the file
    const knownSecret = "a".repeat(64);
    fs.writeFileSync(path.join(tmpDir, ".session-secret"), knownSecret);

    const secret2 = loadOrCreateSessionSecret();
    expect(secret2).toBe(knownSecret);
  });
});
