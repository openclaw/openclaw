import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectFilesystemFindings } from "./audit.js";

const isWindows = process.platform === "win32";

describe("security audit config symlink findings", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-audit-config-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  const makeTmpDir = async (label: string) => {
    const dir = path.join(fixtureRoot, `case-${caseId++}-${label}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  it("uses symlink target permissions for config checks", async () => {
    if (isWindows) {
      return;
    }

    const tmp = await makeTmpDir("config-symlink");
    const stateDir = path.join(tmp, "state");
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });

    const targetConfigPath = path.join(tmp, "managed-openclaw.json");
    await fs.writeFile(targetConfigPath, "{}\n", "utf-8");
    await fs.chmod(targetConfigPath, 0o444);

    const configPath = path.join(stateDir, "openclaw.json");
    await fs.symlink(targetConfigPath, configPath);

    const findings = await collectFilesystemFindings({
      stateDir,
      configPath,
    });

    expect(findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ checkId: "fs.config.symlink" })]),
    );
    expect(findings.some((finding) => finding.checkId === "fs.config.perms_writable")).toBe(false);
    expect(findings.some((finding) => finding.checkId === "fs.config.perms_world_readable")).toBe(
      false,
    );
    expect(findings.some((finding) => finding.checkId === "fs.config.perms_group_readable")).toBe(
      false,
    );
  });
});
