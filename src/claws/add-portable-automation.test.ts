import "../test-utils/prepare-compiled-subprocesses.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronWithinActiveHours } from "../cron/active-hours.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { applyClawAddPlanStateless } from "./add-stateless.js";
import { projectClawAddScheduledJobs } from "./gateway-disclosure.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { readClawManifestFile } from "./reader.js";
import { parseClawOpenClawProfile } from "./schema.js";

it.each([
  { every: "5m", changed: "none" },
  { every: "0m", changed: "none" },
  { every: "5m", changed: "source" },
  { every: "5m", changed: "definition" },
  { every: "5m", changed: "scratch" },
  { every: "5m", changed: "rollback-definition" },
  { every: "5m", changed: "rollback-scratch" },
  { every: "5m", changed: "missing-scratch-adapter" },
])(
  "adds portable heartbeat $every with consent and scratch guarded ($changed)",
  async ({ every, changed }) => {
    await withOpenClawTestState({ label: "claw-portable-add" }, async (fixture) => {
      const packageRoot = fixture.statePath("package");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "claw.json"),
        JSON.stringify({
          schemaVersion: 1,
          agent: { id: "portable", name: "Portable" },
          workspace: { bootstrapFiles: { "HEARTBEAT.md": { source: "HEARTBEAT.md" } } },
        }),
      );
      await writeFile(
        path.join(packageRoot, "HEARTBEAT.md"),
        "# Checklist\nCheck active incidents.\ntasks:\n- name: Summary\n  interval: 15m\n  prompt: Prepare a summary.\n",
      );
      const source = await readClawManifestFile(path.join(packageRoot, "claw.json"));
      if (!source.ok) {
        throw new Error(JSON.stringify(source.diagnostics));
      }
      let config: OpenClawConfig = {
        agents: { entries: { main: {} } },
        plugins: { enabled: false },
      };
      setRuntimeConfigSnapshot(config);
      const makePlan = () =>
        buildClawAddPlan({
          manifest: source.manifest,
          source: source.source,
          openClawProfile: { schemaVersion: 1, agent: { heartbeat: { every } } },
          context: { config, workspace: fixture.statePath("added-workspace") },
        });
      const plan = await makePlan();
      expect((await makePlan()).planIntegrity).toBe(plan.planIntegrity);
      expect(plan.agent.config).not.toHaveProperty("heartbeat");
      expect(projectClawAddScheduledJobs(plan).jobs.map((job) => job.proposed)).toEqual([
        expect.objectContaining({
          schedule: { everyMs: every === "0m" ? 1_800_000 : 300_000 },
          delivery: "owner",
          session: "main",
        }),
        expect.objectContaining({
          schedule: { everyMs: 900_000 },
          delivery: "owner",
          message: "Prepare a summary.",
        }),
      ]);
      if (changed === "source") {
        await writeFile(path.join(packageRoot, "HEARTBEAT.md"), "Changed after consent.\n");
      }
      const run = vi.fn(async () => ({ status: "ok" as const }));
      const cron = new CronService({
        storePath: fixture.statePath("cron", "jobs.json"),
        scheduler: createTestGatewayScheduler(),
        cronEnabled: true,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runSessionEvent: run,
        runIsolatedAgentJob: run,
      });
      await cron.start();
      try {
        const result = await applyClawAddPlanStateless(plan, {
          config,
          consentPlanIntegrity: plan.planIntegrity,
          getCurrentConfig: () => config,
          commitConfig: async (transform) => {
            config = transform(config);
            setRuntimeConfigSnapshot(config);
          },
          cronGateway: {
            add: async (input, options) => {
              if (
                (changed === "rollback-definition" || changed === "rollback-scratch") &&
                input.name === "Summary"
              ) {
                const [existing] = await cron.list({ includeDisabled: true });
                if (changed === "rollback-scratch") {
                  const edited = await cron.writeScratch(existing!.id, {
                    content: "Operator checklist",
                    expectedRevision: 1,
                  });
                  expect(edited.ok).toBe(true);
                } else {
                  await cron.update(existing!.id, { name: "Operator edit" });
                }
                throw new Error("Second automation could not be added");
              }
              const normalized = normalizeCronJobCreate(input);
              if (!normalized) {
                throw new Error("invalid cron input");
              }
              return await cron.add(normalized, { commitGuard: options?.commitGuard });
            },
            list: async () => ({ jobs: await cron.list({ includeDisabled: true }) }),
            get: async (id) => {
              const job = await cron.readJob(id);
              return job && { ...job, configRevision: resolveCronJobConfigRevision(job) };
            },
            writeScratch:
              changed === "missing-scratch-adapter"
                ? undefined
                : async (id, content, commitGuard) => {
                    expect((await cron.readJob(id))?.enabled).toBe(false);
                    expect(await cron.run(id, "due")).toMatchObject({ ran: false });
                    expect(run).not.toHaveBeenCalled();
                    if (changed === "scratch") {
                      await cron.writeScratch(id, {
                        content: "Operator checklist",
                        expectedRevision: 0,
                      });
                    }
                    const outcome = await cron.writeScratch(id, {
                      content,
                      expectedRevision: 0,
                      commitGuard,
                    });
                    if (!outcome.ok) {
                      throw new Error("Claw automation scratch changed before import.");
                    }
                    if (changed === "definition") {
                      await cron.update(id, { name: "Operator edit" });
                    }
                  },
            enable: async (id, revision, commitGuard) => {
              expect((await cron.readScratch(id)).scratch?.content).toBe(
                "# Checklist\nCheck active incidents.\n",
              );
              await cron.updateWithPrecondition(
                id,
                { enabled: true },
                (job) => {
                  expect(resolveCronJobConfigRevision(job)).toBe(revision);
                },
                { commitGuard },
              );
            },
            remove: async (id, options) => await cron.remove(id, options),
          },
        });
        const jobs = await cron.list({ includeDisabled: true });
        if (changed === "source" || changed === "missing-scratch-adapter") {
          expect(result).toMatchObject({ status: "partial", configCommitted: false });
          expect(result.error?.message).toContain(
            changed === "source"
              ? "changed after consent"
              : "requires the gateway-owned cron.scratch.set API",
          );
          expect(jobs).toEqual([]);
          expect(config.agents?.entries).not.toHaveProperty("portable");
          return;
        }
        if (
          changed === "definition" ||
          changed === "scratch" ||
          changed === "rollback-definition" ||
          changed === "rollback-scratch"
        ) {
          expect(result).toMatchObject({
            status: "partial",
            configCommitted: true,
            error: { code: "cron_scratch_import_incomplete" },
          });
          expect(result.error?.message).toContain("Inspect their scratch and enabled state");
          expect(jobs).toHaveLength(1);
          expect(jobs[0]).toMatchObject({
            enabled: changed === "rollback-definition" || changed === "rollback-scratch",
            ...(changed === "definition" || changed === "rollback-definition"
              ? { name: "Operator edit" }
              : {}),
          });
          expect((await cron.readScratch(jobs[0]!.id)).scratch?.content).toBe(
            changed === "scratch" || changed === "rollback-scratch"
              ? "Operator checklist"
              : "# Checklist\nCheck active incidents.\n",
          );
          expect(config.agents?.entries).toHaveProperty("portable");
          expect(run).not.toHaveBeenCalled();
          return;
        }
        expect(result.status, result.error?.message).toBe("complete");
        expect(jobs).toHaveLength(2);
        expect(jobs.every((job) => job.enabled === (every !== "0m"))).toBe(true);
        expect(jobs.find((job) => job.name === "Summary")?.payload).toMatchObject({
          kind: "agentTurn",
          message: "Prepare a summary.",
        });
        const monitor = jobs.find((job) => job.name !== "Summary")!;
        expect((await cron.readScratch(monitor.id)).scratch?.content).toBe(
          "# Checklist\nCheck active incidents.\n",
        );
      } finally {
        cron.stop();
        await cron.waitForIdle();
      }
    });
  },
);

