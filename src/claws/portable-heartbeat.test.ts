import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { retireHeartbeatWithDoctor } from "../commands/doctor-heartbeat-retirement.js";
import { cronJobReadView } from "../cron/job-read-view.js";
import { readCronJobScratchState, writeCronJobScratch } from "../cron/scratch-store.js";
import {
  createNoopLogger,
  createStartedCronServiceWithFinishedBarrier,
} from "../cron/service.test-harness.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import {
  loadCronRows,
  upsertCronJobRow,
  deleteCronJobRowInDatabase,
} from "../cron/store/row-codec.js";
import { replaceCronRuntimeAuthorityRows } from "../cron/store/runtime-authority-store.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { applyClawAddPlan } from "./add.js";
import { CLAW_PORTABLE_HEARTBEAT_ID, deleteClawCronRef, upsertClawCronRef } from "./cron.js";
import { exportClawAgent } from "./export.js";
import { buildClawRemovePlan } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { readPortableHeartbeatState } from "./portable-heartbeat-state.js";
import { applyPortableHeartbeatUpdate } from "./portable-heartbeat-update.js";
import { installPortableHeartbeat, publishPortableHeartbeat } from "./portable-heartbeat.js";
import { setupPortableHeartbeatFixture } from "./portable-heartbeat.test-support.js";
import { readClawInstallRecord, updateClawInstallRecord } from "./provenance.js";
import type { ClawOpenClawProfile } from "./types.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import { createClawWorkspaceFiles, readClawWorkspaceFiles } from "./workspace.js";

const fixture = setupPortableHeartbeatFixture();

