import "../test-utils/prepare-compiled-subprocesses.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronWithinActiveHours } from "../cron/active-hours.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import type { TemplateInstallEvent } from "../shared/template-install-notice.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { applyTemplateAddPlanStateless } from "./add-stateless.js";
import { createTemplateCronGateway } from "./cron-gateway.js";
import * as cronInstall from "./cron.js";
import { buildGatewayTemplateAddPlan } from "./gateway-add-plan.js";
import { projectTemplateAddScheduledJobs } from "./gateway-disclosure.js";
import { buildTemplateAddPlan } from "./lifecycle.js";
import { readTemplateManifestFile } from "./reader.js";
import { parseTemplateManifest } from "./schema.js";
import type { TemplateManifest } from "./types.js";

afterEach(() => clearRuntimeConfigSnapshot());
afterEach(() => vi.unstubAllEnvs());
afterEach(() => vi.restoreAllMocks());
afterEach(() => closeOpenClawAgentDatabasesForTest());

const createTemplateCronAdapter = (cron: CronService) =>
  createTemplateCronGateway(
    cron,
    () => ({ agents: { entries: { main: {} } } }),
    () => {},
  );

const checklist = "# Checklist\nCheck active incidents.\n";
const baseConfig = (): OpenClawConfig => ({
  agents: { entries: { main: {} } },
  plugins: { enabled: false },
});

it.each([false, undefined])(
  "installs an ordinary automation with enabled=%s and configures the same job before activation",
  async (enabled) => {
    await withOpenClawTestState({ label: "template-paused-add" }, async (fixture) => {
      const manifestPath = fixture.statePath("CLAW.md");
      await writeFile(
        manifestPath,
        `---\n${JSON.stringify({
          schemaVersion: 1,
          agent: { id: "watcher" },
          automations: [
            {
              id: "weekly",
              enabled,
              schedule: { cron: "0 9 * * 1", timezone: "UTC" },
              session: "isolated",
              message: "Research the configured public pages.",
            },
          ],
        })}\n---\n`,
      );
      const source = await readTemplateManifestFile(manifestPath);
      assert(source.ok, JSON.stringify(source.diagnostics));
      let config = baseConfig();
      setRuntimeConfigSnapshot(config);
      const plan = await buildGatewayTemplateAddPlan(source, { config, sourceMcpServers: {} });
      expect(projectTemplateAddScheduledJobs(plan).jobs[0]?.proposed).toMatchObject({
        enabled: enabled ?? true,
      });
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
      const onSetupEvent = vi.fn(async () => undefined);
      try {
        const result = await applyTemplateAddPlanStateless(plan, {
          config,
          consentPlanIntegrity: plan.planIntegrity,
          getCurrentConfig: () => config,
          commitConfig: async (transform) => {
            config = transform(config);
            setRuntimeConfigSnapshot(config);
          },
          cronGateway: createTemplateCronAdapter(cron),
          onSetupEvent,
        });
        expect(result.status, result.error?.message).toBe("complete");
        const jobs = await cron.list({ includeDisabled: true });
        expect(jobs).toHaveLength(1);
        const job = jobs[0]!;
        expect(job).toMatchObject({
          enabled: enabled ?? true,
          agentId: "watcher",
          declarationKey: "template:watcher:weekly",
          sessionTarget: "isolated",
        });
        expect(onSetupEvent).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            kind: "automation-plan",
            slots: [{ slotId: "weekly", name: "weekly" }],
          }),
        );
        expect(onSetupEvent).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            kind: "automation-created",
            declarationId: "weekly",
            schedulerJobId: job.id,
            enabled: enabled ?? true,
          }),
        );
        if (enabled !== false) {
          return;
        }
        expect(await cron.run(job.id, "due")).toMatchObject({ ran: false });
        expect(run).not.toHaveBeenCalled();
        await cron.update(job.id, {
          schedule: { kind: "cron", expr: "0 9 * * 1", tz: "Europe/Berlin" },
          payload: { kind: "agentTurn", toolsAllow: ["read", "web_search"], timeoutSeconds: 600 },
        });
        expect(await cron.readJob(job.id)).toMatchObject({
          enabled: false,
          schedule: { tz: "Europe/Berlin" },
          payload: { toolsAllow: ["read", "web_search"], timeoutSeconds: 600 },
        });
        await cron.update(job.id, { enabled: true });
        expect(await cron.run(job.id, "force")).toMatchObject({ ran: true });
        expect(run).toHaveBeenCalledOnce();
        expect((await cron.list({ includeDisabled: true })).map((item) => item.id)).toEqual([
          job.id,
        ]);
      } finally {
        cron.stop();
        await cron.waitForIdle();
      }
    });
  },
);