it.each([
  {
    name: "start only",
    activeHours: { start: "22:00" },
    expectedHours: undefined,
    allowed: [true, true],
  },
  {
    name: "end only",
    activeHours: { end: "06:00" },
    expectedHours: undefined,
    allowed: [true, true],
  },
  {
    name: "complete overnight window",
    activeHours: { start: "22:00", end: "06:00", timezone: "UTC" },
    expectedHours: { start: "22:00", end: "06:00", timezone: "UTC" },
    allowed: [false, true],
  },
])(
  "preserves portable active-hours admission for $name",
  async ({ activeHours, expectedHours, allowed }) => {
    await withOpenClawTestState({ label: "claw-portable-active-hours" }, async (fixture) => {
      const packageRoot = fixture.statePath("package");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "claw.json"),
        JSON.stringify({
          schemaVersion: 1,
          agent: { id: "portable", name: "Portable" },
          workspace: { bootstrapFiles: { "HEARTBEAT.md": { source: "HEARTBEAT.md" } } },
        }),
      );
      await writeFile(
        path.join(packageRoot, "HEARTBEAT.md"),
        "# Checklist\nCheck active incidents.\ntasks:\n- name: Summary\n  interval: 15m\n  prompt: Prepare a summary.\n",
      );
      const source = await readClawManifestFile(path.join(packageRoot, "claw.json"));
      if (!source.ok) {
        throw new Error(JSON.stringify(source.diagnostics));
      }
      const profile = parseClawOpenClawProfile({
        schemaVersion: 1,
        agent: { heartbeat: { every: "5m", activeHours } },
      });
      if (!profile.ok) {
        throw new Error(JSON.stringify(profile.diagnostics));
      }
      const plan = await buildClawAddPlan({
        manifest: source.manifest,
        source: source.source,
        openClawProfile: profile.profile,
        context: {
          config: { agents: { entries: { main: {} } }, plugins: { enabled: false } },
          workspace: fixture.statePath("added-workspace"),
        },
      });
      const jobs = plan.actions.flatMap((action) => (action.automation ? [action.automation] : []));
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job.activeHours).toEqual(expectedHours);
        expect(
          [Date.UTC(2026, 0, 1, 12), Date.UTC(2026, 0, 1, 23)].map((nowMs) =>
            isCronWithinActiveHours(job.activeHours, nowMs, "UTC"),
          ),
        ).toEqual(allowed);
      }
    });
  },
);
