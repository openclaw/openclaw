import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installTestEnv } from "./test-env.js";

const ORIGINAL_ENV = { ...process.env };

const tempDirs = new Set<string>();
const cleanupFns: Array<() => void> = [];

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-env-real-home-"));
  tempDirs.add(tempDir);
  return tempDir;
}

afterEach(() => {
  while (cleanupFns.length > 0) {
    cleanupFns.pop()?.();
  }
  restoreProcessEnv();
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe("installTestEnv", () => {
  it("keeps live tests on a temp HOME while copying config and auth state", () => {
    const realHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");
    writeFile(
      path.join(realHome, "custom-openclaw.json5"),
      `{
        // Preserve provider config, strip host-bound paths.
        agents: {
          defaults: {
            workspace: "/Users/peter/Projects",
            agentDir: "/Users/peter/.openclaw/agents/main/agent",
          },
          list: [
            {
              id: "dev",
              workspace: "/Users/peter/dev-workspace",
              agentDir: "/Users/peter/.openclaw/agents/dev/agent",
            },
          ],
        },
        models: {
          providers: {
            custom: { baseUrl: "https://example.test/v1" },
          },
        },
      }`,
    );
    writeFile(path.join(realHome, ".openclaw", "credentials", "token.txt"), "secret\n");
    writeFile(
      path.join(realHome, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      JSON.stringify({ version: 1, profiles: { default: { provider: "openai" } } }, null, 2),
    );
    writeFile(path.join(realHome, ".claude", ".credentials.json"), '{"accessToken":"token"}\n');

    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    process.env.OPENCLAW_LIVE_TEST = "1";
    process.env.OPENCLAW_LIVE_TEST_QUIET = "1";
    process.env.OPENCLAW_CONFIG_PATH = "~/custom-openclaw.json5";

    const testEnv = installTestEnv();
    cleanupFns.push(testEnv.cleanup);

    expect(testEnv.tempHome).not.toBe(realHome);
    expect(process.env.HOME).toBe(testEnv.tempHome);
    expect(process.env.OPENCLAW_TEST_HOME).toBe(testEnv.tempHome);
    expect(process.env.TEST_PROFILE_ONLY).toBe("from-profile");

    const copiedConfigPath = path.join(testEnv.tempHome, ".openclaw", "openclaw.json");
    const copiedConfig = JSON.parse(fs.readFileSync(copiedConfigPath, "utf8")) as {
      agents?: {
        defaults?: Record<string, unknown>;
        list?: Array<Record<string, unknown>>;
      };
      models?: { providers?: Record<string, unknown> };
    };
    expect(copiedConfig.models?.providers?.custom).toEqual({ baseUrl: "https://example.test/v1" });
    expect(copiedConfig.agents?.defaults?.workspace).toBeUndefined();
    expect(copiedConfig.agents?.defaults?.agentDir).toBeUndefined();
    expect(copiedConfig.agents?.list?.[0]?.workspace).toBeUndefined();
    expect(copiedConfig.agents?.list?.[0]?.agentDir).toBeUndefined();

    expect(
      fs.existsSync(path.join(testEnv.tempHome, ".openclaw", "credentials", "token.txt")),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(testEnv.tempHome, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(testEnv.tempHome, ".claude", ".credentials.json"))).toBe(true);
  });

  it("allows explicit live runs against the real HOME", () => {
    const realHome = createTempHome();
    writeFile(path.join(realHome, ".profile"), "export TEST_PROFILE_ONLY=from-profile\n");

    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    process.env.OPENCLAW_LIVE_TEST = "1";
    process.env.OPENCLAW_LIVE_USE_REAL_HOME = "1";
    process.env.OPENCLAW_LIVE_TEST_QUIET = "1";

    const testEnv = installTestEnv();

    expect(testEnv.tempHome).toBe(realHome);
    expect(process.env.HOME).toBe(realHome);
    expect(process.env.TEST_PROFILE_ONLY).toBe("from-profile");
  });
});