describe("portable heartbeat artifact boundary", () => {
  it("imports 37m as ordinary cadence without runtime heartbeat and exports current exact scratch", async () => {
    const bytes = "\uFEFF# Checklist\r\n\r\n- Check café  \r\n";
    const f = await fixture(
      {
        every: "37m",
        activeHours: { end: "17:00" },
        lightContext: true,
        timeoutSeconds: 73,
        isolatedSession: true,
      },
      bytes,
    );
    expect(f.install.status).toBe("complete");
    expect(f.config.agents?.entries?.worker).not.toHaveProperty("heartbeat");
    const job = f.jobs().find((candidate) => candidate.id === f.receipt()?.jobId)!;
    expect(job).toMatchObject({
      enabled: true,
      schedule: { kind: "every", everyMs: 2_220_000 },
      activeHours: { start: "00:00", end: "17:00" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", lightContext: true, timeoutSeconds: 73 },
    });
    expect(readCronJobScratchState(f.storePath, job.id, { env: f.env }).scratch?.content).toBe(
      bytes,
    );
    const result = await exportClawAgent("worker", join(f.root, "export"), {
      env: f.env,
      config: f.config,
    });
    expect(result.openClawProfile?.agent.heartbeat).toMatchObject({
      every: "37m",
      activeHours: { start: "00:00", end: "17:00" },
      lightContext: true,
      timeoutSeconds: 73,
      isolatedSession: true,
    });
    expect(await readFile(join(result.outputDirectory, "workspace/HEARTBEAT.md"), "utf8")).toBe(
      bytes,
    );
  });
});

function editJob(
  f: Awaited<ReturnType<typeof fixture>>,
  edit: (job: ReturnType<typeof f.jobs>[number]) => void,
) {
  const row = loadCronRows(f.db, cronStoreKey(f.storePath)).find(
    (candidate) => candidate.job_id === f.receipt()?.jobId,
  )!;
  const job = f.jobs().find((candidate) => candidate.id === row.job_id)!;
  edit(job);
  return upsertCronJobRow(f.db, cronStoreKey(f.storePath), job, row.sort_order);
}
async function updateTarget(
  f: Awaited<ReturnType<typeof fixture>>,
  heartbeat: ClawOpenClawProfile["agent"]["heartbeat"],
  scratch?: string,
) {
  const targetRoot = join(f.root, "target");
  await mkdir(targetRoot, { recursive: true });
  if (scratch !== undefined) {
    await writeFile(join(targetRoot, "HEARTBEAT.md"), scratch);
  }
  const manifest = {
    ...f.manifest,
    workspace: {
      bootstrapFiles: scratch === undefined ? {} : { "HEARTBEAT.md": { source: "HEARTBEAT.md" } },
      files: [],
    },
  };
  const source = {
    ...f.source,
    packageRoot: targetRoot,
    manifestPath: join(targetRoot, "CLAW.md"),
    version: "2.0.0",
    integrity: `sha256:${"b".repeat(64)}`,
  };
  const profile = {
    schemaVersion: 1 as const,
    agent: heartbeat === undefined ? {} : { heartbeat },
  };
  const target = await buildClawAddPlan({
    manifest,
    source,
    openClawProfile: profile,
    context: { workspace: f.plan.agent.workspace },
  });
  const plan = await buildClawUpdatePlan({
    agentId: "worker",
    targetManifest: manifest,
    targetSource: source,
    targetOpenClawProfile: profile,
    config: f.config,
    sourceMcpServers: {},
    stateOptions: { env: f.env },
  });
  return {
    target,
    plan,
    params: { targetManifest: manifest, targetSource: source, targetOpenClawProfile: profile },
  };
}

describe("portable heartbeat current-state and lifecycle safeguards", () => {
  it("acknowledges public job views while refusing unknown fields, newer jobs and durable races", async () => {
    const f = await fixture({ every: "37m" });
    const job = f.jobs()[0]!;
    const view = { ...cronJobReadView(job), effectiveAgentId: "worker" };
    const get = vi.fn(async (): Promise<unknown> => view);
    const list = vi.fn(async () => ({ jobs: [view] }));
    const publish = () =>
      publishPortableHeartbeat("worker", f.config, { env: f.env, cronGateway: { get, list } });
    await expect(publish()).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledWith(job.id);
    expect(list).not.toHaveBeenCalled();
    for (const rejected of [
      { ...view, unknownDefinitionField: true },
      { ...view, name: "newer" },
    ]) {
      get.mockResolvedValueOnce(rejected);
      await expect(publish()).rejects.toThrow("changed or was not adopted");
      expect(f.jobs()[0]).toEqual(job);
    }
    get.mockImplementationOnce(async () => {
      editJob(f, (current) => {
        current.name = "changed during acknowledgment";
      });
      return view;
    });
    await expect(publish()).rejects.toThrow("changed after planning");
    expect(f.jobs()[0]?.name).toBe("changed during acknowledgment");
  });

  it.each([
    { every: "0m" },
    {},
    { activeHours: { start: "09:00" } },
    { activeHours: { timezone: "Europe/Vienna" } },
  ])("round-trips omitted defaults, zero cadence and partial windows: %j", async (heartbeat) => {
    const f = await fixture(heartbeat);
    const result = await exportClawAgent("worker", join(f.root, "export"), {
      env: f.env,
      config: f.config,
    });
    const copy = await fixture(result.openClawProfile!.agent.heartbeat);
    const [original] = f.jobs();
    const [imported] = copy.jobs();
    expect(imported).toMatchObject({
      enabled: original!.enabled,
      schedule: {
        kind: "every",
        everyMs: original!.schedule.kind === "every" ? original!.schedule.everyMs : 0,
      },
      payload: original!.payload,
      sessionTarget: original!.sessionTarget,
    });
    expect(imported?.activeHours).toEqual(original?.activeHours);
  });

  it("exports current scratch edits and unset without replaying packaged bytes", async () => {
    const f = await fixture({ every: "37m" }, "original\n");
    const jobId = f.receipt()!.jobId;
    await expect(
      writeCronJobScratch({
        storePath: f.storePath,
        jobId,
        content: "new café\r\n",
        expectedRevision: 1,
        options: { env: f.env },
      }),
    ).resolves.toMatchObject({ ok: true });
    const edited = await exportClawAgent("worker", join(f.root, "edited"), {
      env: f.env,
      config: f.config,
    });
    expect(await readFile(join(edited.outputDirectory, "workspace/HEARTBEAT.md"), "utf8")).toBe(
      "new café\r\n",
    );
    await expect(
      writeCronJobScratch({
        storePath: f.storePath,
        jobId,
        content: null,
        expectedRevision: 2,
        options: { env: f.env },
      }),
    ).resolves.toMatchObject({ ok: true });
    const cleared = await exportClawAgent("worker", join(f.root, "cleared"), {
      env: f.env,
      config: f.config,
    });
    expect(cleared.manifest.workspace.bootstrapFiles["HEARTBEAT.md"]).toBeUndefined();
    expect(readCronJobScratchState(f.storePath, jobId, { env: f.env }).currentRevision).toBe(3);
  });

  it.each([
    [
      "payload.model",
      (job: ReturnType<Awaited<ReturnType<typeof fixture>>["jobs"]>[number]) => {
        if (job.payload.kind === "agentTurn") {
          job.payload.model = "openai/gpt-5.6-luna";
        }
      },
    ],
    [
      "delivery",
      (job: ReturnType<Awaited<ReturnType<typeof fixture>>["jobs"]>[number]) => {
        job.delivery = { mode: "none" };
      },
    ],
    [
      "enabled",
      (job: ReturnType<Awaited<ReturnType<typeof fixture>>["jobs"]>[number]) => {
        job.enabled = false;
      },
    ],
    [
      "sessionTarget",
      (job: ReturnType<Awaited<ReturnType<typeof fixture>>["jobs"]>[number]) => {
        job.sessionTarget = "current";
      },
    ],
    [
      "pacing",
      (job: ReturnType<Awaited<ReturnType<typeof fixture>>["jobs"]>[number]) => {
        job.pacing = { min: "5m" };
      },
    ],
  ] as const)(
    "rejects unrepresentable %s without output or source-state mutation",
    async (field, edit) => {
      const f = await fixture({ every: "37m" }, "original\n");
      editJob(f, edit);
      const before = f.jobs();
      const { ref } = await readPortableHeartbeatState("worker", f.config, { env: f.env });
      const scratch = readCronJobScratchState(f.storePath, f.receipt()!.jobId, { env: f.env });
      const out = join(f.root, "rejected");
      await expect(
        exportClawAgent("worker", out, { env: f.env, config: f.config }),
      ).rejects.toThrow(field);
      await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
      expect(f.jobs()).toEqual(before);
      expect((await readPortableHeartbeatState("worker", f.config, { env: f.env })).ref).toEqual(
        ref,
      );
      expect(readCronJobScratchState(f.storePath, f.receipt()!.jobId, { env: f.env })).toEqual(
        scratch,
      );
    },
  );

  it("exports representable current job edits instead of the saved portable declaration", async () => {
    const f = await fixture({
      every: "37m",
      lightContext: true,
      isolatedSession: true,
      timeoutSeconds: 73,
    });
    editJob(f, (job) => {
      if (job.schedule.kind === "every") {
        job.schedule.everyMs = 41 * 60_000;
      }
      job.activeHours = { start: "09:00", end: "17:00", timezone: "Europe/Vienna" };
      job.sessionTarget = `session:${job.sessionKey}`;
      if (job.payload.kind === "agentTurn") {
        job.payload.lightContext = false;
        job.payload.timeoutSeconds = 121;
      }
    });
    const result = await exportClawAgent("worker", join(f.root, "edited"), {
      env: f.env,
      config: f.config,
    });
    expect(result.openClawProfile?.agent.heartbeat).toEqual({
      every: "41m",
      activeHours: { start: "09:00", end: "17:00", timezone: "Europe/Vienna" },
      lightContext: false,
      isolatedSession: false,
      timeoutSeconds: 121,
    });
  });

  it.each(["receipt-only", "released"])(
    "exports current receipt-owned state without requiring active Claw ownership: %s",
    async (ownership) => {
      const f = await fixture({ every: "37m" });
      const ref = (await readPortableHeartbeatState("worker", f.config, { env: f.env })).ref!;
      if (ownership === "released") {
        upsertClawCronRef({ ...ref, status: "removed" }, { env: f.env });
      } else {
        deleteClawCronRef("worker", CLAW_PORTABLE_HEARTBEAT_ID, { env: f.env });
      }
      const result = await exportClawAgent("worker", join(f.root, "export"), {
        env: f.env,
        config: f.config,
      });
      expect(result.openClawProfile?.agent.heartbeat?.every).toBe("37m");
    },
  );

  it("rejects private runtime authority stored outside the job row without creating output", async () => {
    const f = await fixture({ every: "37m" });
    const job = f.jobs()[0]!;
    replaceCronRuntimeAuthorityRows({
      db: f.db,
      storeKey: cronStoreKey(f.storePath),
      jobs: [
        {
          ...job,
          runtimeAuthority: {
            version: 1,
            runtimeId: "codex",
            namespace: "tools",
            payload: { fixture: true },
          },
        },
      ],
    });
    const output = join(f.root, "authority-export");
    await expect(
      exportClawAgent("worker", output, { env: f.env, config: f.config }),
    ).rejects.toThrow("runtimeAuthority");
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.jobs()[0]?.id).toBe(job.id);
    await expect(installPortableHeartbeat(f.plan, f.config, { env: f.env })).rejects.toThrow(
      "conflicts with existing",
    );
  });

  it("makes an explicit import visible to an already-running empty scheduler", async () => {
    const adopted = createDeferred();
    let service: ReturnType<typeof createStartedCronServiceWithFinishedBarrier> | undefined;
    try {
      const f = await fixture({ every: "37m" }, undefined, async (plan) => {
        const stateDir = join(plan.agent.workspace, "..", "state");
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        service = createStartedCronServiceWithFinishedBarrier({
          scheduler: createTestGatewayScheduler(),
          storePath: resolveCronJobsStorePathFromConfig({}, { OPENCLAW_STATE_DIR: stateDir }),
          logger: createNoopLogger(),
          onEvent: (event) => {
            if (event.action === "added") {
              adopted.resolve();
            }
          },
        });
        await service.cron.start();
      });
      expect(f.install.status).toBe("complete");
      await adopted.promise;
      expect(service!.cron.getJob(f.receipt()!.jobId)?.schedule).toMatchObject({
        kind: "every",
        everyMs: 37 * 60_000,
      });
      expect((await service!.cron.list({ includeDisabled: true })).map((job) => job.id)).toContain(
        f.receipt()!.jobId,
      );
      expect(service!.runSessionEvent).not.toHaveBeenCalled();
    } finally {
      service?.cron.stop();
      await service?.cron.waitForIdle();
    }
  });

  it("does not resurrect a deleted ordinary job on Doctor and rejects export", async () => {
    const f = await fixture({ every: "37m" });
    const receipt = f.receipt();
    deleteCronJobRowInDatabase(f.db, cronStoreKey(f.storePath), receipt!.jobId);
    await retireHeartbeatWithDoctor(f.config, f.env);
    await retireHeartbeatWithDoctor(f.config, f.env);
    expect(f.receipt()).toEqual(receipt);
    expect(f.jobs().some((job) => job.id === receipt!.jobId)).toBe(false);
    await expect(
      exportClawAgent("worker", join(f.root, "export"), { env: f.env, config: f.config }),
    ).rejects.toThrow("deleted job");
  });

  it("changes the owned job in place, then rolls back without resetting scratch revisions or history", async () => {
    const f = await fixture({ every: "37m" }, "original\n", undefined, true);
    const original = editJob(f, (job) => {
      job.state.lastRunAtMs = 123;
      job.state.lastRunStatus = "ok";
      job.state.nextRunAtMs = Date.now() - 1_000;
    });
    const t = await updateTarget(f, { every: "41m" }, "updated\n");
    expect(t.plan.actions.filter((action) => action.blocked)).toEqual([]);
    const execution = await applyPortableHeartbeatUpdate(t.plan, t.target, f.config, {
      env: f.env,
      cronGateway: f.cronGateway,
    });
    expect(f.receipt()?.jobId).toBe(original.id);
    expect(f.jobs()[0]).toMatchObject({
      id: original.id,
      schedule: { kind: "every", everyMs: 2_460_000 },
      state: { lastRunAtMs: 123 },
    });
    await execution.rollback();
    expect(f.jobs()[0]).toMatchObject({
      id: original.id,
      schedule: original.schedule,
      state: original.state,
      payload: original.payload,
    });
    expect(readCronJobScratchState(f.storePath, original.id, { env: f.env })).toMatchObject({
      currentRevision: 3,
      scratch: { content: "original\n" },
    });

    const next = await updateTarget(f, { every: "43m" }, "updated again\n");
    const later = await applyPortableHeartbeatUpdate(next.plan, next.target, f.config, {
      env: f.env,
      cronGateway: f.cronGateway,
    });
    const runtimeAdvancedAt = Date.now();
    editJob(f, (job) => {
      job.state.lastRunAtMs = runtimeAdvancedAt;
      job.state.nextRunAtMs = runtimeAdvancedAt + 3_600_000;
    });
    await later.rollback();
    expect(f.jobs()[0]?.state.lastRunAtMs).toBe(runtimeAdvancedAt);
    expect(f.jobs()[0]?.state.nextRunAtMs).toBeGreaterThan(runtimeAdvancedAt);
    expect(f.jobs()[0]?.state.nextRunAtMs).not.toBe(original.state.nextRunAtMs);
  });

  it("rejects a CAS race at update and preserves a later edit when rollback conflicts", async () => {
    const f = await fixture({ every: "37m" }, "original\n");
    const t = await updateTarget(f, { every: "41m" }, "updated\n");
    const jobId = f.receipt()!.jobId;
    await writeCronJobScratch({
      storePath: f.storePath,
      jobId,
      content: "racing edit",
      expectedRevision: 1,
      options: { env: f.env },
    });
    await expect(
      applyPortableHeartbeatUpdate(t.plan, t.target, f.config, { env: f.env }),
    ).rejects.toThrow("changed");
    expect(f.jobs()[0]?.schedule).toMatchObject({ everyMs: 2_220_000 });
    const g = await fixture({ every: "37m" }, "original\n");
    const u = await updateTarget(g, { every: "41m" }, "updated\n");
    const execution = await applyPortableHeartbeatUpdate(u.plan, u.target, g.config, {
      env: g.env,
    });
    await writeCronJobScratch({
      storePath: g.storePath,
      jobId: g.receipt()!.jobId,
      content: "operator wins",
      expectedRevision: 2,
      options: { env: g.env },
    });
    await expect(execution.rollback()).rejects.toThrow("changed");
    expect(
      readCronJobScratchState(g.storePath, g.receipt()!.jobId, { env: g.env }).scratch?.content,
    ).toBe("operator wins");
  });

  it("atomically adds a first portable automation during update and keeps failed provenance writes job-free", async () => {
    const f = await fixture(undefined, undefined, undefined, true);
    const t = await updateTarget(f, { every: "37m" });
    const options = {
      env: f.env,
      config: f.config,
      sourceMcpServers: {},
      consentPlanIntegrity: t.plan.planIntegrity,
      cronGateway: f.cronGateway,
    };
    const beforeInstall = readClawInstallRecord("worker", { env: f.env });
    const originalAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let commitAdmissionWitnessed = false;
    const admission = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        originalAdmission((request, grant) => {
          if (
            request.stage === "commit" &&
            isRecord(request.facts) &&
            request.facts.bytes instanceof Uint8Array
          ) {
            commitAdmissionWitnessed = true;
            throw new Error("provenance commit refused");
          }
          admit(request, grant);
        }, attachment),
      );
    try {
      await expect(applyClawUpdatePlan(t.plan, t.params, options)).rejects.toThrow(
        "provenance commit refused",
      );
    } finally {
      admission.mockRestore();
    }
    expect(commitAdmissionWitnessed).toBe(true);
    expect(readClawInstallRecord("worker", { env: f.env })).toEqual(beforeInstall);
    expect(
      (await readPortableHeartbeatState("worker", f.config, { env: f.env })).ref,
    ).toBeUndefined();
    expect(f.receipt()).toBeUndefined();
    expect(f.jobs()).toEqual([]);
    const applied = await applyClawUpdatePlan(t.plan, t.params, options);
    expect(applied.status).toBe("complete");
    expect(f.jobs()).toHaveLength(1);
    expect(f.jobs()[0]?.schedule).toMatchObject({ kind: "every", everyMs: 2_220_000 });
  });

  it("releases a removed artifact declaration without deleting its ordinary job", async () => {
    const f = await fixture({ every: "37m" }, undefined, undefined, true);
    const before = f.jobs();
    const t = await updateTarget(f, undefined);
    const result = await applyClawUpdatePlan(t.plan, t.params, {
      env: f.env,
      config: f.config,
      sourceMcpServers: {},
      consentPlanIntegrity: t.plan.planIntegrity,
      cronGateway: f.cronGateway,
    });
    expect(result.status).toBe("complete");
    const next = await updateTarget(f, undefined);
    expect(next.plan.actions.filter((action) => action.blocked)).toEqual([]);
    expect(f.jobs()).toEqual(before);
    expect(
      (await buildClawRemovePlan("worker", { env: f.env, config: f.config })).blockers,
    ).toContainEqual(expect.objectContaining({ code: "agent_job_attached" }));
  });

  it("rolls the same job back if Claw provenance persistence fails", async () => {
    const f = await fixture({ every: "37m" }, "original\n", undefined, true);
    const original = f.jobs()[0];
    const t = await updateTarget(f, { every: "41m" }, "updated\n");
    await expect(
      applyClawUpdatePlan(t.plan, t.params, {
        env: f.env,
        config: f.config,
        sourceMcpServers: {},
        consentPlanIntegrity: t.plan.planIntegrity,
        cronGateway: f.cronGateway,
        persistInstall: () => {
          throw new Error("injected provenance failure");
        },
      }),
    ).rejects.toThrow("injected provenance failure");
    expect(f.jobs()[0]?.id).toBe(original!.id);
    expect(f.jobs()[0]?.schedule).toEqual(original!.schedule);
    expect(
      readCronJobScratchState(f.storePath, original!.id, { env: f.env }).scratch?.content,
    ).toBe("original\n");
  });
});