it.each(["main", "isolated"] as const)(
  "preserves the declared %s session for a last-channel automation without delivery",
  async (session) => {
    await withOpenClawTestState({ label: "template-multi-channel-add" }, async (fixture) => {
      const manifestPath = fixture.statePath("CLAW.md");
      await writeFile(
        manifestPath,
        `---\n${JSON.stringify({
          schemaVersion: 1,
          agent: { id: "watcher" },
          automations: [
            {
              id: "hourly",
              schedule: { cron: "0 * * * *", timezone: "UTC" },
              session,
              message: "Summarize active incidents.",
              delivery: { mode: "announce", channel: "last" },
            },
          ],
        })}\n---\n`,
      );
      const source = await readTemplateManifestFile(manifestPath);
      assert(source.ok, JSON.stringify(source.diagnostics));
      let config = baseConfig();
      setRuntimeConfigSnapshot(config);
      const plan = await buildGatewayTemplateAddPlan(source, { config, sourceMcpServers: {} });
      expect(projectTemplateAddScheduledJobs(plan).jobs[0]?.proposed).toMatchObject({
        session,
        delivery: "none",
      });
      const runSessionEvent = vi.fn(async () => ({ status: "ok" as const }));
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const cron = new CronService({
        storePath: fixture.statePath("cron", "jobs.json"),
        scheduler: createTestGatewayScheduler(),
        cronEnabled: true,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runSessionEvent,
        runIsolatedAgentJob,
        // The scheduler rejects announce-to-last jobs once two channels are configured.
        listConfiguredChannels: () => ["discord", "telegram"],
      });
      await cron.start();
      try {
        const result = await applyTemplateAddPlanStateless(plan, {
          config,
          consentPlanIntegrity: plan.planIntegrity,
          getCurrentConfig: () => config,
          commitConfig: async (transform) => {
            config = transform(config);
            setRuntimeConfigSnapshot(config);
          },
          cronGateway: createTemplateCronAdapter(cron),
        });
        expect(result.status, result.error?.message).toBe("complete");
        const jobs = await cron.list({ includeDisabled: true });
        expect(jobs).toEqual([
          expect.objectContaining({
            declarationKey: "template:watcher:hourly",
            sessionTarget: session === "main" ? "session:agent:watcher:main" : "isolated",
            delivery: { mode: "none" },
          }),
        ]);
        expect(await cron.run(jobs[0]!.id, "force")).toMatchObject({ ran: true });
        expect(runSessionEvent).toHaveBeenCalledTimes(session === "main" ? 1 : 0);
        expect(runIsolatedAgentJob).toHaveBeenCalledTimes(session === "isolated" ? 1 : 0);
      } finally {
        cron.stop();
        await cron.waitForIdle();
      }
    });
  },
);

async function portableSource(
  fixture: OpenClawTestState,
  manifest: Partial<TemplateManifest> = {},
) {
  const packageRoot = fixture.statePath("package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, "CLAW.md"),
    `---\n${JSON.stringify({
      schemaVersion: 1,
      agent: { id: "portable", name: "Portable" },
      workspace: { bootstrapFiles: { "HEARTBEAT.md": { source: "HEARTBEAT.md" } } },
      ...manifest,
    })}\n---\n`,
  );
  await writeFile(
    path.join(packageRoot, "HEARTBEAT.md"),
    `${checklist}tasks:\n- name: Summary\n  interval: 15m\n  prompt: Prepare a summary.\n`,
  );
  const source = await readTemplateManifestFile(path.join(packageRoot, "CLAW.md"));
  assert(source.ok, JSON.stringify(source.diagnostics));
  return source;
}

