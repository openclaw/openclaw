import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveStatusTtsSnapshot } from "./status-config.js";

let fixtureRoot = "";
let fixtureId = 0;

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tts-status-"));
});

afterAll(() => {
  if (fixtureRoot) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

async function withStatusTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = path.join(fixtureRoot, `case-${fixtureId++}`);
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
  try {
    await run(home);
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("OPENCLAW_HOME", previousOpenClawHome);
    restoreEnv("OPENCLAW_STATE_DIR", previousStateDir);
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("resolveStatusTtsSnapshot", () => {
  it("uses prefs overrides without loading speech providers", async () => {
    await withStatusTempHome(async (home) => {
      const prefsPath = path.join(home, ".openclaw", "settings", "tts.json");
      fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
      fs.writeFileSync(
        prefsPath,
        JSON.stringify({
          tts: {
            auto: "always",
            provider: "edge",
            maxLength: 2048,
            summarize: false,
          },
        }),
      );

      expect(
        resolveStatusTtsSnapshot({
          cfg: {
            messages: {
              tts: {
                prefsPath,
              },
            },
          } as OpenClawConfig,
        }),
      ).toEqual({
        autoMode: "always",
        provider: "microsoft",
        maxLength: 2048,
        summarize: false,
      });
    });
  });

  it("reports auto provider when tts is on without an explicit provider", async () => {
    await withStatusTempHome(async () => {
      expect(
        resolveStatusTtsSnapshot({
          cfg: {
            messages: {
              tts: {
                auto: "always",
              },
            },
          } as OpenClawConfig,
        }),
      ).toEqual({
        autoMode: "always",
        provider: "auto",
        maxLength: 1500,
        summarize: true,
      });
    });
  });

  it("derives the default prefs path from OPENCLAW_CONFIG_PATH when set", async () => {
    await withStatusTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw-dev");
      const prefsPath = path.join(stateDir, "settings", "tts.json");
      fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
      fs.writeFileSync(
        prefsPath,
        JSON.stringify({
          tts: {
            auto: "always",
            provider: "openai",
          },
        }),
      );

      delete process.env.OPENCLAW_STATE_DIR;
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
      try {
        expect(
          resolveStatusTtsSnapshot({
            cfg: {
              messages: {
                tts: {},
              },
            } as OpenClawConfig,
          }),
        ).toEqual({
          autoMode: "always",
          provider: "openai",
          maxLength: 1500,
          summarize: true,
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });
});
