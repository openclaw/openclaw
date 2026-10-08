import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../../cron/store.js";
import {
  emitTrustedSkillUsedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  createWorkshopSkill,
  listWorkshopArchive,
  listWorkshopChanges,
  listWorkshopSkills,
  patchWorkshopSkill,
  restoreWorkshopSkill,
  writeWorkshopSkillFile,
} from "./library.js";
import * as skillLocks from "./skill-locks.js";
import * as skillUsage from "./skill-usage.js";
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

  it.for(["SKILL.md", "references/steps.md"])(
    "keeps a skill patched in %s while the archive waits for its mutation lock",
    async (filePath, { signal }) => {
      const createdAtMs = Date.now();
      const nowMs = createdAtMs + 31 * DAY_MS;
      await createSkill("recently-improved");
      if (filePath !== "SKILL.md") {
        await writeWorkshopSkillFile(
          { config: openclawAgent, agentId: "main", actor: "agent" },
          { name: "recently-improved", filePath, content: "1. Do it.\n" },
        );
      }

      const patchAcquired = createDeferred();
      const resumePatch = createDeferred();
      const archiveQueued = createDeferred();
      const withSkillLocks = skillLocks.withSkillLocks;
      let lockCalls = 0;
      // Only control the interleaving. Both mutations still use the real lock, files, and worker.
      const lockSpy = vi.spyOn(skillLocks, "withSkillLocks").mockImplementation((keys, run) => {
        lockCalls += 1;
        if (lockCalls === 1) {
          return withSkillLocks(keys, async () => {
            patchAcquired.resolve();
            await resumePatch.promise;
            return await run();
          });
        }
        archiveQueued.resolve();
        return withSkillLocks(keys, run);
      });
      const patch = patchWorkshopSkill(
        { config: openclawAgent, agentId: "main", actor: "agent" },
        {
          name: "recently-improved",
          filePath,
          oldText: "1. Do it.",
          newText: "1. Apply the learned fix.",
        },
      );
      let archive: ReturnType<typeof archiveUnusedWorkshopSkills> | undefined;
      let clock: MockInstance<typeof Date.now> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(patchAcquired.promise, patch, "patch did not acquire its lock"),
          signal,
        );
        archive = archiveUnusedWorkshopSkills(openclawAgent, "main", nowMs);
        await withinTest(
          awaitGateBeforeSettlement(archiveQueued.promise, archive, "archive did not queue"),
          signal,
        );
        // The scan already decided the skill was old. The queued patch now commits fresh activity.
        clock = vi.spyOn(Date, "now").mockReturnValue(nowMs);
        resumePatch.resolve();
        expect((await patch).createdAtMs).toBe(nowMs);
        const archived = await archive;
        const changes = await listWorkshopChanges("main", { limit: 10 });
        expect(changes).toContainEqual(
          expect.objectContaining({
            skillName: "recently-improved",
            action: "patch",
            createdAtMs: nowMs,
          }),
        );
        expect.soft(archived).toEqual([]);
        expect(changes.some((change) => change.action === "archive")).toBe(false);
        const versions = (await listWorkshopArchive(openclawAgent, "main"))[0]?.versions ?? [];
        expect(versions.some((version) => version.action === "archive")).toBe(false);
        expect(
          (await listWorkshopSkills(openclawAgent, "main")).map((skill) => skill.name),
        ).toEqual(["recently-improved"]);
      } finally {
        resumePatch.resolve();
        await Promise.allSettled([patch, ...(archive ? [archive] : [])]);
        clock?.mockRestore();
        lockSpy.mockRestore();
      }
    },
  );

  it("keeps a skill used after the archive's usage snapshot", async ({ signal }) => {
    const nowMs = Date.now() + 31 * DAY_MS;
    await createSkill("recently-used");
    const skillFile = canonicalizePath(
      path.join(resolveWorkshopSkillsDir(openclawAgent, "main"), "recently-used", "SKILL.md"),
    );
    const usageRead = createDeferred();
    const resumeArchive = createDeferred();
    const readSkillUsage = skillUsage.readSkillUsage;
    // Preserve the real SQLite read and snapshot; only delay its delivery to the archive pass.
    const usageSpy = vi
      .spyOn(skillUsage, "readSkillUsage")
      .mockImplementationOnce(async (...args) => {
        const snapshot = await readSkillUsage(...args);
        usageRead.resolve();
        await resumeArchive.promise;
        return snapshot;
      });
    const archive = archiveUnusedWorkshopSkills(openclawAgent, "main", nowMs);
    let clock: MockInstance<typeof Date.now> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(usageRead.promise, archive, "archive did not read usage"),
        signal,
      );
      clock = vi.spyOn(Date, "now").mockReturnValue(nowMs);
      emitTrustedSkillUsedDiagnosticEvent(
        {
          type: "skill.used",
          skillName: "recently-used",
          skillSource: "workspace",
          activation: "read",
          agentId: "main",
        },
        { skillUsage: { skillFile } },
      );
      await waitForDiagnosticEventsDrained();
      // Drain accepted asynchronous persistence before allowing the archive to continue.
      await stopTracking?.();
      stopTracking = registerSkillUsageTracking();
      expect((await readSkillUsage({}, [skillFile])).get(skillFile)).toEqual({
        useCount: 1,
        lastUsedAtMs: nowMs,
      });
      resumeArchive.resolve();
      expect.soft(await archive).toEqual([]);
      expect(await listWorkshopArchive(openclawAgent, "main")).toEqual([]);
      expect(
        (await listWorkshopChanges("main", { limit: 10 })).map((change) => change.action),
      ).toEqual(["create"]);
      expect((await listWorkshopSkills(openclawAgent, "main")).map((skill) => skill.name)).toEqual([
        "recently-used",
      ]);
    } finally {
      resumeArchive.resolve();
      await Promise.allSettled([archive]);
      clock?.mockRestore();
      usageSpy.mockRestore();
    }
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