it.each([false, true])(
  "preserves exactly declared routines with MCP environment ready=%s",
  async (ready) => {
    vi.stubEnv("TEMPLATE_ROUTINE_TEST_TOKEN", ready ? "synthetic-token" : undefined);
    await withOpenClawTestState({ label: "template-routine-readiness" }, async (fixture) => {
      const source = await portableSource(fixture, {
        agent: { id: "portable", name: "Portable", heartbeat: { every: "5m" } },
        mcpServers: {
          calendar: {
            command: "fixture-mcp",
            env: { TOKEN: "${TEMPLATE_ROUTINE_TEST_TOKEN}" },
          },
        },
        automations: [
          {
            id: "daily",
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            session: "isolated",
            message: "Prepare the daily brief.",
          },
        ],
      });
      let config = baseConfig();
      setRuntimeConfigSnapshot(config);
      const plan = await buildTemplateAddPlan({
        manifest: source.manifest,
        source: source.source,
        context: { config, workspace: fixture.statePath("added-workspace") },
      });
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
      const notices: unknown[] = [];
      try {
        const result = await applyTemplateAddPlanStateless(plan, {
          config,
          consentPlanIntegrity: plan.planIntegrity,
          getCurrentConfig: () => config,
          commitConfig: async (transform) => {
            config = transform(config);
            setRuntimeConfigSnapshot(config);
          },
          cronGateway: createTemplateCronAdapter(cron),
          // The normal Gateway installer retains the new agent before scheduling.
          waitForAgentRuntime: async () => "applied",
          onSetupEvent: async (event) => {
            notices.push(event);
            // Each result is published before the next scheduler write, not at the end.
            expect(await cron.list({ includeDisabled: true })).toHaveLength(notices.length - 1);
          },
        });
        expect(result.status, result.error?.message).toBe("complete");
        expect(notices).toHaveLength(4);
        expect(notices[0]).toMatchObject({
          kind: "automation-plan",
          slots: [
            { slotId: "$portable-heartbeat", name: "Proactive check (portable)" },
            { slotId: "$portable-heartbeat-task-1", name: "Summary" },
            { slotId: "daily", name: "daily" },
          ],
        });
        expect(notices).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "automation-created",
              agentId: plan.agent.finalId,
              name: "daily",
              enabled: ready,
              schedulerJobId: expect.any(String),
              definition: expect.objectContaining({
                name: "daily",
                enabled: ready,
                configRevision: expect.any(String),
                schedule: expect.objectContaining({ kind: "cron", expr: "0 9 * * *" }),
              }),
            }),
          ]),
        );
        expect(
          notices
            .slice(1)
            .every((event) => (event as { kind: string }).kind === "automation-created"),
        ).toBe(true);
        const jobs = await cron.list({ includeDisabled: true });
        expect(jobs).toHaveLength(3);
        expect(jobs.every((job) => job.enabled === ready)).toBe(true);
        expect(jobs.find((job) => job.name === "daily")).toMatchObject({
          schedule: { kind: "cron", expr: "0 9 * * *" },
          payload: { kind: "agentTurn", message: "Prepare the daily brief." },
        });
        expect(jobs.find((job) => job.name === "Summary")).toMatchObject({
          schedule: { kind: "every", everyMs: 900_000 },
          payload: { kind: "agentTurn", message: "Prepare a summary." },
        });
        const monitor = jobs.find((job) => job.name !== "daily" && job.name !== "Summary")!;
        expect((await cron.readScratch(monitor.id)).scratch?.content).toBe(checklist);
        expect(
          result.cronJobs.every((ref) =>
            cronInstall.templateCronGatewayJobMatchesRef(
              plan.agent.finalId,
              ref,
              jobs.find((job) => job.id === ref.schedulerJobId),
            ),
          ),
        ).toBe(true);
        if (!ready) {
          for (const job of jobs) {
            expect(await cron.run(job.id, "due")).toMatchObject({ ran: false });
          }
          expect(run).not.toHaveBeenCalled();
        }
      } finally {
        cron.stop();
        await cron.waitForIdle();
      }
    });
  },
);

