import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listGitTrackedFiles } from "../../test-utils/repo-files.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SERVICE_IMPLEMENTATION = "src/skills/api/service.ts";
const WORKSHOP_IMPLEMENTATION = "src/skills/workshop/service.ts";

const GUARDED_IMPORTS = [
  {
    symbols: "applySkillProposal|proposeCreateSkill|proposeUpdateSkill",
    module: "workshop/service",
    allowed: new Set([SERVICE_IMPLEMENTATION]),
  },
  {
    symbols: "writeWorkspaceSkill",
    module: "lifecycle/workspace-skill-write",
    allowed: new Set([SERVICE_IMPLEMENTATION, WORKSHOP_IMPLEMENTATION]),
  },
  {
    symbols: "installExtractedSkillRoot|installSkillArchiveFromPath",
    module: "lifecycle/archive-install",
    allowed: new Set([SERVICE_IMPLEMENTATION]),
  },
  {
    symbols: "refreshSkillsSnapshot",
    module: "api/refresh",
    allowed: new Set([SERVICE_IMPLEMENTATION]),
  },
] as const;

describe("skills write service boundary", () => {
  it("keeps production mutation entry points behind skillsWriteService", () => {
    const files = listGitTrackedFiles({ pathspecs: "src", repoRoot: REPO_ROOT });
    expect(files).not.toBeNull();

    for (const repoPath of files ?? []) {
      if (!repoPath.endsWith(".ts") || repoPath.endsWith(".test.ts")) {
        continue;
      }
      const source = fs.readFileSync(path.join(REPO_ROOT, repoPath), "utf8");
      for (const guard of GUARDED_IMPORTS) {
        if (guard.allowed.has(repoPath)) {
          continue;
        }
        const forbiddenImport = new RegExp(
          `import\\s*\\{[^}]*\\b(?:${guard.symbols})\\b[^}]*\\}\\s*from\\s*["'][^"']*${guard.module}\\.js["']`,
          "s",
        );
        expect(source, `${repoPath} bypasses skillsWriteService`).not.toMatch(forbiddenImport);
      }
    }
  });
});
