import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { commandsHandlers } from "./commands.js";
import { skillsHandlers } from "./skills.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["worktree", "cwd"] as const)(
  "discovers only the selected %s's project skills in session catalogs",
  async (kind) => {
    await withOpenClawTestState({ label: "project-skills-catalog" }, async (state) => {
      const project = path.join(state.root, "project", "nested");
      const checkout = path.join(state.root, "checkout");
      const bundled = path.join(state.root, "bundled");
      await fs.mkdir(bundled, { recursive: true });
      vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", bundled);
      const cfg = {
        plugins: { enabled: false },
        skills: { load: { watch: false }, entries: { "project-disabled": { enabled: false } } },
        agents: { entries: { proof: { workspace: state.workspaceDir } } },
      };
      for (const [root, name, description] of [
        [state.workspaceDir, "agent-helper", "Agent helper"],
        [state.workspaceDir, "shared-review", "Agent wins"],
        [project, "project-review", "Project review"],
        [project, "project-disabled", "Disabled project skill"],
        [project, "shared-review", "Project loses"],
        [path.dirname(project), "parent-only", "Do not walk ancestors"],
        [checkout, "checkout-only", "Use the canonical source"],
      ] as const) {
        await writeSkill({
          dir: path.join(root, ".agents", "skills", name),
          name,
          description,
        });
      }
      const sessionKey = "agent:proof:dashboard:project-skills";
      await upsertSessionEntryCore(
        { agentId: "proof", sessionKey },
        {
          sessionId: "project-skills",
          updatedAt: 1,
          spawnedCwd: kind === "worktree" ? checkout : project,
          ...(kind === "worktree"
            ? {
                worktree: {
                  id: "project",
                  branch: "proof",
                  repoRoot: path.dirname(project),
                  canonicalWorkspaceDir: project,
                },
              }
            : {}),
        },
      );
      const context = { getRuntimeConfig: () => cfg };
      const status = await callGatewayHandler(
        skillsHandlers,
        "skills.status",
        { agentId: "proof", sessionKey },
        { context },
      );
      expect(status).toMatchObject({
        ok: true,
        response: {
          skills: expect.arrayContaining([
            expect.objectContaining({ name: "agent-helper", eligible: true }),
            expect.objectContaining({ name: "project-review", eligible: true }),
            expect.objectContaining({ name: "project-disabled", disabled: true }),
            expect.objectContaining({ name: "shared-review", description: "Agent wins" }),
          ]),
        },
      });
      for (const hidden of ["parent-only", "checkout-only"]) {
        expect(JSON.stringify(status.response)).not.toContain(hidden);
      }
      const commands = await callGatewayHandler(
        commandsHandlers,
        "commands.list",
        { agentId: "proof", sessionKey },
        { context },
      );
      expect(commands).toMatchObject({
        ok: true,
        response: {
          commands: expect.arrayContaining([
            expect.objectContaining({ source: "skill", skillDisplayName: "agent-helper" }),
            expect.objectContaining({ source: "skill", skillDisplayName: "project-review" }),
          ]),
        },
      });
      expect(JSON.stringify(commands.response)).not.toContain("project-disabled");
      const agentOnly = await callGatewayHandler(
        skillsHandlers,
        "skills.status",
        { agentId: "proof" },
        { context },
      );
      expect(agentOnly.ok).toBe(true);
      expect(JSON.stringify(agentOnly.response)).not.toContain("project-review");
      const otherSessionKey = "agent:proof:dashboard:other-project";
      await upsertSessionEntryCore(
        { agentId: "proof", sessionKey: otherSessionKey },
        { sessionId: "other-project", updatedAt: 1 },
      );
      const other = await callGatewayHandler(
        commandsHandlers,
        "commands.list",
        { agentId: "proof", sessionKey: otherSessionKey },
        { context },
      );
      expect(other.ok).toBe(true);
      expect(JSON.stringify(other.response)).not.toContain("project-review");
    });
  },
);
