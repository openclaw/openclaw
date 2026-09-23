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
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";
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

  it("returns fresh review metadata and outcomes from curator status", async () => {
    await expect(callHandler("skills.curator.status", {})).resolves.toMatchObject({
      ok: true,
      response: {
        lastAttemptAtMs: null,
        lastSuccessAtMs: null,
        lastError: null,
        collectionReview: {},
        experienceReview: {},
      },
    });
    for (const attemptedAtMs of [100, 200]) {
      const collectionReviews = { workspace: { attemptedAtMs, succeededAtMs: attemptedAtMs + 1 } };
      const experienceReviews = {
        workspace: { attemptedAtMs: attemptedAtMs + 2, outcome: "nothing" },
      };
      writeConfigMachineState(
        "skills.curatorState",
        {
          lastAttemptAtMs: attemptedAtMs,
          lastSuccessAtMs: attemptedAtMs + 1,
          lastError: "Previous review failed",
          lastResult: { collectionReviews, experienceReviews },
        },
        { env: getTestState().env },
      );
      await expect(callHandler("skills.curator.status", {})).resolves.toMatchObject({
        ok: true,
        response: {
          lastAttemptAtMs: attemptedAtMs,
          lastSuccessAtMs: attemptedAtMs + 1,
          lastError: "Previous review failed",
          collectionReview: collectionReviews,
          experienceReview: experienceReviews,
        },
      });
    }
  });

  it.each([
    { name: "invalid JSON", valueJson: "{", updatedAtMs: 100n, error: SyntaxError },
    { name: "missing lastResult", valueJson: "{}", updatedAtMs: 100n, error: TypeError },
    {
      name: "null lastResult",
      valueJson: '{"lastResult":null}',
      updatedAtMs: 100n,
      error: TypeError,
    },
    {
      name: "unsafe timestamp before invalid JSON",
      valueJson: "{",
      updatedAtMs: 9223372036854775807n,
      error: RangeError,
    },
  ])("preserves curator state errors for $name", async ({ valueJson, updatedAtMs, error }) => {
    const { db } = openOpenClawStateDatabase({ env: getTestState().env });
    db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    ).run("skills.curatorState", valueJson, updatedAtMs);

    await expect(callHandler("skills.curator.status", {})).rejects.toThrow(error);
  });

  it("returns live Workshop inventory from current runtime roots without proposal history", async () => {
    const alphaDir = getTestState().path("alpha-agent");
    const config: OpenClawConfig = {
      agents: {
        entries: {
          alpha: { agentDir: alphaDir, skills: ["other"] },
          beta: { agentDir: getTestState().path("beta-agent") },
          mirror: { agentDir: alphaDir },
          missing: { agentDir: getTestState().path("absent-agent") },
        },
      },
      skills: { entries: { shared: { enabled: false } } },
    };
    const alphaFile = await writeInventorySkill(config, "alpha", "first", "shared");
    const betaFile = await writeInventorySkill(config, "beta", "second", "shared");
    const unusedFile = await writeInventorySkill(config, "beta", "unused");
    const insert = openOpenClawStateDatabase({ env: getTestState().env }).db.prepare(
      `INSERT INTO skill_usage (skill_file, skill_key, skill_name, skill_source, first_used_at_ms, last_used_at_ms, use_count, last_agent_id) VALUES (?, 'shared', 'Old Name', 'workspace', 10, 20, ?, 'alpha')`,
    );
    insert.run(alphaFile, 1);
    insert.run(betaFile, 2);
    const context = { getRuntimeConfig: () => config };
    const read = async () => {
      const result = await callHandler(
        "skills.curator.status",
        {},
        { context, client: curatorClient },
      );
      expect(result.ok).toBe(true);
      Value.Assert(SkillsCuratorLiveStatusResultSchema, result.response);
      return result.response;
    };
    expect(await read()).toMatchObject({
      inventory: "live-workshop",
      counts: { active: 3, stale: 0, archived: 0 },
      skills: [
        {
          skillFile: alphaFile,
          skillName: "shared",
          skillKey: "shared",
          useCount: 1,
          lastUsedAtMs: 20,
          createdAtMs: null,
          stateChangedAtMs: null,
        },
        {
          skillFile: betaFile,
          skillName: "shared",
          useCount: 2,
          lastUsedAtMs: 20,
          createdAtMs: null,
          stateChangedAtMs: null,
        },
        {
          skillFile: unusedFile,
          useCount: 0,
          lastUsedAtMs: null,
          createdAtMs: null,
          stateChangedAtMs: null,
        },
      ],
    });
    await expect(callHandler("skills.curator.status", {}, { context })).resolves.toMatchObject({
      ok: true,
      response: { counts: { active: 0, stale: 0, archived: 0 }, skills: [] },
    });
    await fs.writeFile(
      alphaFile,
      "---\nname: renamed\ndescription: Renamed skill\n---\nInstructions\n",
    );
    expect((await read()).skills[0]).toMatchObject({
      skillFile: alphaFile,
      skillName: "renamed",
      skillKey: "renamed",
      useCount: 1,
    });
    const movedFile = path.join(path.dirname(path.dirname(betaFile)), "moved", "SKILL.md");
    await fs.rename(path.dirname(betaFile), path.dirname(movedFile));
    const moved = await read();
    expect(moved.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillFile: movedFile,
          skillName: "shared",
          useCount: 0,
          lastUsedAtMs: null,
        }),
      ]),
    );
    expect(moved.skills.map((skill) => skill.skillFile)).not.toContain(betaFile);
    config.agents = { entries: { alpha: { agentDir: getTestState().path("replacement-root") } } };
    expect(await read()).toMatchObject({
      counts: { active: 0, stale: 0, archived: 0 },
      skills: [],
    });
  });

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

  it.each(["pin", "unpin", "restore"])(
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
