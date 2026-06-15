// Docker migration helper tests cover host-state backup and restore invariants.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BACKUP_SCRIPT = "scripts/migrate/backup-openclaw.sh";
const RESTORE_SCRIPT = "scripts/migrate/restore-openclaw.sh";

let tempRoot: string | undefined;

function runScript(script: string, args: string[]) {
  return spawnSync("bash", [script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      HOME: path.join(tempRoot ?? tmpdir(), "home"),
      PATH: process.env.PATH ?? "",
    },
  });
}

async function writeFixtureFile(filePath: string, value: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value);
}

describe("openclaw Docker migration helpers", () => {
  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-migrate-helper-"));
  });

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it("backs up and restores config, workspace, auth-profile secrets, and archive permissions", async () => {
    const root = tempRoot;
    if (!root) {
      throw new Error("missing temp root");
    }

    const repoRoot = path.join(root, "repo");
    const configDir = path.join(root, "config");
    const workspaceDir = path.join(root, "workspace");
    const authProfileSecretDir = path.join(root, "auth-profile-secrets");
    const backupDir = path.join(root, "backups");
    await mkdir(repoRoot, { recursive: true });
    await writeFixtureFile(path.join(configDir, "openclaw.json"), '{"ok":true}\n');
    await writeFixtureFile(path.join(workspaceDir, "scripts", "digest.js"), "console.log('ok');\n");
    await writeFixtureFile(path.join(authProfileSecretDir, "key.json"), '{"secret":true}\n');
    await writeFile(
      path.join(repoRoot, ".env"),
      [
        `OPENCLAW_CONFIG_DIR=${configDir}`,
        `OPENCLAW_WORKSPACE_DIR=${workspaceDir}`,
        `OPENCLAW_AUTH_PROFILE_SECRET_DIR=${authProfileSecretDir}`,
        "OPENCLAW_GATEWAY_TOKEN=redacted-test-token",
        "",
      ].join("\n"),
    );

    const backup = runScript(BACKUP_SCRIPT, [
      "--repo-root",
      repoRoot,
      "--output-dir",
      backupDir,
      "--name",
      "sample",
    ]);
    expect(backup.stderr).toBe("");
    expect(backup.status).toBe(0);

    const archivePath = path.join(backupDir, "sample.tar.gz");
    expect(existsSync(archivePath)).toBe(true);
    expect(existsSync(`${archivePath}.sha256`)).toBe(true);
    expect(statSync(archivePath).mode & 0o077).toBe(0);
    expect(statSync(`${archivePath}.sha256`).mode & 0o077).toBe(0);

    await rm(configDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(authProfileSecretDir, { recursive: true, force: true });
    await writeFixtureFile(path.join(configDir, "stale.json"), "{}\n");
    await writeFixtureFile(path.join(workspaceDir, "stale.txt"), "old\n");
    await writeFixtureFile(path.join(authProfileSecretDir, "stale.key"), "old\n");
    writeFileSync(path.join(repoRoot, ".env"), "OPENCLAW_GATEWAY_TOKEN=old\n");

    const restore = runScript(RESTORE_SCRIPT, [
      "--repo-root",
      repoRoot,
      "--archive",
      archivePath,
      "--config-dir",
      configDir,
      "--workspace-dir",
      workspaceDir,
      "--auth-profile-secret-dir",
      authProfileSecretDir,
      "--no-stop",
      "--apply-env",
    ]);
    expect(restore.stderr).toBe("");
    expect(restore.status).toBe(0);

    expect(readFileSync(path.join(configDir, "openclaw.json"), "utf8")).toBe('{"ok":true}\n');
    expect(readFileSync(path.join(workspaceDir, "scripts", "digest.js"), "utf8")).toBe(
      "console.log('ok');\n",
    );
    expect(readFileSync(path.join(authProfileSecretDir, "key.json"), "utf8")).toBe(
      '{"secret":true}\n',
    );
    expect(readFileSync(path.join(repoRoot, ".env"), "utf8")).toContain(
      "OPENCLAW_GATEWAY_TOKEN=redacted-test-token",
    );
    expect(statSync(path.join(repoRoot, ".env")).mode & 0o077).toBe(0);
  });
});
