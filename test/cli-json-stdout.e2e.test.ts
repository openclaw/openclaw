import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";

describe("cli json stdout contract", () => {
  it("keeps `status --json` stdout parseable when SecretRef diagnostics are emitted", async () => {
    await withTempHome(
      async (tempHome) => {
        const configDir = path.join(tempHome, ".openclaw");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "openclaw.json"),
          JSON.stringify(
            {
              channels: {
                discord: {
                  enabled: true,
                  token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
                },
              },
              secrets: {
                providers: {
                  default: { source: "env" },
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
        delete env.DISCORD_BOT_TOKEN;
        delete env.OPENCLAW_HOME;
        delete env.OPENCLAW_STATE_DIR;
        delete env.OPENCLAW_CONFIG_PATH;
        delete env.VITEST;

        const entry = path.resolve(process.cwd(), "src/entry.ts");
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", entry, "status", "--json", "--timeout", "1"],
          { cwd: process.cwd(), env, encoding: "utf8" },
        );

        expect(result.status).toBe(0);
        const stdout = result.stdout.trim();
        expect(stdout.startsWith("{")).toBe(true);
        expect(stdout).not.toContain("[secrets]");

        const parsed = JSON.parse(stdout) as { secretDiagnostics?: unknown };
        expect(Array.isArray(parsed.secretDiagnostics)).toBe(true);
        expect(parsed.secretDiagnostics).toEqual(
          expect.arrayContaining([
            expect.stringContaining("channels.discord.token"),
            expect.stringContaining("DISCORD_BOT_TOKEN"),
          ]),
        );
      },
      { prefix: "openclaw-status-json-secretref-" },
    );
  });

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

        const entry = path.resolve(process.cwd(), "src/entry.ts");
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", entry, "update", "status", "--json", "--timeout", "1"],
          { cwd: process.cwd(), env, encoding: "utf8" },
        );

        expect(result.status).toBe(0);
        const stdout = result.stdout.trim();
        expect(stdout.length).toBeGreaterThan(0);
        const parsed = JSON.parse(stdout) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`Expected JSON object stdout, got: ${stdout}`);
        }
        expect(Object.keys(parsed).toSorted((a, b) => a.localeCompare(b))).toEqual([
          "availability",
          "channel",
          "update",
        ]);
        expect(stdout).not.toContain("Doctor warnings");
        expect(stdout).not.toContain("Doctor changes");
        expect(stdout).not.toContain("Config invalid");
      },
      { prefix: "openclaw-json-e2e-" },
    );
  });
});