it.each([
  { every: "5m", changed: "none" },
  { every: "0m", changed: "none" },
  { every: "5m", changed: "source" },
  { every: "5m", changed: "definition" },
  { every: "5m", changed: "scratch" },
  { every: "5m", changed: "rollback-definition" },
  { every: "5m", changed: "rollback-scratch" },
  { every: "5m", changed: "rollback-notice" },
  { every: "5m", changed: "missing-scratch-adapter" },
])(
  "adds portable heartbeat $every with consent and scratch guarded ($changed)",
  async ({ every, changed }) => {
    const rollback = changed.startsWith("rollback-");
    const scratchChanged = changed.endsWith("scratch");
    const definitionChanged = changed.endsWith("definition");
    await withOpenClawTestState({ label: "template-portable-add" }, async (fixture) => {
      const source = await portableSource(fixture);
      let config = baseConfig();
      setRuntimeConfigSnapshot(config);
      const makePlan = () =>
        buildTemplateAddPlan({
          manifest: {
            ...source.manifest,
            agent: { ...source.manifest.agent, heartbeat: { every } },
          },
          source: source.source,
          context: { config, workspace: fixture.statePath("added-workspace") },
        });
      const plan = await makePlan();
      expect((await makePlan()).planIntegrity).toBe(plan.planIntegrity);
      expect(plan.agent.config).not.toHaveProperty("heartbeat");
      expect(projectTemplateAddScheduledJobs(plan).jobs.map((job) => job.proposed)).toEqual([
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
        await writeFile(fixture.statePath("package", "HEARTBEAT.md"), "Changed after consent.\n");
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
      const gateway = createTemplateCronAdapter(cron);
      const setupEvents: TemplateInstallEvent[] = [];
      try {
        const result = await applyTemplateAddPlanStateless(plan, {
          config,
          consentPlanIntegrity: plan.planIntegrity,
          getCurrentConfig: () => config,
          commitConfig: async (transform) => {
            config = transform(config);
            setRuntimeConfigSnapshot(config);
          },
          onSetupEvent: async (event) => {
            setupEvents.push(event);
            if (changed === "rollback-notice" && event.kind === "automation-failed") {
              throw new Error("Fixture notice publication failed");
            }
          },
          cronGateway: {
            ...gateway,
            add: async (input, options) => {
              if (rollback && input.name === "Summary") {
                const [existing] = await cron.list({ includeDisabled: true });
                if (scratchChanged) {
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
              return gateway.add(input, options);
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
                    await gateway.writeScratch(id, content, commitGuard);
                    if (changed === "definition") {
                      await cron.update(id, { name: "Operator edit" });
                    }
                  },
            enable: async (id, revision, commitGuard) => {
              expect((await cron.readScratch(id)).scratch?.content).toBe(checklist);
              await gateway.enable(id, revision, commitGuard);
            },
          },
        });
        const jobs = await cron.list({ includeDisabled: true });
        if (changed === "rollback-notice") {
          expect(result).toMatchObject({
            status: "partial",
            error: { code: "cron_scratch_import_incomplete" },
          });
          expect(result.cronJobs).toHaveLength(1);
          expect(result.cronJobs[0]?.schedulerJobId).toBe(jobs[0]?.id);
          expect(jobs).toHaveLength(1);
          expect(config.agents?.entries).toHaveProperty("portable");
          return;
        }
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
        if (definitionChanged || scratchChanged) {
          // Failed scratch import or activation can leave the new job saved and paused.
          // The partial installation error must not mislabel that retained slot "Not created".
          expect(setupEvents.filter((event) => event.kind === "automation-created")).toMatchObject([
            { declarationId: "$portable-heartbeat", schedulerJobId: jobs[0]?.id },
          ]);
          expect(result).toMatchObject({
            status: "partial",
            configCommitted: true,
            error: { code: "cron_scratch_import_incomplete" },
          });
          expect(result.error?.message).toContain("Inspect their scratch and enabled state");
          expect(jobs).toHaveLength(1);
          expect(jobs[0]).toMatchObject({
            enabled: rollback,
            ...(definitionChanged ? { name: "Operator edit" } : {}),
          });
          expect((await cron.readScratch(jobs[0]!.id)).scratch?.content).toBe(
            scratchChanged ? "Operator checklist" : checklist,
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
        expect((await cron.readScratch(monitor.id)).scratch?.content).toBe(checklist);
      } finally {
        cron.stop();
        await cron.waitForIdle();
      }
    });
  },
);

it.each(["retained", "rollback", "native conflict"])(
  "settles every declared slot without claiming a converged or rolled-back job (%s)",
  async (mode) => {
    const retained = mode !== "rollback";
    const collision = mode === "native conflict";
    await withOpenClawTestState({ label: "template-install-settlement" }, async (fixture) => {
      const ids = ["created", "existing", "unattempted"];
      const source = await portableSource(fixture, {
        workspace: undefined,
        automations: ids.map((id) => ({
          id,
          name: "Same label",
          enabled: false,
          schedule: { cron: "0 9 * * *", timezone: "UTC" },
          session: "isolated",
          message: "Fixture task.",
        })),
      });
      let config = baseConfig();
      setRuntimeConfigSnapshot(config);
      const plan = await buildGatewayTemplateAddPlan(source, { config, sourceMcpServers: {} });
      const cron = new CronService({
        storePath: fixture.statePath("cron", "jobs.json"),
        scheduler: createTestGatewayScheduler(),
        cronEnabled: false,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runIsolatedAgentJob: vi.fn(),
        runSessionEvent: vi.fn(),
      });
      const gateway = createTemplateCronAdapter(cron);
      const events: TemplateInstallEvent[] = [];
      let existingId: string | undefined;
      let adds = 0;
      let firstJobId: string | undefined;
      try {
        if (collision) {
          // A real paused scheduler record in the disposable store, not a schema alteration.
          existingId = (
            await cron.add({
              name: "Existing fixture",
              enabled: false,
              declarationKey: `template:${plan.agent.finalId}:existing`,
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              schedule: { kind: "every", everyMs: 60000 },
              payload: { kind: "systemEvent", text: "Fixture" },
            })
          ).id;
        }
        const result = await applyTemplateAddPlanStateless(plan, {
          config,
          consentPlanIntegrity: plan.planIntegrity,
          getCurrentConfig: () => config,
          commitConfig: async (transform) => {
            config = transform(config);
            setRuntimeConfigSnapshot(config);
          },
          ...(retained ? { waitForAgentRuntime: async () => "applied" as const } : {}),
          onSetupEvent: async (event) => {
            events.push(event);
          },
          cronGateway: {
            ...gateway,
            add: async (input, options) => {
              expect(events[0]).toMatchObject({
                kind: "automation-plan",
                slots: ids.map((slotId) => ({ slotId, name: "Same label" })),
              });
              if (++adds === 1) {
                const added = await gateway.add(input, options);
                firstJobId = added.id;
                if (collision) {
                  return added;
                }
                throw new Error("Lost acknowledgement after scheduler commit");
              }
              if (collision) {
                return gateway.add(input, options);
              }
              // The second add confirms convergence, not a job owned by this attempt.
              const job = (await cron.readJob(firstJobId!))!;
              return { ...job, created: false, updated: false, job };
            },
          },
        });
        expect(adds).toBe(2);
        expect(result.status).toBe("partial");
        const actualIds = (await cron.list({ includeDisabled: true })).map((job) => job.id);
        expect(new Set(actualIds)).toEqual(
          new Set([...(existingId ? [existingId] : []), ...(retained ? [firstJobId] : [])]),
        );
        if (collision) {
          expect(result.error?.message).toContain("declaration already exists");
        }
        expect(events).toHaveLength(4);
        const bySlot = events.flatMap((event) =>
          "declarationId" in event
            ? [
                [
                  event.declarationId,
                  event.kind === "automation-created" ? event.schedulerJobId : "failed",
                ],
              ]
            : [],
        );
        expect(Object.fromEntries(bySlot)).toEqual({
          created: retained ? firstJobId : "failed",
          existing: "failed",
          unattempted: "failed",
        });
      } finally {
        cron.stop();
        await cron.waitForIdle();
      }
    });
  },
);

const overnight = { start: "22:00", end: "06:00", timezone: "UTC" };
it.each([
  ["start only", { start: "22:00" }, undefined, [true, true]],
  ["end only", { end: "06:00" }, undefined, [true, true]],
  ["complete overnight window", { ...overnight }, overnight, [false, true]],
] as const)(
  "preserves portable active-hours admission for %s",
  async (_name, activeHours, expectedHours, allowed) => {
    await withOpenClawTestState({ label: "template-portable-active-hours" }, async (fixture) => {
      const source = await portableSource(fixture);
      const profile = parseTemplateManifest({
        ...source.manifest,
        agent: { ...source.manifest.agent, heartbeat: { every: "5m", activeHours } },
      });
      assert(profile.ok, JSON.stringify(profile.diagnostics));
      const plan = await buildTemplateAddPlan({
        manifest: profile.manifest,
        source: source.source,
        context: {
          config: baseConfig(),
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
