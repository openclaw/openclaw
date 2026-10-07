import { readFile } from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClawAutomationMutationRequest } from "../claws/automation-mutation-contract.js";
import { resolveClawMonitorCleanupBinding } from "../claws/monitor-cleanup-binding.js";
import * as portableState from "../claws/portable-heartbeat-state.js";
import { portableHeartbeatStateDigest } from "../claws/portable-heartbeat-state.kernel.js";
import { portableHeartbeatSettingsRevision } from "../claws/portable-heartbeat.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import { observeCronReceiptAuthority } from "../cron/store/receipt-authority-owner.js";
import { finishCronRunReceiptAsync } from "../cron/store/run-receipt-store.js";
import { claimCronRunReceiptForTest } from "../cron/store/run-receipt-store.test-support.js";
import { acquireFileLock } from "../infra/file-lock.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { clawsAutomationHandlers } from "./server-methods/claws-automations.js";
import type { RespondFn } from "./server-methods/types.js";

const method = "claws.automations.mutate";
type HandlerOptions = Parameters<(typeof clawsAutomationHandlers)[typeof method]>[0];
type Response = { ok: boolean; payload: unknown; error: Parameters<RespondFn>[2] };
type Mutation = ClawAutomationMutationRequest["mutation"];
type MutationIntent =
  | Omit<Extract<Mutation, { kind: "import" }>, "expectedSettingsRevision">
  | Omit<Extract<Mutation, { kind: "update" }>, "expectedSettingsRevision">
  | Exclude<Mutation, { kind: "import" | "update" }>;

async function invoke(
  context: HandlerOptions["context"],
  params: Record<string, unknown>,
  guard?: () => void,
): Promise<Response> {
  let response: Response | undefined;
  await clawsAutomationHandlers[method]({
    context,
    params,
    sessionMutationCommitGuard: guard,
    respond: (ok, payload, error) => {
      response = { ok, payload, error };
    },
  });
  return expectDefined(response, "Portable mutation returned no Gateway response");
}

