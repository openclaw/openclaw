import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { ok } from "@openclaw/normalization-core/result";
import { describe, expect, it, vi } from "vitest";
import {
  withAgentDeletion,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import * as activeJobs from "../cron/active-jobs.js";
import {
  createNoopLogger,
  createStartedCronServiceWithFinishedBarrier,
} from "../cron/service.test-harness.js";
import { cronStoreKey } from "../cron/store/key.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { upsertClawCronRef } from "./cron.js";
import { digestClawValue } from "./digest.js";
import { quiescentClawMonitorGateway } from "./lifecycle-remove.test-support.js";
import { buildClawRemovePlan, applyClawRemovePlan } from "./lifecycle-state.js";
import { readPortableHeartbeatState } from "./portable-heartbeat-state.js";
import { portableHeartbeatStateDigest } from "./portable-heartbeat-state.kernel.js";
import {
  gatewayForFixture,
  setupPortableHeartbeatFixture,
} from "./portable-heartbeat.test-support.js";
import { readClawInstallRecord } from "./provenance.js";
import {
  clawRemovalLeaseSchema,
  clawRemovalSourceIdentitySchema,
} from "./removal-journal-contract.js";

const fixture = setupPortableHeartbeatFixture();

function readRemovalWireFacts(deletion: AgentDeletionOperation) {
  return deletion.runWithRemoteAdmission(async (authority, guard) => {
    authority.assertCurrent();
    return ok({
      databasePath: authority.databasePath,
      sourceIdentity: clawRemovalSourceIdentitySchema.parse(authority.sourceIdentity),
      agentId: guard.predicate.agentId,
      operationId: guard.predicate.operationId,
      lease: clawRemovalLeaseSchema.parse(authority.identity),
    });
  });
}

describe("portable heartbeat removal custody", () => {
  it("refuses changed portable custody before uninstalling only the owned job", async () => {
    const f = await fixture({ every: "37m" }, "original scratch");
    const originalReceipt = f.receipt();
    const own = f.jobs()[0]!;
    upsertCronJobRow(
      f.db,
      cronStoreKey(f.storePath),
      { ...own, id: "unrelated", agentId: "main" },
      1,
    );
    const configPath = join(f.env.OPENCLAW_STATE_DIR, "openclaw.json");
    await writeFile(configPath, `${JSON.stringify(f.config)}\n`);
    vi.stubEnv("OPENCLAW_STATE_DIR", f.env.OPENCLAW_STATE_DIR);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    resetConfigRuntimeState();
    const service = createStartedCronServiceWithFinishedBarrier({
      scheduler: createTestGatewayScheduler(),
      storePath: f.storePath,
      logger: createNoopLogger(),
    });
    try {
      await service.cron.start();
      let requestCurrent = true;
      const gateway = gatewayForFixture(
        f.env,
        () => f.config,
        service.cron,
        () => {
          if (!requestCurrent) {
            throw new Error("Removal request authority revoked before dispatch");
          }
        },
      );
      const mutate = expectDefined(gateway.mutateAutomation, "Serving portable mutation");
      const entry = {
        agentId: "worker",
        agentDir: resolveAgentDir(f.config, "worker", f.env),
        workspaceDir: f.plan.agent.workspace,
        sessionsDir: resolveSessionTranscriptsDirForAgent("worker", f.env),
      };
      const retired = await withAgentDeletion(
        "worker",
        async (begin) => {
          const deletion = await begin(entry);
          const facts = await readRemovalWireFacts(deletion);
          await deletion.rollback();
          return facts;
        },
        { env: f.env },
      );
      await withAgentDeletion(
        "worker",
        async (begin) => {
          const deletion = await begin(entry);
          try {
            for (const race of [
              "definition",
              "scratch",
              "ref",
              "install",
              "lease",
              "source",
              "authority",
            ] as const) {
              const expected = await readPortableHeartbeatState("worker", f.config, { env: f.env });
              const expectedRef = expectDefined(expected.ref, "Portable Claw ownership");
              const originalInstall = expectDefined(
                readClawInstallRecord("worker", { env: f.env }),
                "Claw installation",
              );
              let retained = expected;
              const facts = await readRemovalWireFacts(deletion);
              const remove = service.cron.remove.bind(service.cron);
              const publishRemoval = vi.spyOn(activeJobs, "noteActiveCronJobRemoval");
              let authorityRevocationWitnessed = false;
              const boundary = vi
                .spyOn(service.cron, "remove")
                .mockImplementationOnce(async (id, opts) => {
                  if (race === "definition") {
                    await service.cron.update(id, { name: "operator edit" });
                  } else if (race === "scratch") {
                    await service.cron.writeScratch(id, {
                      content: "operator scratch",
                      expectedRevision: expected.scratch.currentRevision,
                    });
                  } else if (race === "ref") {
                    upsertClawCronRef(
                      { ...expectedRef, updatedAtMs: expectedRef.updatedAtMs + 1 },
                      { env: f.env },
                    );
                  }
                  retained = await readPortableHeartbeatState("worker", f.config, { env: f.env });
                  if (race === "authority") {
                    requestCurrent = false;
                    authorityRevocationWitnessed = true;
                  }
                  return remove(id, opts);
                });
              try {
                await expect(
                  mutate({
                    agentId: "worker",
                    expectedStateDigest: portableHeartbeatStateDigest(expected),
                    mutation: {
                      kind: "remove",
                      jobId: own.id,
                      expectedInstallDigest: digestClawValue(
                        race === "install"
                          ? { ...originalInstall, updatedAtMs: originalInstall.updatedAtMs - 1 }
                          : originalInstall,
                      ),
                      deletion:
                        race === "lease"
                          ? retired
                          : race === "source"
                            ? {
                                ...facts,
                                sourceIdentity: { ...facts.sourceIdentity, key: "file:0:0" },
                              }
                            : facts,
                    },
                  }),
                  race,
                ).rejects.toThrow(
                  race === "lease"
                    ? /lease/iu
                    : race === "source"
                      ? /physical database/iu
                      : race === "authority"
                        ? /authority revoked before dispatch/iu
                        : /changed/iu,
                );
                expect(boundary, race).toHaveBeenCalledOnce();
                expect(publishRemoval, race).not.toHaveBeenCalled();
                if (race === "authority") {
                  expect(authorityRevocationWitnessed).toBe(true);
                }
                expect(
                  await readPortableHeartbeatState("worker", f.config, { env: f.env }),
                  race,
                ).toEqual(retained);
                expect(readClawInstallRecord("worker", { env: f.env }), race).toEqual(
                  originalInstall,
                );
                expect(JSON.parse(await readFile(configPath, "utf8")), race).toEqual(f.config);
              } finally {
                requestCurrent = true;
                boundary.mockRestore();
                publishRemoval.mockRestore();
                if (race === "definition" && f.jobs().some((job) => job.id === own.id)) {
                  await service.cron.update(own.id, { name: own.name });
                } else if (race === "scratch" && f.jobs().some((job) => job.id === own.id)) {
                  await service.cron.writeScratch(own.id, {
                    content: "original scratch",
                    expectedRevision: retained.scratch.currentRevision,
                  });
                } else if (race === "ref") {
                  upsertClawCronRef(expectedRef, { env: f.env });
                }
              }
            }
          } finally {
            await deletion.rollback();
          }
        },
        { env: f.env },
      );
      const options = {
        env: f.env,
        config: f.config,
        monitorGateway: quiescentClawMonitorGateway,
        cronGateway: {
          ...gateway,
          get: async (id: string) => service.cron.getJob(id),
          remove: (id: string) => service.cron.remove(id),
          list: async () => ({ jobs: await service.cron.list({ includeDisabled: true }) }),
        },
      };
      const plan = await buildClawRemovePlan("worker", options);
      expect(plan.blockers).toEqual([]);
      const result = await applyClawRemovePlan(plan, {
        ...options,
        consentPlanIntegrity: plan.planIntegrity,
        trashPath: async () => true,
      });
      expect(result.status, JSON.stringify(result)).toBe("complete");
      const persisted = JSON.parse(await readFile(configPath, "utf8"));
      expect(persisted.agents.entries).not.toHaveProperty("worker");
      expect(f.jobs().map((job) => job.id)).toEqual(["unrelated"]);
      expect(f.receipt()).toEqual(originalReceipt);
    } finally {
      service.cron.stop();
      await service.cron.waitForIdle();
    }
  });

  it("blocks uninstall when unrelated work still references the agent", async () => {
    const f = await fixture({ every: "37m" });
    upsertCronJobRow(f.db, cronStoreKey(f.storePath), { ...f.jobs()[0]!, id: "operator-job" }, 1);
    const plan = await buildClawRemovePlan("worker", { env: f.env, config: f.config });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "agent_job_attached" }));
    expect(f.jobs()).toHaveLength(2);
  });
});
