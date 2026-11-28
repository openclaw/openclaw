import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const created: string[] = [];

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  for (const dir of created.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
  vi.resetModules();
});

function useTempStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-digest-key-"));
  created.push(dir);
  process.env.OPENCLAW_STATE_DIR = dir;
  return dir;
}

async function loadDigestKeyModule(): Promise<typeof import("./diagnostic-digest-key.js")> {
  return await import("./diagnostic-digest-key.js");
}

describe("hashDiagnosticValue", () => {
  it("returns a stable digest for the same value within one install", async () => {
    useTempStateDir();
    const { hashDiagnosticValue } = await loadDigestKeyModule();
    const first = hashDiagnosticValue("rejected buffer");
    const second = hashDiagnosticValue("rejected buffer");
    expect(first).toBeDefined();
    expect(first).toBe(second);
  });

  it("returns different digests for different values", async () => {
    useTempStateDir();
    const { hashDiagnosticValue } = await loadDigestKeyModule();
    expect(hashDiagnosticValue("a")).not.toBe(hashDiagnosticValue("b"));
  });

  it("produces different digests for the same value on different installs", async () => {
    useTempStateDir();
    const first = (await loadDigestKeyModule()).hashDiagnosticValue("rejected buffer");
    // A second install means a second secret, so the same buffer digests differently.
    vi.resetModules();
    useTempStateDir();
    const second = (await loadDigestKeyModule()).hashDiagnosticValue("rejected buffer");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it("does not expose the digested value", async () => {
    useTempStateDir();
    const { hashDiagnosticValue } = await loadDigestKeyModule();
    const digest = hashDiagnosticValue("secret-value-in-the-buffer");
    expect(digest).toBeDefined();
    expect(digest).not.toContain("secret-value-in-the-buffer");
  });
});
