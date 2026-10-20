import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  autoMigrateLegacyStateDir,
  resetAutoMigrateLegacyStateDirForTest,
} from "./state-migrations.state-dir.js";

function stateDirFixture(root: string) {
  return {
    root,
    legacyDir: path.join(root, ".clawdbot"),
    targetDir: path.join(root, ".openclaw"),
    write: (file: string, bytes: string | Buffer) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    },
    migrate: (env: NodeJS.ProcessEnv = {}) =>
      autoMigrateLegacyStateDir({ env, homedir: () => root }),
  };
}

async function withStateDirFixture(
  run: (fixture: ReturnType<typeof stateDirFixture>) => Promise<void>,
) {
  try {
    await withTestDir({ prefix: "openclaw-state-dir-" }, async (root) => {
      await run(stateDirFixture(root));
    });
  } finally {
    resetAutoMigrateLegacyStateDirForTest();
  }
}

it.each(["config", "environment"])(
  "preserves retired OAuth sidecars selected by %s and reports their relocated recovery path",
  (selection) =>
    withStateDirFixture(async ({ root, legacyDir, targetDir, write, migrate }) => {
      const oauthDir = path.join(legacyDir, "oauth$old");
      const sidecarPath = path.join(oauthDir, "auth-profiles", `${"a".repeat(32)}.json`);
      const sidecarBytes = Buffer.from("retired encrypted bytes\u0000not parsed\n");
      const env: NodeJS.ProcessEnv = {
        HOME: root,
        ...(selection === "environment" ? { OPENCLAW_OAUTH_DIR: oauthDir } : {}),
      };
      write(sidecarPath, sidecarBytes);
      const authStorePath = path.join(legacyDir, "agents/main/agent/auth-profiles.json");
      write(
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
      write(configPath, configBytes);
      const envBefore = { ...env };

      const result = await migrate(env);
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
    }),
);

it("skips a legacy symlinked state dir when it points outside supported legacy roots", () =>
  withStateDirFixture(async ({ root, legacyDir: legacySymlink, write, migrate }) => {
    const legacyDir = path.join(root, "legacy-state-source");
    write(path.join(legacyDir, "marker.txt"), "ok");
    const dirLinkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(legacyDir, legacySymlink, dirLinkType);

    const result = await migrate();

    expect(result.migrated).toBe(false);
    expect(result.warnings).toEqual([
      `Legacy state path is not a directory: ${legacySymlink}; move it manually before rerunning Doctor.`,
    ]);
    expect(fs.readFileSync(path.join(legacyDir, "marker.txt"), "utf8")).toBe("ok");
    expect(fs.readFileSync(path.join(legacySymlink, "marker.txt"), "utf8")).toBe("ok");
  }));

it("preserves both directories when the canonical root already exists", () =>
  withStateDirFixture(async ({ legacyDir, targetDir, write, migrate }) => {
    fs.mkdirSync(legacyDir, { recursive: true });
    write(path.join(targetDir, "openclaw.json"), "{}");
    const result = await migrate();

    expect(result).toMatchObject({ migrated: false, skipped: false, changes: [] });
    expect(result.warnings).toEqual([
      `Both ${legacyDir} and ${targetDir} exist; leave them unchanged and move the legacy data manually before rerunning Doctor.`,
    ]);
    expect(fs.lstatSync(legacyDir).isDirectory()).toBe(true);
    expect(fs.readdirSync(legacyDir)).toEqual([]);
    expect(fs.readFileSync(path.join(targetDir, "openclaw.json"), "utf8")).toBe("{}");
  }));

it.each(["OPENCLAW_STATE_DIR", "OPENCLAW_HOME", "OPENCLAW_CONFIG_PATH"])(
  "skips state-dir migration when %s is explicitly set",
  (selector) =>
    withStateDirFixture(async ({ root, legacyDir, migrate }) => {
      fs.mkdirSync(legacyDir, { recursive: true });
      const result = await migrate({ [selector]: path.join(root, "custom-state") });
      expect(result).toEqual({ migrated: false, skipped: true, changes: [], warnings: [] });
      expect(fs.existsSync(legacyDir)).toBe(true);
    }),
);

it.each([
  ["plugins/installs.json", '{"records":{"demo":{"source":"npm","spec":"demo@1.0.0"}}}'],
  ["session-delivery-queue/pending.json", '{"id":"retired","payloads":[{"text":"preserve"}]}\n'],
])("relocates %s unchanged for Doctor repair", (relative, source) =>
  withStateDirFixture(async ({ legacyDir, targetDir, write, migrate }) => {
    const sourcePath = path.join(legacyDir, relative);
    write(path.join(legacyDir, "marker.txt"), "ok");
    write(sourcePath, source);
    expect(await migrate()).toMatchObject({ migrated: true, skipped: false, warnings: [] });
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(fs.readFileSync(path.join(targetDir, relative))).toEqual(Buffer.from(source));
    expect(fs.readFileSync(path.join(targetDir, "marker.txt"), "utf8")).toBe("ok");
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "state", "openclaw.sqlite"))).toBe(false);
  }),
);
