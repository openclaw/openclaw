import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listSkillProposalEvents } from "../../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import { readSkillProposalRecord } from "../../skills/workshop/store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool as createSkillWorkshopToolImpl } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
const createSkillWorkshopTool = (
  options: Omit<Parameters<typeof createSkillWorkshopToolImpl>[0], "config" | "agentId"> & {
    config?: OpenClawConfig;
    agentId?: string;
  },
) => createSkillWorkshopToolImpl({ config: {}, agentId: "main", ...options });

async function proposalDraftPath(proposalId: string): Promise<string> {
  const record = await readSkillProposalRecord(
    proposalId,
    { config: {}, env: testState.env },
    {},
    { config: {} },
  );
  if (!record) {
    throw new Error(`expected stored proposal ${proposalId}`);
  }
  return path.join(testState.stateDir, "skill-workshop", "proposals", proposalId, record.draftFile);
}

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-lifecycle-state-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("skill_workshop terminal lifecycle", () => {
  it("requires an exact revision to purge a rejected proposal", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-purge-");
    const tool = createSkillWorkshopTool({ workspaceDir, agentId: "main", env: testState.env });
    const created = await tool.execute("create-purge", {
      action: "create",
      name: "Discard Me",
      description: "Disposable proposal",
      proposal_content: "# Discard Me\n",
    });
    const { id, revisionHash } = created.details as { id: string; revisionHash: string };
    await expect(
      tool.execute("purge-pending", {
        action: "purge",
        proposal_id: id,
        expected_revision_hash: revisionHash,
      }),
    ).rejects.toThrow("Only rejected proposals can be purged");
    await tool.execute("reject-purge", { action: "reject", proposal_id: id });
    await expect(
      tool.execute("purge-no-hash", { action: "purge", proposal_id: id }),
    ).rejects.toThrow();
    const inspected = await tool.execute("inspect-purge", { action: "inspect", proposal_id: id });
    const rejectedRevision = (inspected.details as { revisionHash: string }).revisionHash;
    await expect(
      tool.execute("purge-rejected", {
        action: "purge",
        proposal_id: id,
        expected_revision_hash: rejectedRevision,
      }),
    ).resolves.toMatchObject({ details: { proposalId: id, purged: true } });
    await expect(
      fs.access(path.join(testState.stateDir, "skill-workshop", "proposals", id)),
    ).rejects.toThrow();
  });

  it("disposes of proposals without reading damaged draft artifacts", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-damaged-drafts-");
    const tool = createSkillWorkshopTool({ workspaceDir, agentId: "main", env: testState.env });
    const draftDamageCases: Array<readonly [string, (draft: string) => Promise<void>]> = [
      ["altered", async (draft) => await fs.writeFile(draft, "# Altered\n", "utf8")],
      ["missing", async (draft) => await fs.unlink(draft)],
      [
        "oversized",
        async (draft) => await fs.writeFile(draft, Buffer.alloc(1024 * 1024 + 1, 0x78)),
      ],
    ];
    if (process.platform !== "win32") {
      draftDamageCases.push(
        [
          "symlinked",
          async (draft) => {
            const target = `${draft}.target`;
            await fs.rename(draft, target);
            await fs.symlink(target, draft);
          },
        ],
        ["hardlinked", async (draft) => await fs.link(draft, `${draft}.alias`)],
      );
    }

    for (const action of ["reject", "quarantine"] as const) {
      const expectedStatus = action === "reject" ? "rejected" : "quarantined";
      for (const [damage, damageDraft] of draftDamageCases) {
        const created = await tool.execute(`create-${action}-${damage}`, {
          action: "create",
          name: `${action} ${damage}`,
          description: `Dispose of a ${damage} proposal`,
          proposal_content: `# ${action} ${damage}\n\nDisposable draft.\n`,
        });
        const details = created.details as { id: string; revisionHash: string };
        await damageDraft(await proposalDraftPath(details.id));

        await expect(
          tool.execute(`apply-${action}-${damage}`, {
            action: "apply",
            proposal_id: details.id,
            expected_revision_hash: details.revisionHash,
          }),
        ).rejects.toThrow();
        await expect(
          tool.execute(`${action}-${damage}`, {
            action,
            proposal_id: details.id,
            expected_revision_hash: details.revisionHash,
          }),
        ).resolves.toMatchObject({ details: { id: details.id, status: expectedStatus } });
        await expect(
          readSkillProposalRecord(
            details.id,
            { config: {}, env: testState.env },
            {},
            { config: {} },
          ),
        ).resolves.toMatchObject({ status: expectedStatus });
        expect(
          (
            await listSkillProposalEvents({
              config: {},
              proposalId: details.id,
              env: testState.env,
            })
          ).events.at(-1)?.type,
        ).toBe(expectedStatus);
        await expect(
          fs.access(
            path.join(
              resolveWorkshopSkillsDir({}, "main", testState.env),
              `${action}-${damage}`,
              "SKILL.md",
            ),
          ),
        ).rejects.toThrow();
      }
    }
  });
});
