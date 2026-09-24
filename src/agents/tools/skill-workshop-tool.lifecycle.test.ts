import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listSkillProposalEvents } from "../../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import { readSkillProposalRecord } from "../../skills/workshop/store.js";
import type { SkillWorkshopProposalMutationBudget } from "../../skills/workshop/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { createAgentToolExecutionBudget } from "../agent-tool-source-execution-guard.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
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
  it.each(["abort", "closed-run", "budget"] as const)(
    "rejects %s during execution loading before reserving a mutation",
    async (loss) => {
      const proposalMutationBudget = { remaining: 1 };
      const tool = createSkillWorkshopTool({
        workspaceDir: testState.workspaceDir,
        env: testState.env,
        proposalMutationBudget,
      });
      const admission = prepareSystemAgentRunAdmission({}, `workshop-${loss}`, "main", "test");
      const context = await admission.admit("embedded");
      const controller = new AbortController();
      let current = true;
      const budget = createAgentToolExecutionBudget({
        signal: controller.signal,
        abort: (reason) => controller.abort(reason),
        isCurrent: () => current,
      });
      try {
        const result = budget.run(() =>
          withGatewayToolCallerIdentity(
            createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: context,
              agentId: "main",
              sessionKey: "agent:main:workshop",
            }),
            () =>
              tool.execute(
                "create",
                {
                  action: "create",
                  name: "revoked",
                  description: "Must not be persisted",
                  proposal_content: "# Revoked\n",
                },
                controller.signal,
              ),
          ),
        );
        if (loss === "abort") {
          controller.abort(new Error("workshop call aborted"));
        } else if (loss === "closed-run") {
          admission.close();
        } else {
          current = false;
        }
        await expect(result).rejects.toThrow(
          loss === "abort" ? "workshop call aborted" : "no longer active",
        );
        expect(proposalMutationBudget.remaining).toBe(1);
        await expect(
          fs.access(path.join(testState.stateDir, "skill-workshop", "proposals")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        admission.close();
      }
    },
  );

  it("shares one mutation reservation across simultaneous first calls and retry tools", async () => {
    const proposalMutationBudget: SkillWorkshopProposalMutationBudget = { remaining: 1 };
    const tools = [0, 1].map(() =>
      createSkillWorkshopTool({
        workspaceDir: testState.workspaceDir,
        env: testState.env,
        proposalMutationBudget,
      }),
    );
    const results = await Promise.allSettled(
      tools.map((tool, index) =>
        tool.execute(`create-${index}`, {
          action: "create",
          name: `parallel-${index}`,
          description: "One shared proposal reservation",
          proposal_content: "# Parallel\n",
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ message: expect.stringContaining("mutation limit") }),
    });
    expect(proposalMutationBudget.remaining).toBe(0);
    expect(proposalMutationBudget.mutatedProposalIds?.size).toBe(1);
    expect(await tools[0]!.execute("list", { action: "list" })).toMatchObject({
      details: { proposals: [expect.objectContaining({ status: "pending" })] },
    });
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
