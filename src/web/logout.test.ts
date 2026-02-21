import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("web logout", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let logoutWeb: typeof import("./auth-store.js").logoutWeb;

  beforeAll(async () => {
    fixtureRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-test-web-logout-"));
    ({ logoutWeb } = await import("./auth-store.js"));
  });

  afterAll(async () => {
    await fsPromises.rm(fixtureRoot, { recursive: true, force: true });
  });

  const makeCaseDir = async () => {
    const dir = path.join(fixtureRoot, `case-${caseId++}`);
    await fsPromises.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes cached credentials when present", { timeout: 60_000 }, async () => {
    const authDir = await makeCaseDir();
    fs.writeFileSync(path.join(authDir, "creds.json"), "{}");
    const result = await logoutWeb({ authDir, runtime: runtime as never });
    expect(result).toBe(true);
    expect(fs.existsSync(authDir)).toBe(false);
  });

  it("no-ops when nothing to delete", { timeout: 60_000 }, async () => {
    const authDir = await makeCaseDir();
    const result = await logoutWeb({ authDir, runtime: runtime as never });
    expect(result).toBe(false);
    expect(runtime.log).toHaveBeenCalled();
  });

  it("keeps shared oauth.json when using legacy auth dir", async () => {
    const credsDir = await makeCaseDir();
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
