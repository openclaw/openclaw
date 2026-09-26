import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { listSkillProposals, proposeUpdateSkill } from "./service.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const tempDirs = createTrackedTempDirs();
let testEnv: NodeJS.ProcessEnv;

beforeAll(async () => {
  const stateDir = await tempDirs.make("openclaw-skill-workshop-authority-state-");
  testEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_AGENT_DIR: undefined,
  };
  await listSkillProposals({ config: {}, agentId: "main", env: testEnv });
});

afterAll(async () => {
  closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(testEnv));
  await tempDirs.cleanup();
});

describe("skill workshop proposal authority", () => {
  it("does not persist an update when authority closes during proposal staging", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-authority-");
    const skillDir = path.join(resolveWorkshopSkillsDir({}, "main", testEnv), "revoked-proposal");
    const skillFile = path.join(skillDir, "SKILL.md");
    await writeSkill({
      dir: skillDir,
      name: "revoked-proposal",
      description: "Keep the original skill when proposal authority closes",
      body: "# Revoked Proposal\n\nOriginal body.\n",
    });
    let authorized = true;
    let checks = 0;

    await expect(
      proposeUpdateSkill({
        workspaceDir,
        skillName: "revoked-proposal",
        content: "# Revoked Proposal\n\nForbidden replacement.\n",
        config: {},
        agentId: "main",
        env: testEnv,
        assertMutationAuthorized: () => {
          checks += 1;
          if (checks === 1) {
            queueMicrotask(() => {
              authorized = false;
            });
          }
          if (!authorized) {
            throw new Error("run authority closed during proposal staging");
          }
        },
      }),
    ).rejects.toThrow("run authority closed during proposal staging");

    expect(checks).toBe(2);
    await expect(
      listSkillProposals({ config: {}, agentId: "main", env: testEnv }),
    ).resolves.toMatchObject({ proposals: [] });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("Original body.");
  });
});
