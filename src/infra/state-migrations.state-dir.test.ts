// Verifies state-dir migrations preserve existing OpenClaw runtime data.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  autoMigrateLegacyStateDir,
  resetAutoMigrateLegacyStateDirForTest,
} from "./state-migrations.state-dir.js";

async function withStateDirFixture(run: (root: string) => Promise<void>): Promise<void> {
  try {
    await withTestDir({ prefix: "openclaw-state-dir-" }, async (root) => {
      await run(root);
    });
  } finally {
    resetAutoMigrateLegacyStateDirForTest();
  }
}

describe("legacy state dir auto-migration", () => {
  it.each(["config", "environment"])(
    "preserves retired OAuth sidecars selected by %s and reports their relocated recovery path",
    async (selection) => {
      await withStateDirFixture(async (root) => {
        const legacyDir = path.join(root, ".clawdbot");
        const targetDir = path.join(root, ".openclaw");
        const oauthDir = path.join(legacyDir, "oauth$old");
        const sidecarPath = path.join(oauthDir, "auth-profiles", `${"a".repeat(32)}.json`);
        const sidecarBytes = Buffer.from("retired encrypted bytes\u0000not parsed\n");
        const env: NodeJS.ProcessEnv = {
          HOME: root,
          ...(selection === "environment" ? { OPENCLAW_OAUTH_DIR: oauthDir } : {}),
        };
        fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
        fs.writeFileSync(sidecarPath, sidecarBytes);
        const authStorePath = path.join(legacyDir, "agents/main/agent/auth-profiles.json");
        fs.mkdirSync(path.dirname(authStorePath), { recursive: true });
        fs.writeFileSync(
          authStorePath,
          JSON.stringify({
            profiles: {
              "openai-codex:default": {
                type: "oauth",
                provider: "openai-codex",
                oauthRef: {
                  source: "openclaw-credentials",
                  provider: "openai-codex",
                  id: "a".repeat(32),
                },
              },
            },
          }),
        );
        const configPath = path.join(legacyDir, "clawdbot.json");
        const configBytes = JSON.stringify(
          selection === "config"
            ? { env: { vars: { OPENCLAW_OAUTH_DIR: "~/.clawdbot/oauth$old" } } }
            : {},
        );
        fs.writeFileSync(configPath, configBytes);
        const envBefore = { ...env };

        const result = await autoMigrateLegacyStateDir({ env, homedir: () => root });
        const movedOAuthDir = path.join(targetDir, "oauth$old");
        expect(result).toMatchObject({ migrated: true, skipped: false });
        expect(result.warnings).toEqual([
          expect.stringContaining(`OPENCLAW_OAUTH_DIR='${movedOAuthDir}' openclaw doctor --fix`),
        ]);
        expect(result.warnings[0]).toContain(oauthDir);
        expect(result.warnings[0]).toContain("update the configured OPENCLAW_OAUTH_DIR");
        expect(fs.existsSync(legacyDir)).toBe(false);
        expect(
          fs.readFileSync(path.join(movedOAuthDir, "auth-profiles", `${"a".repeat(32)}.json`)),
        ).toEqual(sidecarBytes);
        expect(fs.readFileSync(path.join(targetDir, "clawdbot.json"), "utf8")).toBe(configBytes);
        expect(env).toEqual(envBefore);
      });
    },
  );

  it("skips a legacy symlinked state dir when it points outside supported legacy roots", async () => {
    await withStateDirFixture(async (root) => {
      const legacySymlink = path.join(root, ".clawdbot");
      const legacyDir = path.join(root, "legacy-state-source");

      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "marker.txt"), "ok", "utf-8");

      const dirLinkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(legacyDir, legacySymlink, dirLinkType);

      const result = await autoMigrateLegacyStateDir({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(result.migrated).toBe(false);
      expect(result.warnings).toEqual([
        `Legacy state path is not a directory: ${legacySymlink}; move it manually before rerunning Doctor.`,
      ]);
      expect(fs.readFileSync(path.join(root, "legacy-state-source", "marker.txt"), "utf-8")).toBe(
        "ok",
      );
      expect(fs.readFileSync(path.join(root, ".clawdbot", "marker.txt"), "utf-8")).toBe("ok");
    });
  });

  it("preserves both directories when the canonical root already exists", async () => {
    await withStateDirFixture(async (root) => {
      const legacyDir = path.join(root, ".clawdbot");
      const targetDir = path.join(root, ".openclaw");
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "openclaw.json"), "{}", "utf-8");

      const result = await autoMigrateLegacyStateDir({
        env: {} as NodeJS.ProcessEnv,
        homedir: () => root,
      });

      expect(result).toMatchObject({ migrated: false, skipped: false, changes: [] });
      expect(result.warnings).toEqual([
        `Both ${legacyDir} and ${targetDir} exist; leave them unchanged and move the legacy data manually before rerunning Doctor.`,
      ]);
      expect(fs.lstatSync(legacyDir).isDirectory()).toBe(true);
      expect(fs.readdirSync(legacyDir)).toEqual([]);
      expect(fs.readFileSync(path.join(targetDir, "openclaw.json"), "utf8")).toBe("{}");
    });
  });

  it.each(["OPENCLAW_STATE_DIR", "OPENCLAW_HOME", "OPENCLAW_CONFIG_PATH"])(
    "skips state-dir migration when %s is explicitly set",
    async (selector) => {
      await withStateDirFixture(async (root) => {
        const legacyDir = path.join(root, ".clawdbot");
        fs.mkdirSync(legacyDir, { recursive: true });

        const result = await autoMigrateLegacyStateDir({
          env: { [selector]: path.join(root, "custom-state") },
          homedir: () => root,
        });

        expect(result).toEqual({
          migrated: false,
          skipped: true,
          changes: [],
          warnings: [],
        });
        expect(fs.existsSync(legacyDir)).toBe(true);
      });
    },
  );

  it("relocates pre-July plugin JSON unchanged for Doctor repair", async () => {
    await withStateDirFixture(async (root) => {
      const stateDir = path.join(root, ".clawdbot");
      const sourcePath = path.join(stateDir, "plugins", "installs.json");
      const source = '{"records":{"demo":{"source":"npm","spec":"demo@1.0.0"}}}';
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, source);

      const result = await autoMigrateLegacyStateDir({
        env: {},
        homedir: () => root,
      });

      const targetDir = path.join(root, ".openclaw");
      expect(result).toMatchObject({ migrated: true, skipped: false, warnings: [] });
      expect(fs.readFileSync(path.join(targetDir, "plugins", "installs.json"), "utf8")).toBe(
        source,
      );
      expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
      expect(fs.existsSync(path.join(targetDir, "state", "openclaw.sqlite"))).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(false);
    });
  });

  it("relocates retired session delivery state unchanged for Doctor archival", async () => {
    await withStateDirFixture(async (root) => {
      const legacyDir = path.join(root, ".clawdbot");
      const targetDir = path.join(root, ".openclaw");
      const stateDir = legacyDir;
      const sourcePath = path.join(stateDir, "session-delivery-queue/pending.json");
      const sourceBytes = Buffer.from('{"id":"retired","payloads":[{"text":"preserve"}]}\n');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "marker.txt"), "ok", "utf8");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, sourceBytes);
      const params = {
        env: {},
        homedir: () => root,
      };

      const recovered = await autoMigrateLegacyStateDir(params);
      expect(recovered).toMatchObject({
        migrated: true,
        skipped: false,
        warnings: [],
      });
      expect(fs.existsSync(legacyDir)).toBe(false);
      expect(fs.readFileSync(path.join(targetDir, "session-delivery-queue/pending.json"))).toEqual(
        sourceBytes,
      );
      expect(fs.readFileSync(path.join(targetDir, "marker.txt"), "utf8")).toBe("ok");
    });
  });
});
