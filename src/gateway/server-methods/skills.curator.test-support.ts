import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { expect, it } from "vitest";
import {
  SkillsCuratorLiveStatusResultSchema,
  SkillsCuratorStatusResultSchema,
} from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applySkillProposal, proposeCreateSkill } from "../../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { callGatewayHandler } from "./skills.test-helpers.js";
import type { GatewayClient } from "./types.js";

const curatorClient: GatewayClient = {
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "cli", version: "test", platform: "test", mode: "cli" },
    role: "operator",
    scopes: ["operator.read"],
    caps: ["skill-curator-live-inventory"],
  },
};

export function registerSkillCuratorHandlerSuite({
  callHandler,
  getTestState,
  getWorkspaceDir,
}: {
  callHandler: (
    method: string,
    params: Record<string, unknown>,
    options?: Parameters<typeof callGatewayHandler>[3],
  ) => ReturnType<typeof callGatewayHandler>;
  getTestState: () => OpenClawTestState;
  getWorkspaceDir: () => string;
}) {
  async function writeInventorySkill(
    config: OpenClawConfig,
    agentId: string,
    directory: string,
    name = directory,
  ) {
    const skillFile = path.join(
      resolveWorkshopSkillsDir(config, agentId, getTestState().env),
      directory,
      "SKILL.md",
    );
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(
      skillFile,
      `---\nname: ${name}\ndescription: Inventory fixture\n---\nInstructions\n`,
    );
    return skillFile;
  }

  it("projects only known-date live entries for legacy clients using the unchanged closed schema", async () => {
    const config = {
      agents: { entries: { main: { agentDir: getTestState().path("legacy-agent") } } },
    };
    const proposal = await proposeCreateSkill({
      config,
      agentId: "main",
      env: getTestState().env,
      workspaceDir: getWorkspaceDir(),
      name: "Known",
      description: "Known skill",
      content: "# Known\nInstructions\n",
      createdBy: "gateway",
    });
    const applied = await applySkillProposal({
      config,
      agentId: "main",
      env: getTestState().env,
      workspaceDir: getWorkspaceDir(),
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });
    if (!applied.record.appliedAt) {
      throw new Error("Expected an applied proposal date");
    }
    const skillFile = proposal.record.target.skillFile;
    await fs.writeFile(
      skillFile,
      `---\nname: known\ndescription: Known skill\nmetadata: '{"openclaw":{"skillKey":""}}'\n---\nInstructions\n`,
    );
    const directFile = await writeInventorySkill(config, "main", "direct");
    const database = openOpenClawStateDatabase({ env: getTestState().env });
    database.db
      .prepare(
        `INSERT INTO skill_usage (skill_file, skill_key, skill_name, skill_source, first_used_at_ms, last_used_at_ms, use_count, last_agent_id) VALUES (?, 'known', 'Known', 'workspace', 1000, 2000, 3, 'main')`,
      )
      .run(skillFile);
    let runtimeConfig: OpenClawConfig = config;
    const context = { getRuntimeConfig: () => runtimeConfig };
    const expectedSkill = {
      skillFile,
      skillKey: "known",
      skillName: "known",
      state: "active",
      pinned: false,
      createdAtMs: Date.parse(applied.record.appliedAt),
      stateChangedAtMs: Date.parse(applied.record.appliedAt),
      lastUsedAtMs: 2000,
      useCount: 3,
      archivedReason: null,
    };
    for (const caps of [[], ["skill-curator-live-inventory"]]) {
      const result = await callHandler(
        "skills.curator.status",
        {},
        {
          context,
          client: { connect: { ...curatorClient.connect, caps } },
        },
      );
      expect(result.ok).toBe(true);
      expect(
        Value.Check(
          caps.length ? SkillsCuratorLiveStatusResultSchema : SkillsCuratorStatusResultSchema,
          result.response,
        ),
      ).toBe(true);
      if (!caps.length) {
        expect(result.response).not.toHaveProperty("inventory");
      }
      expect(result.response).toMatchObject({
        counts: { active: caps.length ? 2 : 1, stale: 0, archived: 0 },
        overlaps: [],
        skills: caps.length
          ? expect.arrayContaining([expect.objectContaining(expectedSkill)])
          : [expectedSkill],
      });
    }
    runtimeConfig = {
      agents: { entries: { other: { agentDir: getTestState().path("other-agent") } } },
    };
    await expect(
      callHandler("skills.curator.status", {}, { context, client: curatorClient }),
    ).resolves.toMatchObject({
      ok: true,
      response: { counts: { active: 0, stale: 0, archived: 0 }, skills: [], overlaps: [] },
    });
    runtimeConfig = config;
    await fs.unlink(skillFile);
    await expect(
      callHandler("skills.curator.status", {}, { context, client: curatorClient }),
    ).resolves.toMatchObject({
      ok: true,
      response: {
        counts: { active: 1, stale: 0, archived: 0 },
        skills: [{ skillFile: directFile }],
      },
    });
    await expect(callHandler("skills.curator.status", {}, { context })).resolves.toMatchObject({
      ok: true,
      response: { counts: { active: 0, stale: 0, archived: 0 }, skills: [], overlaps: [] },
    });
    expect(
      database.db
        .prepare("SELECT count(*) AS count FROM skill_workshop_proposals WHERE status = 'applied'")
        .get(),
    ).toEqual({ count: 1 });
  });

  it.each(["unpin"])(
    "returns an explicit retirement error for the registered curator %s method",
    async (action) => {
      await expect(
        callHandler(`skills.curator.${action}`, { skill: "daily-brief" }),
      ).resolves.toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({
            code: "INVALID_REQUEST",
            message: expect.stringContaining("Skill lifecycle curation is retired"),
          }),
        }),
      );
    },
  );
}
