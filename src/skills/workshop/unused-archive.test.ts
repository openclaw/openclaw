import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizePath } from "../../agents/utils/paths.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../../cron/store.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createWorkshopSkill, listWorkshopSkills, restoreWorkshopSkill } from "./library.js";
import { registerSkillUsageTracking } from "./skill-usage.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { archiveUnusedWorkshopSkills } from "./unused-archive.js";

const DAY_MS = 24 * 60 * 60_000;
function agentConfig(runtime = "openclaw", sandbox?: "non-main"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-test",
        models: { "anthropic/*": { agentRuntime: { id: runtime } } },
        ...(sandbox ? { sandbox: { mode: sandbox } } : {}),
      },
    },
  };
}
const openclawAgent = agentConfig();

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let stopTracking: (() => Promise<void>) | undefined;

const archive = (config = openclawAgent, now = Date.now() + 31 * DAY_MS) =>
  archiveUnusedWorkshopSkills(config, "main", now);
async function expectSkills(...names: string[]) {
  const skills = await listWorkshopSkills(openclawAgent, "main");
  expect(skills.map((skill) => skill.name)).toEqual(names);
}

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
  setRuntimeConfigSnapshot(openclawAgent);
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
    expect(await archive(openclawAgent, createdAtMs + 29 * DAY_MS)).toEqual([]);
    await recordUse("used", createdAtMs + 20 * DAY_MS);
    const archived = await archive(openclawAgent, createdAtMs + 31 * DAY_MS);
    expect(archived).toMatchObject([
      {
        skillName: "stale",
        action: "archive",
        actor: "curator",
        summary: "archived: unused for 30 days",
        versionId: expect.any(String),
      },
    ]);
    await expectSkills("used");
    await restoreWorkshopSkill(
      { config: openclawAgent, agentId: "main", actor: "user" },
      { name: "stale" },
    );
    await expectSkills("stale", "used");
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

    expect((await archive()).map((change) => change.skillName)).toEqual(["quarterly-taxes-old"]);
  });

  it.each(["runtime", "sandbox", "tracking", "learning"] as const)(
    "fails closed at the %s guard",
    async (guard) => {
      await createSkill("stale");
      const config = agentConfig(
        guard === "runtime" ? "codex" : "openclaw",
        guard === "sandbox" ? "non-main" : undefined,
      );
      if (guard === "tracking") {
        await stopTracking?.();
        stopTracking = undefined;
      }
      if (guard === "learning") {
        setRuntimeConfigSnapshot({
          ...openclawAgent,
          skills: { workshop: { autonomous: { mode: "off" } } },
        });
      }
      expect(await archive(config)).toEqual([]);
      await expectSkills("stale");
    },
  );
});
