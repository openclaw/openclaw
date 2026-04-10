import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "./io.js";

describe("config io warning logging", () => {
  let fixtureRoot = "";
  let homeCaseId = 0;

  async function withSuiteHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${homeCaseId++}`);
    await fs.mkdir(home, { recursive: true });
    return await fn(home);
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-warning-dedupe-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("logs repeated config warnings once per unchanged load and uses real newlines", async () => {
    await withSuiteHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            plugins: {
              allow: ["google-antigravity-auth"],
              deny: ["google-antigravity-auth"],
              slots: {
                memory: "google-antigravity-auth",
              },
              entries: {
                "google-antigravity-auth": {
                  enabled: true,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const warn = vi.fn();
      const io = createConfigIO({
        env: {
          HOME: home,
          OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
          OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
          OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "10000",
          VITEST: "true",
        } as NodeJS.ProcessEnv,
        homedir: () => home,
        logger: {
          warn,
          error: vi.fn(),
        },
      });

      io.loadConfig();
      io.loadConfig();

      const warningCalls = warn.mock.calls
        .map((call) => call[0])
        .filter(
          (message): message is string =>
            typeof message === "string" && message.startsWith("Config warnings:"),
        );

      expect(warningCalls).toHaveLength(1);
      expect(warningCalls[0]).toContain(
        "Config warnings:\n- plugins.entries.google-antigravity-auth:",
      );
      expect(warningCalls[0]).toContain("- plugins.allow:");
      expect(warningCalls[0]).not.toContain("\\n");
    });
  });
});