async function legacyFixture() {
  const f = await fixture(undefined);
  const scratch = "\uFEFF# Legacy\r\n- Check café\r\n";
  await writeFile(join(f.source.packageRoot, "HEARTBEAT.md"), scratch);
  const profile = {
    schemaVersion: 1 as const,
    agent: { heartbeat: { every: "37m", lightContext: true } },
  };
  const manifest = {
    ...f.manifest,
    workspace: { bootstrapFiles: { "HEARTBEAT.md": { source: "HEARTBEAT.md" } }, files: [] },
  };
  const plan = await buildClawAddPlan({
    manifest,
    source: f.source,
    openClawProfile: profile,
    context: { workspace: f.plan.agent.workspace, resumableWorkspace: f.plan.agent.workspace },
  });
  // Reconstruct the shipped artifact's config/file provenance, before the adapter.
  const action = plan.actions.find((item) => item.id === CLAW_PORTABLE_HEARTBEAT_ID)!;
  plan.actions = plan.actions.filter((item) => item !== action);
  plan.actions.push({
    ...action,
    kind: "workspaceFile",
    id: "HEARTBEAT.md",
    action: "write",
    target: join(plan.agent.workspace, "HEARTBEAT.md"),
  });
  plan.agent.config.heartbeat = profile.agent.heartbeat;
  f.config.agents!.entries!.worker!.heartbeat = profile.agent.heartbeat;
  await createClawWorkspaceFiles(plan, { env: f.env });
  updateClawInstallRecord(plan, { env: f.env });
  return { ...f, scratch };
}