async function request(
  context: HandlerOptions["context"],
  agentId: string,
  mutation: MutationIntent,
): Promise<ClawAutomationMutationRequest> {
  const config = context.getRuntimeConfig();
  const snapshot = await portableState.readPortableHeartbeatState(agentId, config, {});
  return {
    agentId,
    binding: resolveClawMonitorCleanupBinding(context.cronStorePath),
    expectedStateDigest: portableHeartbeatStateDigest(snapshot),
    mutation:
      mutation.kind === "import" || mutation.kind === "update"
        ? {
            ...mutation,
            expectedSettingsRevision: portableHeartbeatSettingsRevision(
              config,
              agentId,
              mutation.source.heartbeat,
            ),
          }
        : mutation,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Claw automation Gateway custody", () => {
  let state: OpenClawTestState;
  let cron: CronService;
  let context: HandlerOptions["context"];
  const config: OpenClawConfig = {
    agents: {
      defaults: { timeoutSeconds: 73 },
      entries: { observed: {}, rejected: {}, guards: {}, settings: {} },
    },
    skills: { load: { watch: false } },
  };

  beforeAll(async () => {
    state = await createOpenClawTestState({ label: "claw-automation-gateway" });
    await state.writeConfig(config);
    const storePath = state.statePath("cron", "jobs.json");
    cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: true,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    context = {
      cron,
      cronStorePath: storePath,
      getRuntimeConfig: () => config,
      isConfigReloadSettled: () => true,
    };
    await cron.start();
  });

  afterAll(async () => {
    cron?.stop();
    await cron?.waitForIdle();
    await state?.cleanup();
  });

  it("requires administrator scope for portable writes and removal journals", () => {
    for (const target of [method, "claws.removalJournal"]) {
      for (const scopes of [[], ["operator.read"], ["operator.write"]]) {
        expect(authorizeOperatorScopesForMethod(target, scopes), target).toEqual({
          allowed: false,
          missingScope: "operator.admin",
        });
      }
      expect(authorizeOperatorScopesForMethod(target, ["operator.admin"]), target).toEqual({
        allowed: true,
      });
    }
  });

  it("publishes a disabled portable job to its live receipt authority and scheduler", async () => {
    const imported = await invoke(
      context,
      await request(context, "observed", {
        kind: "import",
        source: { heartbeat: { every: "37m" }, scratch: "synthetic checklist" },
      }),
    );
    expect(imported.ok, imported.error?.message).toBe(true);
    const original = await portableState.readPortableHeartbeatState("observed", config, {});
    const job = expectDefined(original.job, "Imported ordinary automation");
    expect(await cron.readJob(job.id)).toMatchObject({ id: job.id, enabled: true });
    const handle = claimCronRunReceiptForTest(context.cronStorePath, job, Date.now());
    const source = captureOpenClawStateWorkerContext();
    const command = {
      type: "cron.currentReceipt" as const,
      handle,
      includeJob: true,
      includeAvailability: true,
    };
    const snapshot = await executeExistingOpenClawStateRead(
      { path: source.admission.databasePath, env: source.environment },
      command,
      { context: source, current: true },
    );
    if (!snapshot?.ok || snapshot.type !== command.type) {
      throw new Error("Expected a current receipt snapshot");
    }
    const observation = observeCronReceiptAuthority(source, command, snapshot.facts);
    try {
      await observation.prepared;
      expect(observation.readForPreparation().messageRevoked).toBe(false);
      const updated = await invoke(
        context,
        await request(context, "observed", {
          kind: "update",
          source: { heartbeat: { every: "0m" }, scratch: "synthetic checklist" },
        }),
      );
      expect(updated.ok, updated.error?.message).toBe(true);
      expect(await cron.readJob(job.id)).toMatchObject({ id: job.id, enabled: false });
      expect(observation.readForPreparation()).toMatchObject({
        facts: { job: { id: job.id, enabled: false } },
        messageRevoked: true,
      });
      const current = await portableState.readPortableHeartbeatState("observed", config, {});
      expect(current.receipt?.jobId).toBe(job.id);
      expect(current.scratch).toEqual(original.scratch);
    } finally {
      observation.release();
      await finishCronRunReceiptAsync({ handle, status: "skipped", finishedAtMs: Date.now() });
    }
  });

  it("rejects wrong bindings, private authority injection, and stale plans without durable changes", async () => {
    const params = await request(context, "rejected", {
      kind: "import",
      source: { heartbeat: { every: "37m" } },
    });
    const before = await portableState.readPortableHeartbeatState("rejected", config, {});
    for (const field of ["configPath", "statePath", "cronStorePath"] as const) {
      const result = await invoke(context, {
        ...params,
        binding: { ...params.binding, [field]: state.path("different-owner") },
      });
      expect(result, field).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: expect.stringContaining("selected Gateway") },
      });
    }
    const privateAuthority = { version: 1, runtimeId: "fixture", namespace: "tools", payload: {} };
    for (const mutation of [
      { ...params.mutation, runtimeAuthority: privateAuthority },
      { ...params.mutation, plannedJob: { runtimeAuthority: privateAuthority } },
      {
        ...params.mutation,
        source: { heartbeat: { every: "37m", runtimeAuthority: privateAuthority } },
      },
      { kind: "removeRef", expected: before },
    ]) {
      const result = await invoke(context, { ...params, mutation });
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    expect(await portableState.readPortableHeartbeatState("rejected", config, {})).toEqual(before);
    const imported = await invoke(context, params);
    expect(imported.ok, imported.error?.message).toBe(true);
    await cron.list({ includeDisabled: true });
    const committed = await portableState.readPortableHeartbeatState("rejected", config, {});
    expect(await invoke(context, params)).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE", message: expect.stringContaining("changed after planning") },
    });
    expect(await portableState.readPortableHeartbeatState("rejected", config, {})).toEqual(
      committed,
    );
  });

  it("refuses to reauthor a captured import after the configured timeout changes", async () => {
    const before = await portableState.readPortableHeartbeatState("settings", config, {});
    const params = await request(context, "settings", {
      kind: "import",
      source: { heartbeat: { every: "37m" } },
    });
    const defaults = expectDefined(config.agents?.defaults, "Configured agent defaults");
    const timeoutSeconds = defaults.timeoutSeconds;
    try {
      defaults.timeoutSeconds = 91;
      expect(await invoke(context, params)).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: expect.stringContaining("settings changed after planning"),
        },
      });
      expect(await portableState.readPortableHeartbeatState("settings", config, {})).toEqual(
        before,
      );
    } finally {
      defaults.timeoutSeconds = timeoutSeconds;
    }
  });

  it("revalidates request authority after the snapshot and at both native admission boundaries", async () => {
    const imported = await invoke(
      context,
      await request(context, "guards", {
        kind: "import",
        source: { heartbeat: { every: "37m" }, scratch: "retained scratch" },
      }),
    );
    expect(imported.ok, imported.error?.message).toBe(true);
    await cron.list({ includeDisabled: true });
    const before = await portableState.readPortableHeartbeatState("guards", config, {});
    const params = await request(context, "guards", {
      kind: "update",
      source: { heartbeat: { every: "41m" }, scratch: "must not commit" },
    });
    for (const stage of ["snapshot", "transaction", "commit"] as const) {
      let current = true;
      let witnessed = false;
      const read = portableState.readPortableHeartbeatState;
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const boundary =
        stage === "snapshot"
          ? vi
              .spyOn(portableState, "readPortableHeartbeatState")
              .mockImplementationOnce(async (...args) => {
                const result = await read(...args);
                current = false;
                witnessed = true;
                return result;
              })
          : vi
              .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
              .mockImplementation((admit, attachment) =>
                createAdmission((admission, grant) => {
                  if (
                    admission.stage === stage &&
                    isRecord(admission.facts) &&
                    typeof admission.facts.nonce === "string"
                  ) {
                    current = false;
                    witnessed = true;
                  }
                  admit(admission, grant);
                }, attachment),
              );
      try {
        const result = await invoke(context, params, () => {
          if (!current) {
            throw new Error(`Synthetic ${stage} request authority revoked`);
          }
        });
        expect(witnessed, stage).toBe(true);
        expect(result, stage).toMatchObject({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: expect.stringContaining(`Synthetic ${stage} request authority revoked`),
          },
        });
      } finally {
        boundary.mockRestore();
      }
      expect(await portableState.readPortableHeartbeatState("guards", config, {}), stage).toEqual(
        before,
      );
    }
  });
});

