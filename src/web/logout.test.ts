import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-test-web-logout-"));
  try {
    return await fn(dir);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
}

describe("web logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes cached credentials when present", { timeout: 60_000 }, async () => {
    await withTempDir(async (authDir) => {
      const { logoutWeb } = await import("./session.js");
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, "creds.json"), "{}");
      const result = await logoutWeb({ authDir, runtime: runtime as never });
      expect(result).toBe(true);
      expect(fs.existsSync(authDir)).toBe(false);
    });
  });

  it("no-ops when nothing to delete", { timeout: 60_000 }, async () => {
    await withTempDir(async (authDir) => {
      const { logoutWeb } = await import("./session.js");
      const result = await logoutWeb({ authDir, runtime: runtime as never });
      expect(result).toBe(false);
      expect(runtime.log).toHaveBeenCalled();
    });
  });

  it("keeps shared oauth.json when using legacy auth dir", async () => {
    await withTempDir(async (credsDir) => {
      const { logoutWeb } = await import("./session.js");
      fs.mkdirSync(credsDir, { recursive: true });
      fs.writeFileSync(path.join(credsDir, "creds.json"), "{}");
      fs.writeFileSync(path.join(credsDir, "oauth.json"), '{"token":true}');
      fs.writeFileSync(path.join(credsDir, "session-abc.json"), "{}");

      const result = await logoutWeb({
        authDir: credsDir,
        isLegacyAuthDir: true,
        runtime: runtime as never,
      });
      expect(result).toBe(true);
      expect(fs.existsSync(path.join(credsDir, "oauth.json"))).toBe(true);
      expect(fs.existsSync(path.join(credsDir, "creds.json"))).toBe(false);
      expect(fs.existsSync(path.join(credsDir, "session-abc.json"))).toBe(false);
    });
  });
});
