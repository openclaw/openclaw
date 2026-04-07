import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectWorkspaceSkillSymlinkEscapeFindings } from "./audit-extra.async.js";

const isWindows = process.platform === "win32";

describe("security audit workspace skill path escape findings", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-security-audit-workspace-"));
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

  it("evaluates workspace skill path escape findings", async () => {
    const runs = [
      !isWindows
        ? (async () => {
            const tmp = await makeTmpDir("workspace-skill-symlink-escape");
            const workspaceDir = path.join(tmp, "workspace");
            const outsideDir = path.join(tmp, "outside");
            await fs.mkdir(path.join(workspaceDir, "skills", "leak"), { recursive: true });
            await fs.mkdir(outsideDir, { recursive: true });
            const outsideSkillPath = path.join(outsideDir, "SKILL.md");
            await fs.writeFile(outsideSkillPath, "# outside\n", "utf-8");
            await fs.symlink(
              outsideSkillPath,
              path.join(workspaceDir, "skills", "leak", "SKILL.md"),
            );
            const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
              cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
            });
            const finding = findings.find(
              (entry) => entry.checkId === "skills.workspace.symlink_escape",
            );
            expect(finding?.severity).toBe("warn");
            expect(finding?.detail).toContain(outsideSkillPath);
          })()
        : Promise.resolve(),
      (async () => {
        const tmp = await makeTmpDir("workspace-skill-in-root");
        const workspaceDir = path.join(tmp, "workspace");
        await fs.mkdir(path.join(workspaceDir, "skills", "safe"), { recursive: true });
        await fs.writeFile(
          path.join(workspaceDir, "skills", "safe", "SKILL.md"),
          "# in workspace\n",
          "utf-8",
        );
        const findings = await collectWorkspaceSkillSymlinkEscapeFindings({
          cfg: { agents: { defaults: { workspace: workspaceDir } } } satisfies OpenClawConfig,
        });
        expect(findings.some((entry) => entry.checkId === "skills.workspace.symlink_escape")).toBe(
          false,
        );
      })(),
    ];

    await Promise.all(runs);
  });
});
