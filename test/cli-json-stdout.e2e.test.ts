import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./helpers/temp-home.ts";

describe("cli json stdout contract", () => {
  it("keeps `update status --json` stdout parseable even with legacy doctor preflight inputs", async () => {
    await withTempHome(
      async (tempHome) => {
        const legacyDir = path.join(tempHome, ".clawdbot");
        await fs.mkdir(legacyDir, { recursive: true });
        await fs.writeFile(path.join(legacyDir, "clawdbot.json"), "{}", "utf8");

        const env = {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          OPENCLAW_TEST_FAST: "1",
        };
        delete env.OPENCLAW_HOME;
        delete env.OPENCLAW_STATE_DIR;
        delete env.OPENCLAW_CONFIG_PATH;
        delete env.VITEST;

        const entry = path.resolve(process.cwd(), "openclaw.mjs");
        const result = spawnSync(
          process.execPath,
          [entry, "update", "status", "--json", "--timeout", "1"],
          { cwd: process.cwd(), env, encoding: "utf8" },
        );

        expect(result.status).toBe(0);
        const stdout = result.stdout.trim();
        expect(stdout.length).toBeGreaterThan(0);
        expect(() => JSON.parse(stdout)).not.toThrow();
        expect(stdout).not.toContain("Doctor warnings");
        expect(stdout).not.toContain("Doctor changes");
        expect(stdout).not.toContain("Config invalid");
      },
      { prefix: "openclaw-json-e2e-" },
    );
  });

  it("keeps `status --json` stdout parseable when configured channels trigger plugin registry loading", async () => {
    await withTempHome(
      async (tempHome) => {
        const configDir = path.join(tempHome, ".openclaw");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "openclaw.json"),
          JSON.stringify(
            {
              channels: {
                telegram: {
                  tokenFile: "/tmp/openclaw-test-token",
                },
              },
            },
            null,
            2,
          ),
          "utf8",
        );

        const env = {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
          OPENCLAW_TEST_FAST: "1",
        };
        delete env.OPENCLAW_HOME;
        delete env.OPENCLAW_STATE_DIR;
        delete env.OPENCLAW_CONFIG_PATH;
        delete env.VITEST;

        const entry = path.resolve(process.cwd(), "openclaw.mjs");
        const result = spawnSync(process.execPath, [entry, "status", "--json", "--timeout", "1"], {
          cwd: process.cwd(),
          env,
          encoding: "utf8",
          timeout: 30000,
        });

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);

        const stdout = result.stdout.trim();
        expect(stdout.length).toBeGreaterThan(0);
        expect(() => JSON.parse(stdout)).not.toThrow();
      },
      { prefix: "openclaw-status-json-e2e-" },
    );
  });
});
