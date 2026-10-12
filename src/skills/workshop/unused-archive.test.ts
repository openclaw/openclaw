import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizePath } from "../../agents/utils/paths.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../../cron/store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createWorkshopSkill, listWorkshopSkills, restoreWorkshopSkill } from "./library.js";
import { registerSkillUsageTracking } from "./skill-usage.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { archiveUnusedWorkshopSkills } from "./unused-archive.js";

const DAY_MS = 24 * 60 * 60_000;
const openclawAgent: OpenClawConfig = {
  agents: {
    defaults: {
      model: "anthropic/claude-test",
      models: { "anthropic/*": { agentRuntime: { id: "openclaw" } } },
    },
  },
};

let state: OpenClawTestState;
let stopTracking: (() => Promise<void>) | undefined;

async function createSkill(name: string) {
  await createWorkshopSkill(
    { config: openclawAgent, agentId: "main", actor: "agent" },
    { name, content: `---\nname: ${name}\ndescription: ${name} steps\n---\n\n1. Do it.\n` },
  );
}

async function recordUse(name: string, ts: number) {
  await executeOpenClawStateWorker(captureOpenClawStateWorkerContext(), {
    type: "skills.usage.record",
    input: {
      skillFile: canonicalizePath(
        path.join(resolveWorkshopSkillsDir(openclawAgent, "main"), name, "SKILL.md"),
      ),
      skillKey: name,
      skillName: name,
      skillSource: "workspace",
      agentId: "main",
      ts,
    },
  });
}

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only" });
  stopTracking = registerSkillUsageTracking();
});

afterEach(async () => {
  await stopTracking?.();
  stopTracking = undefined;
  await state.cleanup();
});

describe("archiveUnusedWorkshopSkills", () => {
  it("archives only learned skills unused for 30 days, as an undoable change", async () => {
    const createdAtMs = Date.now();
    await createSkill("stale");
    await createSkill("used");

    // A skill younger than 30 days is never archived.
    expect(
      await archiveUnusedWorkshopSkills(openclawAgent, "main", createdAtMs + 29 * DAY_MS),
    ).toEqual([]);

    await recordUse("used", createdAtMs + 20 * DAY_MS);
    const archived = await archiveUnusedWorkshopSkills(
      openclawAgent,
      "main",
      createdAtMs + 31 * DAY_MS,
    );

    expect(archived).toEqual([
      expect.objectContaining({
        skillName: "stale",
        action: "archive",
        actor: "curator",
        summary: "archived: unused for 30 days",
        versionId: expect.any(String),
      }),
    ]);
    expect((await listWorkshopSkills(openclawAgent, "main")).map((skill) => skill.name)).toEqual([
      "used",
    ]);
    await restoreWorkshopSkill(
      { config: openclawAgent, agentId: "main", actor: "user" },
      { name: "stale" },
    );
    expect((await listWorkshopSkills(openclawAgent, "main")).map((skill) => skill.name)).toEqual([
      "stale",
      "used",
    ]);
  });

  it("keeps a skill that a cron job names, even a paused one", async () => {
    await createSkill("quarterly-taxes");
    await createSkill("quarterly-taxes-old");
    await saveCronJobsStore(resolveCronJobsStorePath(), {
      version: 1,
      jobs: [
        makeCronJob({
          enabled: false,
          payload: { kind: "agentTurn", message: "Use the quarterly-taxes skill to file." },
        }),
      ],
    });

    const archived = await archiveUnusedWorkshopSkills(
      openclawAgent,
      "main",
      Date.now() + 31 * DAY_MS,
    );
    expect(archived.map((change) => change.skillName)).toEqual(["quarterly-taxes-old"]);
  });

  it("fails closed when the agent's default runtime cannot report skill reads", async () => {
    const codexAgent: OpenClawConfig = {
      agents: {
        defaults: {
          model: "anthropic/claude-test",
          models: { "anthropic/*": { agentRuntime: { id: "codex" } } },
        },
      },
    };
    await createSkill("stale");

    expect(await archiveUnusedWorkshopSkills(codexAgent, "main", Date.now() + 31 * DAY_MS)).toEqual(
      [],
    );
    expect(await listWorkshopSkills(openclawAgent, "main")).toHaveLength(1);
  });

  it("fails closed when the agent runs sandboxed", async () => {
    const sandboxedAgent: OpenClawConfig = {
      agents: { defaults: { ...openclawAgent.agents?.defaults, sandbox: { mode: "non-main" } } },
    };
    await createSkill("stale");

    expect(
      await archiveUnusedWorkshopSkills(sandboxedAgent, "main", Date.now() + 31 * DAY_MS),
    ).toEqual([]);
    expect(await listWorkshopSkills(openclawAgent, "main")).toHaveLength(1);
  });

  it("fails closed in a process that does not record skill usage", async () => {
    await createSkill("stale");
    await stopTracking?.();
    stopTracking = undefined;

    expect(
      await archiveUnusedWorkshopSkills(openclawAgent, "main", Date.now() + 31 * DAY_MS),
    ).toEqual([]);
  });

  it("stops when Learning was switched Off after the pass was admitted", async () => {
    await createSkill("stale");
    setRuntimeConfigSnapshot({
      ...openclawAgent,
      skills: { workshop: { autonomous: { mode: "off" } } },
    });
    try {
      expect(
        await archiveUnusedWorkshopSkills(openclawAgent, "main", Date.now() + 31 * DAY_MS),
      ).toEqual([]);
    } finally {
      clearRuntimeConfigSnapshot();
    }
    expect(await listWorkshopSkills(openclawAgent, "main")).toHaveLength(1);
  });
});