describe("portable heartbeat interruption and Doctor provenance", () => {
  it("converts structured tasks through the serving owner once and refuses multi-job export", async () => {
    const f = await fixture(
      { every: "37m" },
      "# Checklist\n- ordinary check\n\ntasks:\n  - name: Report\n    interval: 41m\n    prompt: Summarize the report\n",
      undefined,
      true,
    );
    expect(f.install.status).toBe("complete");
    expect(f.receipt()?.convertedJobIds).toHaveLength(1);
    expect(f.jobs()).toHaveLength(2);
    expect(f.jobs().find((job) => job.id !== f.receipt()?.jobId)).toMatchObject({
      schedule: { kind: "every", everyMs: 2_460_000 },
      payload: { kind: "agentTurn", message: "Summarize the report" },
    });
    expect(
      readCronJobScratchState(f.storePath, f.receipt()!.jobId, { env: f.env }).scratch?.content,
    ).toContain("ordinary check");
    const ids = f.jobs().map((job) => job.id);
    const scratch = readCronJobScratchState(f.storePath, f.receipt()!.jobId, { env: f.env });
    await installPortableHeartbeat(f.plan, f.config, { env: f.env, cronGateway: f.cronGateway });
    expect(f.jobs().map((job) => job.id)).toEqual(ids);
    expect(readCronJobScratchState(f.storePath, f.receipt()!.jobId, { env: f.env })).toEqual(
      scratch,
    );
    await expect(
      exportClawAgent("worker", join(f.root, "export"), { env: f.env, config: f.config }),
    ).rejects.toThrow("converted task jobs");
  });

  it("keeps invalid structured tasks pending and preserves obsolete instruction text with a warning", async () => {
    const bytes = "Use heartbeat_respond or HEARTBEAT_OK.\n\ntasks:\n  - name: incomplete\n";
    const f = await fixture({ every: "37m" }, bytes, undefined, true);
    expect(f.install.status).toBe("partial");
    expect(f.receipt()?.phase).toBe("pending");
    expect(f.plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "obsolete_heartbeat_instructions" }),
    );
    expect(
      readCronJobScratchState(f.storePath, f.receipt()!.jobId, { env: f.env }).scratch?.content,
    ).toBe(bytes);
    const before = f.jobs();
    await applyClawAddPlan(f.plan, {
      env: f.env,
      consentPlanIntegrity: f.plan.planIntegrity,
      cronGateway: f.cronGateway,
      commitConfig: async (transform) => {
        f.config = transform(f.config);
      },
    });
    expect(f.jobs()).toEqual(before);
    expect(
      readCronJobScratchState(f.storePath, f.receipt()!.jobId, { env: f.env }).currentRevision,
    ).toBe(1);
  });

  it("leaves a failed source import retryable without an orphan job or runtime heartbeat", async () => {
    const f = await fixture({ every: "37m" }, "approved", async (plan) => {
      await writeFile(join(plan.claw.packageRoot, "HEARTBEAT.md"), "changed after consent");
    });
    expect(f.install.status).toBe("partial");
    expect(f.receipt()).toBeUndefined();
    expect(f.jobs()).toEqual([]);
    expect(f.config.agents?.entries?.worker).not.toHaveProperty("heartbeat");
    await writeFile(join(f.source.packageRoot, "HEARTBEAT.md"), "approved");
    const retry = await applyClawAddPlan(f.plan, {
      env: f.env,
      consentPlanIntegrity: f.plan.planIntegrity,
      commitConfig: async (transform) => {
        f.config = transform(f.config);
      },
    });
    expect(retry.status).toBe("complete");
    expect(f.jobs()).toHaveLength(1);
  });

  it("hands verified legacy config and consumed file provenance to the converted job", async () => {
    const f = await legacyFixture();
    const next = await retireHeartbeatWithDoctor(f.config, f.env);
    expect(next.agents?.entries?.worker).not.toHaveProperty("heartbeat");
    expect(readClawWorkspaceFiles("worker", { env: f.env })).toEqual([]);
    const result = await exportClawAgent("worker", join(f.root, "export"), {
      env: f.env,
      config: next,
    });
    expect(result.openClawProfile?.agent.heartbeat?.every).toBe("37m");
    expect(await readFile(join(result.outputDirectory, "workspace/HEARTBEAT.md"), "utf8")).toBe(
      f.scratch,
    );
    const receipt = f.receipt();
    await retireHeartbeatWithDoctor(next, f.env);
    expect(f.receipt()).toEqual(receipt);
  });

  it("publishes Doctor's completed conversion to an already-running empty scheduler", async () => {
    const f = await legacyFixture();
    vi.stubEnv("OPENCLAW_STATE_DIR", f.env.OPENCLAW_STATE_DIR);
    const adopted = createDeferred();
    const service = createStartedCronServiceWithFinishedBarrier({
      scheduler: createTestGatewayScheduler(),
      storePath: f.storePath,
      logger: createNoopLogger(),
      onEvent: (event) => {
        if (event.action === "added") {
          adopted.resolve();
        }
      },
    });
    try {
      await service.cron.start();
      await retireHeartbeatWithDoctor(f.config, f.env);
      await adopted.promise;
      expect(service.cron.getJob(f.receipt()!.jobId)?.payload.kind).toBe("agentTurn");
      expect(service.runSessionEvent).not.toHaveBeenCalled();
    } finally {
      service.cron.stop();
      await service.cron.waitForIdle();
    }
  });

  it("recovers the config-write interruption without blessing a later legacy config edit", async () => {
    const f = await legacyFixture();
    await retireHeartbeatWithDoctor(f.config, f.env);
    const before = readClawInstallRecord("worker", { env: f.env });
    const { ref } = await readPortableHeartbeatState("worker", f.config, { env: f.env });
    await retireHeartbeatWithDoctor(f.config, f.env);
    expect(
      (await readPortableHeartbeatState("worker", f.config, { env: f.env })).ref?.schedulerJobId,
    ).toBe(ref?.schedulerJobId);
    f.config.agents!.entries!.worker!.heartbeat!.every = "41m";
    await expect(retireHeartbeatWithDoctor(f.config, f.env)).rejects.toThrow("drifted");
    expect(readClawInstallRecord("worker", { env: f.env })).toEqual(before);
  });

  it.each(["config", "file"] as const)("refuses to rebaseline unrelated %s edits", async (kind) => {
    const f = await legacyFixture();
    const before = readClawInstallRecord("worker", { env: f.env });
    if (kind === "config") {
      f.config.agents!.entries!.worker!.name = "operator edit";
    } else {
      await writeFile(join(f.plan.agent.workspace, "HEARTBEAT.md"), "operator edit");
    }
    await expect(retireHeartbeatWithDoctor(f.config, f.env)).rejects.toThrow("drifted");
    expect(readClawInstallRecord("worker", { env: f.env })).toEqual(before);
    expect(f.receipt()).toBeUndefined();
    expect(f.config.agents?.entries?.worker?.heartbeat?.every).toBe("37m");
  });
});