it("refuses portable import while a foreign Cron owner retains physical custody", async () => {
  await withOpenClawTestState({ label: "claw-automation-foreign-custody" }, async (state) => {
    const config: OpenClawConfig = { agents: { entries: { worker: {} } } };
    await state.writeConfig(config);
    openOpenClawStateDatabase();
    const source = captureOpenClawStateWorkerContext();
    const context = {
      cron: {
        remove: async () => {
          throw new Error("Unexpected portable removal during import");
        },
      },
      cronStorePath: state.statePath("cron", "jobs.json"),
      getRuntimeConfig: () => config,
      isConfigReloadSettled: () => true,
    };
    const before = await portableState.readPortableHeartbeatState("worker", config, {});
    const params = await request(context, "worker", {
      kind: "import",
      source: { heartbeat: { every: "37m" } },
    });
    const custody = await acquireFileLock(
      `${source.admission.identity.canonicalPath}.cron-authority`,
      {
        retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
        stale: 0,
        staleRecovery: "remove-if-definitely-stale",
      },
    );
    try {
      const lockBytes = await readFile(custody.lockPath);
      expect(await invoke(context, params)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: expect.stringMatching(/lock/iu) },
      });
      expect(await portableState.readPortableHeartbeatState("worker", config, {})).toEqual(before);
      expect(await readFile(custody.lockPath)).toEqual(lockBytes);
    } finally {
      await custody.release();
    }
  });
});
