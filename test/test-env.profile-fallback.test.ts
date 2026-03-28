import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const tempDirs = new Set<string>();

function restoreProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function writeFile(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
}

function createTempHome(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-env-fallback-"));
  tempDirs.add(tempDir);
  return tempDir;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("node:child_process");
  restoreProcessEnv();
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("installTestEnv shell fallback", () => {
  it("parses .profile when bash execution is unavailable", async () => {
    const realHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");

    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    process.env.OPENCLAW_LIVE_TEST = "1";
    process.env.OPENCLAW_LIVE_USE_REAL_HOME = "1";
    process.env.OPENCLAW_LIVE_TEST_QUIET = "1";

    vi.doMock("node:child_process", () => ({
      execFileSync: () => {
        throw new Error("missing bash");
      },
    }));

    const { installTestEnv } = await import("./test-env.js?fallback");
    const testEnv = installTestEnv();

    expect(testEnv.tempHome).toBe(realHome);
    expect(process.env.TEST_PROFILE_ONLY).toBe("from-profile");
  });

  it("does not parse raw .profile lines after successful shell loading", async () => {
    const realHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "TEST_PROFILE_ONLY=from-profile\n");

    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    process.env.OPENCLAW_LIVE_TEST = "1";
    process.env.OPENCLAW_LIVE_USE_REAL_HOME = "1";
    process.env.OPENCLAW_LIVE_TEST_QUIET = "1";
    delete process.env.TEST_PROFILE_ONLY;

    vi.doMock("node:child_process", () => ({
      execFileSync: () => "",
    }));

    const { installTestEnv } = await import("./test-env.js?shell-success");
    const testEnv = installTestEnv();

    expect(testEnv.tempHome).toBe(realHome);
    expect(process.env.TEST_PROFILE_ONLY).toBeUndefined();
  });

  it("uses one coherent live state source when OPENCLAW_STATE_DIR points elsewhere", async () => {
    const realHome = createTempHome();
    const unrelatedStateDir = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");
    writeFile(path.join(realHome, ".openclaw", "credentials", "token.txt"), "secret\n");
    writeFile(
      path.join(realHome, ".openclaw", "openclaw.json"),
      '{"models":{"provider":"home"}}\n',
    );
    writeFile(
      path.join(unrelatedStateDir, "openclaw.json"),
      '{"models":{"provider":"override"}}\n',
    );

    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    process.env.OPENCLAW_LIVE_TEST = "1";
    process.env.OPENCLAW_LIVE_TEST_QUIET = "1";
    process.env.OPENCLAW_STATE_DIR = unrelatedStateDir;

    const { installTestEnv } = await import("./test-env.js?state-override");
    const testEnv = installTestEnv();

    expect(
      fs.existsSync(path.join(testEnv.tempHome, ".openclaw", "credentials", "token.txt")),
    ).toBe(true);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(testEnv.tempHome, ".openclaw", "openclaw.json"), "utf8"),
      ),
    ).toEqual({ models: { provider: "home" } });
  });
});
