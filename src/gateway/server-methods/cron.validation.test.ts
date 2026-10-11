// Cron validation tests cover channel target validation against plugin
// prefixes/aliases and runtime config for cron delivery destinations.

import { performance } from "node:perf_hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  bindCronManagementGrant,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { updateCronJobFromAgentTool } from "../../agents/tools/cron-tool-write.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import {
  applyLegacyCronStoreRepair,
  loadLegacyCronRepairState,
} from "../../commands/doctor/cron/legacy-repair.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { cronRunLogEntryToDetail } from "../../cron/run-history-detail.js";
import { CronService } from "../../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../cron/service.test-harness.js";
import { loadCronStore, saveCronStore } from "../../cron/store.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { loadCronRows } from "../../cron/store/row-codec.js";
import type { CronRunRecord } from "../../cron/store/run-history.types.js";
import type { CronDelivery, CronJob } from "../../cron/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { recordAgentDatabaseAdmissions } from "../../state/agent-database-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "../cron-creator-authority-grant.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import * as cronCallerScope from "./cron-caller-scope.js";
import { registerCronCreatorSessionTests } from "./cron-creator-session.test-support.js";
import { registerCronRunWaitTests } from "./cron-run-wait.test-support.js";
import { loadGatewaySessionEntry } from "./cron-session-reader.test-support.js";
import {
  createCronTestContext,
  callerClientWithCronCreatorAuthority,
  expectCronSuccess,
  expectResponseError,
  requireCronAddPayload,
  requireRecord,
  agentTurnCronParams,
  createCronTestInvoker,
  createCronCallerClient as callerClient,
  createCronJob,
  setCronValidationTestRegistry,
  pluginEntries,
  telegramConfig,
  telegramSlackConfig,
  telegramDisabledAccountConfig,
  msteamsConfig,
  slackSynologyConfig,
  slackConfig,
} from "./cron.validation.test-support.js";
import type { GatewayClient } from "./types.js";

const cronLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "cron-gateway-validation-" });

const getRuntimeConfig = vi.hoisted(() =>
  vi.fn<() => OpenClawConfig>(() => ({}) as OpenClawConfig),
);
const cronRunRecordsOverride = vi.hoisted(() =>
  vi.fn<
    (
      ...args: Parameters<typeof import("../../cron/store/read-only.js").readCronRunRecords>
    ) => Promise<CronRunRecord[]> | undefined
  >(),
);
const resolveCronDeliveryPreview = vi.hoisted(() =>
  vi.fn(async () => ({ label: "not requested", detail: "not requested" })),
);
const resolveCronDeliveryPreviews = vi.hoisted(() =>
  vi.fn(async ({ jobs }: { jobs: Array<{ id: string }> }) =>
    Object.fromEntries(
      jobs.map((job) => [job.id, { label: "not requested", detail: "not requested" }]),
    ),
  ),
);

vi.mock("../../cron/store/read-only.js", async () => {
  const actual = await vi.importActual<typeof import("../../cron/store/read-only.js")>(
    "../../cron/store/read-only.js",
  );
  return {
    ...actual,
    readCronRunRecords: (...args: Parameters<typeof actual.readCronRunRecords>) =>
      cronRunRecordsOverride(...args) ?? actual.readCronRunRecords(...args),
  };
});

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig,
  };
});

// mock-isolation: Validation fixtures do not read live session delivery metadata.
vi.mock("../../cron/delivery-preview.js", () => ({
  resolveCronDeliveryFailurePreview: async () => undefined,
  resolveCronDeliveryPreview,
  resolveCronDeliveryPreviews,
}));

import { cronHandlers } from "./cron.js";

function createCronContext(currentJobs?: CronJob | CronJob[]) {
  return createCronTestContext(currentJobs, getRuntimeConfig);
}

const invokeCron = createCronTestInvoker(cronHandlers, getRuntimeConfig);

async function invokeCronAdd(
  params: Record<string, unknown>,
  options?: { client?: GatewayClient },
) {
  return await invokeCron("cron.add", params, options);
}

async function invokeCronUpdate(
  params: Record<string, unknown>,
  currentJob?: CronJob,
  options?: { client?: GatewayClient },
) {
  return await invokeCron("cron.update", params, { currentJob, ...options });
}

async function invokeCronUpdateDelivery(
  delivery: Record<string, unknown>,
  currentJob = createCronJob(),
) {
  return await invokeCronUpdate(
    {
      id: "cron-1",
      patch: { delivery },
    },
    currentJob,
  );
}

async function invokeWake(params: Record<string, unknown>, client?: GatewayClient) {
  return await invokeCron("wake", params, { client });
}

function setRuntimeConfig(config: OpenClawConfig): void {
  getRuntimeConfig.mockReturnValue(config);
}

function expectInvalidCronPatternError(respond: ReturnType<typeof vi.fn>): void {
  expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes: "CronPattern" });
}

describe("cron method validation", () => {
  it("persists canonical delivery for published cron.add and cron.update request aliases", async () => {
    const { storePath } = await makeStorePath();
    getRuntimeConfig.mockReturnValue(telegramConfig());
    const scheduler = createTestGatewayScheduler();
    const cron = new CronService({
      scheduler,
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: cronLogger,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });
    const context = createDirectChatContext({ cron, cronStorePath: storePath, getRuntimeConfig });
    const readRow = () =>
      expectDefined(
        loadCronRows(openOpenClawStateDatabase().db, cronStoreKey(storePath))[0],
        "persisted cron request",
      );
    const createDelivery = Object.freeze({
      mode: "deliver",
      channel: "telegram",
      to: "telegram:123",
      threadId: 123,
      accountId: "bot:12345",
    });
    const params = agentTurnCronParams({ enabled: false, delivery: createDelivery });
    const respond = vi.fn();
    try {
      await expectDefined(
        cronHandlers["cron.add"],
        "cron.add handler",
      )({
        req: { type: "req", id: "delivery-alias-add", method: "cron.add", params },
        params,
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenLastCalledWith(
        true,
        expect.objectContaining({
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "telegram:123",
            threadId: 123,
            accountId: "bot:12345",
          },
        }),
        undefined,
      );
      const created = readRow();
      expect(JSON.parse(created.job_json).delivery).toEqual({
        mode: "announce",
        channel: "telegram",
        to: "telegram:123",
        threadId: 123,
        accountId: "bot:12345",
      });
      expect(createDelivery.mode).toBe("deliver");
      await cron.update(created.job_id, { delivery: { mode: "none" } });
      expect(JSON.parse(readRow().job_json).delivery.mode).toBe("none");
      const updateDelivery = Object.freeze({
        mode: " DeLiVeR ",
        to: "telegram:456",
        threadId: "456",
      });
      const updateParams = { id: created.job_id, patch: { delivery: updateDelivery } };
      await expectDefined(
        cronHandlers["cron.update"],
        "cron.update handler",
      )({
        req: {
          type: "req",
          id: "delivery-alias-update",
          method: "cron.update",
          params: updateParams,
        },
        params: updateParams,
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenLastCalledWith(
        true,
        expect.objectContaining({
          id: created.job_id,
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "telegram:456",
            threadId: "456",
            accountId: "bot:12345",
          },
        }),
        undefined,
      );
      expect(JSON.parse(readRow().job_json).delivery).toEqual({
        mode: "announce",
        channel: "telegram",
        to: "telegram:456",
        threadId: "456",
        accountId: "bot:12345",
      });
      expect(updateDelivery.mode).toBe(" DeLiVeR ");
    } finally {
      cron.stop();
      await scheduler.stop();
    }
  });

  it.each([
    ["cron.list", false, "channel-owner", true],
    ["cron.get", false, "channel-owner", true],
    ["cron.update", false, "channel-owner", false],
    ["cron.run", false, "channel-owner", true],
    ["cron.remove", true, "control-ui-admin", true],
  ] as const)(
    "%s manages a foreign automation (close after commit: %s, source: %s, trusted: %s)",
    async (method, closeAfterCommit, source, trusted) => {
      const client = callerClient("main");
      const identity = client.internal!.agentRuntimeIdentity!;
      const authority = claimAgentRunDelegatedAuthority(identity.operationalRunInstance);
      identity.delegatedAuthority = { kind: "local", ...authority };
      setRuntimeConfig({ commands: { ownerAllowFrom: ["discord:owner-1"] } });
      const scope = createCronCreatorAuthorityRunScope(
        identity.operationalRunInstance.runId,
        source === "channel-owner" ? { kind: "external", channel: "discord" } : { kind: "local" },
        source === "channel-owner"
          ? {
              source,
              isCurrent: () =>
                isConfiguredCommandOwner(getRuntimeConfig(), {
                  channel: "discord",
                  senderId: "owner-1",
                }),
            }
          : { source },
      );
      const job = createCronJob({
        agentId: "telegram-agent",
        owner: {
          agentId: "telegram-agent",
          sessionKey: "agent:telegram-agent:telegram:dm:42",
          accountId: "telegram",
        },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:telegram-agent:telegram:dm:42",
          ownerAccountId: "telegram",
        },
      });
      if (trusted) {
        job.scheduledToolPolicy = { version: 1, mode: "trusted" };
      }
      const context = createCronContext(job);
      if (method === "cron.update" && !trusted) {
        job.payload = { kind: "agentTurn", message: "operator-created task without a cap" };
        delete job.scheduledToolPolicy;
      }
      if (closeAfterCommit) {
        context.cron.remove.mockImplementationOnce(async (_id, options) => {
          options?.commitGuard?.();
          revokeCronCreatorAuthorityRunScope(scope);
          return { ok: true, removed: true };
        });
      }
      try {
        const { respond } = await runWithCronCreatorAuthorityCapability(scope, () =>
          withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, async () => {
            identity.cronManagementGrant = bindCronManagementGrant(scope.runId)!.mint(method);
            return await invokeCron(
              method,
              {
                ...(method === "cron.list" ? { compact: true } : { id: job.id }),
                ...(method === "cron.update"
                  ? { patch: { payload: { kind: "agentTurn", message: "updated by admin" } } }
                  : {}),
              },
              { client, context },
            );
          }),
        );
        expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
        if (method === "cron.list") {
          expect(respond.mock.calls[0]?.[1]).toMatchObject({ jobs: [{ id: job.id }], total: 1 });
        }
      } finally {
        revokeCronCreatorAuthorityRunScope(scope);
        releaseAgentRunDelegatedAuthority(authority);
      }
    },
  );
  beforeEach(() => {
    getRuntimeConfig.mockReset().mockReturnValue({} as OpenClawConfig);
    cronRunRecordsOverride.mockReset();
    resolveCronDeliveryPreview
      .mockReset()
      .mockResolvedValue({ label: "not requested", detail: "not requested" });
    resolveCronDeliveryPreviews
      .mockReset()
      .mockImplementation(async ({ jobs }: { jobs: Array<{ id: string }> }) =>
        Object.fromEntries(
          jobs.map((job) => [job.id, { label: "not requested", detail: "not requested" }]),
        ),
      );
    loadGatewaySessionEntry
      .mockReset()
      .mockImplementation((sessionKey: string) => ({ canonicalKey: sessionKey, entry: undefined }));
    setCronValidationTestRegistry();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it.each(["add-current", "update", "wake"] as const)(
    "returns database admission refusal before cron %s prepares or mutates the target",
    async (operation) => {
      const refusal = {
        agentId: "cleaner",
        paths: ["/synthetic/cleaner/openclaw-agent.sqlite"],
        embeddedOwnerId: "main",
        code: "agent-database-ownership-mismatch" as const,
        reason: "Refused agent cleaner: its database belongs to main.",
        repairHint: "Inspect the divergent copy and restart after repair.",
      };
      recordAgentDatabaseAdmissions([refusal]);
      try {
        const { context, respond } =
          operation === "wake"
            ? await invokeWake({ mode: "now", text: "hello", agentId: "cleaner" })
            : operation === "update"
              ? await invokeCronUpdate(
                  { id: "cron-1", patch: { agentId: "cleaner" } },
                  createCronJob(),
                )
              : await invokeCronAdd(
                  agentTurnCronParams({
                    agentId: "cleaner",
                    ...(operation === "add-current"
                      ? { sessionTarget: "current", sessionKey: "agent:cleaner:main" }
                      : {}),
                  }),
                );
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: `${refusal.reason}\n${refusal.repairHint}`,
            details: refusal,
          }),
        );
        expect(resolveCronDeliveryPreview).not.toHaveBeenCalled();
        expect(context.cron.add).not.toHaveBeenCalled();
        expect(context.cron.update).not.toHaveBeenCalled();
        expect(context.cron.wake).not.toHaveBeenCalled();
        expect(loadGatewaySessionEntry).not.toHaveBeenCalled();
      } finally {
        recordAgentDatabaseAdmissions([]);
      }
    },
  );

  describe.each(["get", "update", "remove", "run", "runs"] as const)(
    "cron.%s caller scope",
    (method) => {
      it.each(["foreign agent", "operator command"] as const)(
        "hides a %s job without dispatch or disclosure",
        async (hiddenBy) => {
          const foreign = hiddenBy === "foreign agent";
          const jobId = method === "get" ? "cron-42" : "cron-1";
          const context = createCronContext(
            createCronJob({
              id: jobId,
              agentId: foreign && method !== "get" ? "worker" : "ops",
              ...(!foreign
                ? {
                    enabled: method !== "run",
                    payload: {
                      kind: "command",
                      argv: ["deploy"],
                      env: { MARKER_ENV: "fixture-marker" },
                    },
                  }
                : {}),
            }),
          );
          const params = {
            ...(foreign && (method === "get" || method === "remove" || method === "run")
              ? { jobId }
              : { id: jobId }),
            ...(method === "update" ? { patch: { enabled: false } } : {}),
            ...(method === "run" && !foreign ? { mode: "force" } : {}),
          };
          const { respond } = await invokeCron(`cron.${method}`, params, {
            context,
            client: callerClient(foreign && method === "get" ? "worker" : "ops"),
          });

          expect(context.cron.update).not.toHaveBeenCalled();
          expect(context.cron.remove).not.toHaveBeenCalled();
          expect(context.cron.enqueueRun).not.toHaveBeenCalled();
          if (method === "runs") {
            expect(context.cron.readJob).toHaveBeenCalledExactlyOnceWith(jobId);
            expect(context.cron.list).not.toHaveBeenCalled();
          }
          expectResponseError(respond, {
            code: "INVALID_REQUEST",
            messageIncludes:
              method === "get" ? `cron job not found: ${jobId}` : `Automation not found: ${jobId}`,
            ...(method === "get" && foreign
              ? { details: { code: "CRON_JOB_NOT_FOUND", jobId } }
              : {}),
          });
          expect(JSON.stringify(respond.mock.calls)).not.toContain("fixture-marker");
        },
      );
    },
  );

  it.each([false])("runs an exact job id with caller scope %s", async (scoped) => {
    const context = createCronContext(createCronJob({ id: "cron-1", agentId: "ops" }));
    const { respond } = await invokeCron(
      "cron.run",
      {
        id: scoped ? "cron-1" : " cron-1 ",
        ...(scoped
          ? { mode: "due", expectedProcessInstanceId: getGatewayProcessInstanceId() }
          : {}),
      },
      { context, client: scoped ? callerClient("ops") : undefined },
    );
    expect(context.cron.readJob).toHaveBeenCalledWith("cron-1");
    if (scoped) {
      expect(context.cron.enqueueRun).toHaveBeenCalledWith("cron-1", "due", {
        commitGuard: expect.any(Function),
      });
    } else {
      expect(context.cron.enqueueRun).toHaveBeenCalledWith("cron-1", "force");
    }
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        enqueued: true,
        runId: "run-1",
        processInstanceId: getGatewayProcessInstanceId(),
      },
      undefined,
    );
  });

  it.each([
    {
      name: "foreign session target",
      fields: { sessionTarget: "session:agent:worker:telegram:direct:alice" },
    },
    { name: "operator-only watcher", fields: { schedule: { kind: "on-exit", command: "deploy" } } },
  ] satisfies Array<{ name: string; fields: Partial<CronJob> }>)(
    "hides a same-agent job with a $name",
    async ({ fields }) => {
      const { respond } = await invokeCron(
        "cron.get",
        { id: "cron-42" },
        {
          currentJob: createCronJob({ id: "cron-42", agentId: "ops", ...fields }),
          client: callerClient("ops"),
        },
      );
      expectResponseError(respond, {
        code: "INVALID_REQUEST",
        messageIncludes: "cron job not found: cron-42",
      });
      expect(JSON.stringify(respond.mock.calls)).not.toContain("deploy");
    },
  );

  describe("cron.list request diagnostics", () => {
    let clock = 0;
    let previousDiagnostics: boolean;
    beforeEach(() => {
      previousDiagnostics = areDiagnosticsEnabledForProcess();
      setDiagnosticsEnabledForProcess(true);
      clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
    });
    afterEach(() => {
      setDiagnosticsEnabledForProcess(previousDiagnostics);
      vi.restoreAllMocks();
    });

    it.each([false, true])(
      "attributes scoped inventory work without leaking hidden job data (failure: %s)",
      async (fails) => {
        const jobs = Array.from({ length: 201 }, (_, index) =>
          createCronJob({ id: `private-job-${index}`, agentId: index === 200 ? "ops" : "other" }),
        );
        const context = createCronContext(jobs);
        const listPage = context.cron.listPage.getMockImplementation()!;
        context.cron.listPage.mockImplementation(async (...args) => {
          clock += 1100;
          return await listPage(...args);
        });
        const matches = cronCallerScope.cronJobMatchesCallerScope;
        const failure = new Error("scope failure");
        vi.spyOn(cronCallerScope, "cronJobMatchesCallerScope").mockImplementation((params) => {
          clock += 1;
          if (fails && params.job.id === "private-job-200") {
            throw failure;
          }
          return matches(params);
        });
        const respond = vi.fn();
        const invocation = invokeCron(
          "cron.list",
          { compact: true, limit: 1 },
          { context, client: callerClient("ops"), respond },
        );
        if (fails) {
          await expect(invocation).rejects.toBe(failure);
          expect(respond).not.toHaveBeenCalled();
        } else {
          await invocation;
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            true,
            expect.objectContaining({
              jobs: [expect.objectContaining({ id: "private-job-200" })],
              total: 1,
              hasMore: false,
            }),
            undefined,
          );
        }
        expect(context.logGateway.warn).toHaveBeenCalledExactlyOnceWith("cron: slow list request", {
          operation: "cron.list",
          elapsedMs: fails ? 1301 : 1302,
          phaseDurationsMs: fails
            ? { setup: 0, listing: 1301 }
            : { setup: 0, listing: 1302, projection: 0, response: 0, handlerExit: 0 },
          sourcePageMs: 1301,
          sourcePageCount: 1,
          scopeAttemptCount: 1,
          handlerOutcome: fails ? "threw" : "returned",
          responseOutcome: fails ? "none" : "ok",
          compact: true,
          previewsRequested: false,
          scopeApplied: true,
          ...(!fails ? { returnedCount: 1 } : {}),
          scopeProcessingMs: fails ? 0 : 1,
        });
      },
    );

    it("preserves a response error when the diagnostic sink throws", async () => {
      const context = createCronContext(createCronJob());
      const failure = new Error("original failure");
      const listPage = context.cron.listPage.getMockImplementation()!;
      context.cron.listPage.mockImplementation(async (opts) => {
        clock = 1100;
        return await listPage(opts);
      });
      const respond = vi.fn(() => {
        throw failure;
      });
      context.logGateway.warn.mockImplementation(() => {
        throw new Error("diagnostic failure");
      });
      await expect(invokeCron("cron.list", { compact: true }, { context, respond })).rejects.toBe(
        failure,
      );
      expect(respond).toHaveBeenCalledOnce();
      expect(context.logGateway.warn).toHaveBeenCalledExactlyOnceWith(
        "cron: slow list request",
        expect.objectContaining({ handlerOutcome: "threw", responseOutcome: "threw" }),
      );
    });
  });

  it.each([
    {
      kind: "stream",
      command: ["fixture-watcher-command"],
      cwd: "/fixture/private-watcher",
      mode: "match",
      match: "fixture-private-match",
    },
  ] satisfies CronJob["schedule"][])(
    "keeps $kind watcher details out of operator compact lists",
    async (schedule) => {
      const context = createCronContext(
        createCronJob({
          schedule,
          payload: { kind: "agentTurn", message: "fixture-private-payload" },
          delivery: { mode: "webhook", to: "https://fixture-private-delivery.invalid" },
        }),
      );
      const { respond } = await invokeCron("cron.list", { compact: true }, { context });
      const payload = requireRecord(respond.mock.calls[0]?.[1], "compact cron.list payload");
      const [job] = payload.jobs as Array<Record<string, unknown>>;
      expect(job).toMatchObject({ id: "cron-1", scheduleKind: schedule.kind });
      for (const field of ["schedule", "command", "cwd", "payload", "delivery"]) {
        expect(job).not.toHaveProperty(field);
      }
      expect(payload).not.toHaveProperty("deliveryPreviews");
      for (const value of [
        "fixture-watcher-command",
        "/fixture/private-watcher",
        "fixture-private-match",
        "fixture-private-payload",
        "fixture-private-delivery.invalid",
      ]) {
        expect(JSON.stringify(payload)).not.toContain(value);
      }
    },
  );

  it("filters operator command cron jobs from caller-scoped cron.list", async () => {
    const context = createCronContext([
      createCronJob({
        id: "command-job",
        agentId: "ops",
        payload: {
          kind: "command",
          argv: ["deploy"],
          env: { MARKER_ENV: "fixture-marker" },
        },
      }),
      createCronJob({ id: "agent-job", agentId: "ops", name: "agent job" }),
    ]);

    const { respond } = await invokeCron(
      "cron.list",
      { includeDisabled: true, compact: true },
      { context, client: callerClient("ops") },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        total: 1,
        jobs: [expect.objectContaining({ id: "agent-job" })],
      }),
      undefined,
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("fixture-marker");
  });

  it("rejects caller-scoped cron.list for a foreign explicit agentId", async () => {
    const context = createCronContext(createCronJob({ agentId: "ops" }));

    const { respond } = await invokeCron(
      "cron.list",
      { agentId: "worker" },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.listPage).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "agentId outside caller scope",
    });
  });

  it("filters caller-scoped cron.list jobs with foreign session targets before pagination", async () => {
    const foreignSessionJob = createCronJob({
      id: "cron-foreign",
      agentId: "ops",
      sessionTarget: "session:agent:worker:telegram:direct:alice",
    });
    const firstSafeJob = createCronJob({
      id: "cron-safe-1",
      agentId: "ops",
      sessionTarget: "session:agent:ops:telegram:direct:bob",
    });
    const secondSafeJob = createCronJob({
      id: "cron-safe-2",
      agentId: "ops",
    });
    const context = createCronContext([foreignSessionJob, firstSafeJob, secondSafeJob]);

    const { respond } = await invokeCron(
      "cron.list",
      { compact: true, limit: 1 },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.listPage).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: undefined }),
      expect.any(Function),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        total: 2,
        offset: 0,
        limit: 1,
        hasMore: true,
        nextOffset: 1,
        jobs: [expect.objectContaining({ id: "cron-safe-1" })],
      }),
      undefined,
    );
  });

  it.each([
    {
      name: "current target resolved from a reserved caller session",
      params: {
        sessionTarget: "current",
        sessionKey: "agent:main:harness:codex:supervision:native-thread",
      },
    },
  ])("rejects cron.add for $name", async ({ params }) => {
    const { context, respond } = await invokeCronAdd(agentTurnCronParams(params));

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "reserved for agent harness-owned sessions",
    });
  });

  it("allows cron.update to target a pre-existing unlocked harness-prefixed session", async () => {
    const sessionKey = "agent:main:harness:legacy-notes";
    loadGatewaySessionEntry.mockReturnValue({
      canonicalKey: sessionKey,
      entry: { agentHarnessId: "codex", sessionId: "legacy-session" },
    });
    const result = await invokeCronUpdate(
      { id: "cron-1", patch: { sessionTarget: `session:${sessionKey}` } },
      createCronJob({ agentId: "main" }),
    );
    expect(result.context.cron.update).toHaveBeenCalled();
    expectCronSuccess(result.respond);
  });

  it("rejects cron.add targeting an existing locked harness session", async () => {
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    loadGatewaySessionEntry.mockReturnValue({
      canonicalKey: sessionKey,
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      },
    });

    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({ sessionTarget: `session:${sessionKey}` }),
    );

    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "reserved for agent harness-owned sessions",
    });
  });

  it("rejects cron.update targeting an existing locked ordinary session", async () => {
    const sessionKey = "agent:main:project-native-session";
    loadGatewaySessionEntry.mockReturnValue({
      canonicalKey: sessionKey,
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      },
    });
    const result = await invokeCronUpdate(
      { id: "cron-1", patch: { sessionTarget: `session:${sessionKey}` } },
      createCronJob({ agentId: "main" }),
    );
    expect(result.context.cron.update).not.toHaveBeenCalled();
    expectResponseError(result.respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "identity is locked and cannot be replaced or shared",
    });
  });

  it("revalidates an unchanged session target when cron.update changes its agent", async () => {
    const sessionKey = "project-native-session";
    loadGatewaySessionEntry.mockReturnValue({
      canonicalKey: `agent:worker:${sessionKey}`,
      entry: {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        sessionId: "native-session",
      },
    });

    const { context, respond } = await invokeCronUpdate(
      { id: "cron-1", patch: { agentId: "worker" } },
      createCronJob({ agentId: "main", sessionTarget: `session:${sessionKey}` }),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "identity is locked and cannot be replaced or shared",
    });
  });

  it("keeps a harness-origin key as routing context for a main-session job", async () => {
    const { context, respond } = await invokeCronAdd({
      name: "main reminder",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      sessionKey: "agent:main:harness:codex:supervision:native-thread",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "remind me" },
    });

    expect(context.cron.add).toHaveBeenCalled();
    expectCronSuccess(respond);
  });

  it("rejects wake requests targeting reserved harness sessions", async () => {
    const { context, respond } = await invokeWake({
      mode: "now",
      text: "ping",
      sessionKey: "agent:main:harness:codex:supervision:native-thread",
    });

    expect(context.cron.wake).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "reserved for agent harness-owned sessions",
    });
  });

  it.each([
    {
      sessionKey: "agent:main:harness:legacy-notes",
      entry: { agentHarnessId: "codex", sessionId: "legacy-session" },
    },
  ])("allows wake for existing harness session $sessionKey", async ({ sessionKey, entry }) => {
    loadGatewaySessionEntry.mockReturnValueOnce({ canonicalKey: sessionKey, entry });
    const { context, respond } = await invokeWake({ mode: "now", text: "ping", sessionKey });
    expect(context.cron.wake).toHaveBeenCalledWith({
      commitGuard: expect.any(Function),
      createIfMissing: true,
      agentId: "main",
      mode: "now",
      text: "ping",
      sessionKey,
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("keeps wake mutation at zero when delegated authority closes during preparation", async () => {
    let authorityActive = true;
    let releasePreparation: (() => void) | undefined;
    const held = new Promise<undefined>((resolve) => {
      releasePreparation = () => resolve(undefined);
    });
    const context = createCronContext();
    context.cron.prepareWake.mockImplementationOnce(async () => await held);
    context.validateAgentRuntimeApprovalAuthority = () => authorityActive;

    const invocation = invokeCron(
      "wake",
      { mode: "now", text: "ping", agentId: "ops" },
      { context, client: callerClient("ops") },
    );
    await vi.waitFor(() => expect(context.cron.prepareWake).toHaveBeenCalledOnce());
    authorityActive = false;
    releasePreparation?.();
    const { respond } = await invocation;

    expect(context.cron.wake).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "agent runtime authority is no longer active",
    });
  });

  it("stamps declaration ownership from the trusted caller and scopes key lookup", async () => {
    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({
        declarationKey: "daily-report",
        owner: { agentId: "spoofed", sessionKey: "agent:spoofed:main" },
      }),
      { client: callerClient("ops", "work") },
    );

    const payload = requireCronAddPayload(context);
    expect(payload.agentId).toBe("ops");
    expect(payload).not.toHaveProperty("callerScope");
    expect(payload.owner).toEqual({
      agentId: "ops",
      sessionKey: "agent:ops:main",
      accountId: "work",
    });
    const options = requireRecord(context.cron.add.mock.calls[0]?.[1], "cron.add options");
    expect(options.scheduledToolPolicy).toEqual({
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:ops:main",
      ownerAccountId: "work",
    });
    const matchesExisting = options.matchesExisting as ((job: CronJob) => boolean) | undefined;
    expect(matchesExisting?.(createCronJob({ agentId: "ops" }))).toBe(true);
    expect(matchesExisting?.(createCronJob({ agentId: "worker" }))).toBe(false);
    expect(matchesExisting?.(createCronJob({ agentId: "worker", owner: { agentId: "ops" } }))).toBe(
      true,
    );
    expect(
      matchesExisting?.(
        createCronJob({
          agentId: "worker",
          owner: { agentId: "ops", accountId: "personal" },
        }),
      ),
    ).toBe(false);
    expect(matchesExisting?.(createCronJob({ agentId: "ops", owner: { agentId: "worker" } }))).toBe(
      false,
    );
    expectCronSuccess(respond);
  });

  registerCronCreatorSessionTests({
    createCronContext,
    invokeCron,
    loadGatewaySessionEntry,
    resolveCronDeliveryPreview,
  });

  it.each(["add", "update"] as const)(
    "captures creator authority once at cron.%s commit and rejects replay",
    async (method) => {
      const runtimeAuthority = {
        version: 1 as const,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [{ id: "calendar" }] },
      };
      const scope = createCronCreatorAuthorityRunScope(`run-${method}`);
      const grant = mintCronCreatorAuthorityGrant(scope, undefined, runtimeAuthority);
      const currentJob = createCronJob({
        agentId: "ops",
        owner: { agentId: "ops", sessionKey: "agent:ops:main", accountId: "default" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:ops:main",
          ownerAccountId: "default",
        },
      });
      const context = createCronContext(method === "update" ? currentJob : undefined);
      context.validateAgentRuntimeApprovalAuthority = () => true;
      const client = callerClientWithCronCreatorAuthority(grant);
      const params =
        method === "add"
          ? agentTurnCronParams()
          : {
              jobId: currentJob.id,
              patch: { payload: { kind: "agentTurn", message: "updated", toolsAllow: ["read"] } },
            };
      const committed = method === "add" ? context.committedAdds : context.committedUpdates;
      try {
        const first = await invokeCron(`cron.${method}`, params, { context, client });
        expectCronSuccess(first.respond);
        expect(committed).toHaveLength(1);
        expect(context.committedRuntimeAuthorityCaptures).toEqual([true]);
        expect(context.committedRuntimeAuthorities).toEqual([runtimeAuthority]);
        const replay = await invokeCron(`cron.${method}`, params, { context, client });
        expectResponseError(replay.respond, {
          code: "INVALID_REQUEST",
          messageIncludes: "Configured MCP cron authority is no longer active",
        });
        expect(committed).toHaveLength(1);
      } finally {
        revokeCronCreatorAuthorityRunScope(scope);
      }
    },
  );

  it("rejects a mismatched cron.add runId without consuming the exact grant", async () => {
    const scope = createCronCreatorAuthorityRunScope("run-add");
    const grant = mintCronCreatorAuthorityGrant(scope);
    const context = createCronContext();

    const mismatch = await invokeCron("cron.add", agentTurnCronParams(), {
      context,
      client: callerClientWithCronCreatorAuthority({ ...grant, runId: "run-other" }),
    });
    expectResponseError(mismatch.respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "Configured MCP cron authority is no longer active",
    });
    expect(context.committedAdds).toHaveLength(0);

    const exact = await invokeCron("cron.add", agentTurnCronParams(), {
      context,
      client: callerClientWithCronCreatorAuthority(grant),
    });
    expectCronSuccess(exact.respond);
    expect(context.committedAdds).toHaveLength(1);
    revokeCronCreatorAuthorityRunScope(scope);
  });

  it.each(["add", "update"] as const)(
    "keeps cron.%s mutation at zero after its creator grant is revoked",
    async (method) => {
      const scope = createCronCreatorAuthorityRunScope(`run-${method}-revoked`);
      const grant = mintCronCreatorAuthorityGrant(scope);
      revokeCronCreatorAuthorityRunScope(scope);
      const context = createCronContext(
        method === "add"
          ? undefined
          : createCronJob({
              agentId: "ops",
              owner: { agentId: "ops", sessionKey: "agent:ops:main", accountId: "default" },
              scheduledToolPolicy: {
                version: 1,
                mode: "account",
                ownerSessionKey: "agent:ops:main",
                ownerAccountId: "default",
              },
            }),
      );
      const params =
        method === "add"
          ? agentTurnCronParams()
          : {
              jobId: "cron-1",
              patch: { payload: { kind: "agentTurn", message: "updated", toolsAllow: ["read"] } },
            };
      const { respond } = await invokeCron(`cron.${method}`, params, {
        context,
        client: callerClientWithCronCreatorAuthority(grant),
      });
      expectResponseError(respond, {
        code: "INVALID_REQUEST",
        messageIncludes: "Configured MCP cron authority is no longer active",
      });
      expect(context.committedAdds).toHaveLength(0);
      expect(context.committedUpdates).toHaveLength(0);
    },
  );

  it.each([
    ["cron.add", agentTurnCronParams(), "add"],
    ["cron.update", { id: "cron-1", patch: { description: "changed" } }, "updateWithPrecondition"],
    ["cron.scratch.set", { id: "cron-1", content: "notes" }, "writeScratch"],
    ["cron.remove", { id: "cron-1" }, "remove"],
    ["cron.run", { id: "cron-1", mode: "force" }, "enqueueRun"],
  ] as const)(
    "carries the original caller fence to the %s commit owner",
    async (method, params, owner) => {
      const context = createCronContext(createCronJob({ agentId: "ops" }));
      const client = callerClient("ops");
      client.internal!.agentRuntimeIdentity!.cronToolsAllowCapture = "final-executable-surface";
      client.internal!.agentRuntimeIdentity!.turnSourceLocal = true;
      const sessionMutationCommitGuard = vi.fn(() => {
        throw new TypeError("original caller was revoked");
      });

      const result = await invokeCron(method, params, {
        context,
        client,
        sessionMutationCommitGuard,
      });

      expect(context.cron[owner]).toHaveBeenCalledOnce();
      expect(sessionMutationCommitGuard).toHaveBeenCalledOnce();
      expectResponseError(result.respond, {
        code: "INVALID_REQUEST",
        messageIncludes: "original caller was revoked",
      });
      expect(context.committedAdds).toHaveLength(0);
      expect(context.committedUpdates).toHaveLength(0);
    },
  );

  it("checks a direct Cron caller again at the add commit boundary", async () => {
    const context = createCronContext();
    const result = await invokeCron("cron.add", agentTurnCronParams(), {
      context,
      hasCurrentClientAuthority: () => false,
    });
    expect(context.cron.add).toHaveBeenCalledOnce();
    expect(context.committedAdds).toHaveLength(0);
    expectResponseError(result.respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "Gateway caller authority is no longer active",
    });
  });

  it.each([
    ["cron.scratch.set", { id: "cron-1", content: "notes" }, "writeScratch"],
    ["cron.remove", { id: "cron-1" }, "remove"],
    ["cron.run", { id: "cron-1", mode: "force" }, "enqueueRun"],
  ] as const)(
    "revalidates delegated authority at the %s commit owner",
    async (method, params, owner) => {
      const context = createCronContext(createCronJob({ agentId: "ops" }));
      let authorityActive = true;
      context.validateAgentRuntimeApprovalAuthority = () => authorityActive;
      if (owner === "writeScratch") {
        context.cron.writeScratch.mockImplementationOnce(async (_id, write) => {
          authorityActive = false;
          write.commitGuard?.();
          throw new Error("unreachable");
        });
      } else if (owner === "remove") {
        context.cron.remove.mockImplementationOnce(async (_id, options) => {
          authorityActive = false;
          options?.commitGuard?.();
          throw new Error("unreachable");
        });
      } else {
        context.cron.enqueueRun.mockImplementationOnce(async (_id, _mode, options) => {
          authorityActive = false;
          options?.commitGuard?.();
          throw new Error("unreachable");
        });
      }

      const { respond } = await invokeCron(method, params, {
        context,
        client: callerClient("ops"),
      });

      expect(context.cron[owner]).toHaveBeenCalledOnce();
      expectResponseError(respond, {
        code: "INVALID_REQUEST",
        messageIncludes: "agent runtime authority is no longer active",
      });
    },
  );

  it.each([
    ["cron.scratch.set", { id: "cron-1", content: "notes" }, "writeScratch"],
    ["cron.remove", { id: "cron-1" }, "remove"],
    ["cron.run", { id: "cron-1", mode: "force" }, "enqueueRun"],
  ] as const)("revalidates caller scope at the %s commit owner", async (method, params, owner) => {
    const { storePath } = await makeStorePath();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: cronLogger,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob,
    });
    await cron.start();
    const releaseReplacement = createDeferred();
    try {
      const staleJob = await cron.add({
        id: "cron-1",
        name: "scoped job",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        agentId: "main",
        payload: { kind: "systemEvent", text: "before replacement" },
        delivery: { mode: "none" },
      });
      const replacementEntered = createDeferred();
      const replacement = cron.updateWithPrecondition(
        staleJob.id,
        {
          agentId: "worker",
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "replacement" },
        },
        async () => {
          replacementEntered.resolve();
          await releaseReplacement.promise;
        },
      );
      await replacementEntered.promise;

      const mutationQueued = createDeferred();
      const context = createCronContext();
      context.cron.readJob.mockResolvedValue(staleJob);
      context.cron.getJob.mockImplementation((id) => cron.getJob(id));
      context.cron.getDefaultAgentId.mockImplementation(() => "main");
      if (owner === "writeScratch") {
        context.cron.writeScratch.mockImplementationOnce(async (id, write) => {
          mutationQueued.resolve();
          const result = await cron.writeScratch(id, write);
          if (!result.ok || !result.scratch) {
            throw new Error("expected scratch write to succeed");
          }
          return {
            ok: true,
            scratch: {
              content: result.scratch.content,
              revision: result.scratch.revision,
            },
            currentRevision: result.currentRevision,
          };
        });
      } else if (owner === "remove") {
        context.cron.remove.mockImplementationOnce(async (id, options) => {
          mutationQueued.resolve();
          return await cron.remove(id, options);
        });
      } else {
        context.cron.enqueueRun.mockImplementationOnce(async (id, mode, options) => {
          mutationQueued.resolve();
          const result = await cron.enqueueRun(
            id,
            mode as "due" | "force" | "if-enabled" | undefined,
            options,
          );
          if (!result.ok || !("enqueued" in result) || !result.enqueued) {
            throw new Error("expected cron run to enqueue");
          }
          return { ok: true, enqueued: true, runId: result.runId };
        });
      }

      const invocation = invokeCron(method, params, {
        context,
        client: callerClient("main"),
      });
      await mutationQueued.promise;
      expect(context.cron.getJob).not.toHaveBeenCalled();

      releaseReplacement.resolve();
      await replacement;
      const { respond } = await invocation;

      expect(context.cron[owner]).toHaveBeenCalledOnce();
      if (owner === "writeScratch") {
        expect(await cron.readScratch(staleJob.id)).toMatchObject({ currentRevision: 0 });
      } else if (owner === "remove") {
        expect(await cron.readJob(staleJob.id)).toMatchObject({
          agentId: "worker",
          payload: { kind: "agentTurn", message: "replacement" },
        });
      } else {
        expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      }
      expectResponseError(respond, {
        code: "INVALID_REQUEST",
        messageIncludes: "unknown cron job id: cron-1",
      });
    } finally {
      releaseReplacement.resolve();
      cron.stop();
    }
  });

  it.each(["expired capability", "replaced capability target", "replaced owner target"] as const)(
    "rejects removal at commit after %s",
    async (change) => {
      const ownerSessionKey = "agent:ops:discord:work:group:creator";
      const job = createCronJob({
        agentId: "ops",
        owner: { agentId: "ops", sessionKey: ownerSessionKey, accountId: "work" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey,
          ownerAccountId: "work",
        },
      });
      const context = createCronContext(job);
      const client = callerClient(
        "ops",
        "work",
        change === "replaced owner target" ? ownerSessionKey : `agent:ops:cron:${job.id}:run:run-1`,
        job.id,
      );
      context.cron.remove.mockImplementationOnce(async (_id, options) => {
        if (change === "expired capability") {
          client.internal!.agentRuntimeIdentity!.cronSelfManagementContext!.expiresAtMs =
            Date.now() - 1;
        } else {
          context.cron.getJob.mockReturnValue(
            createCronJob({
              agentId: "ops",
              owner: { agentId: "ops", sessionKey: "agent:ops:main", accountId: "default" },
              scheduledToolPolicy: { version: 1, mode: "trusted" },
            }),
          );
        }
        options?.commitGuard?.();
        return { ok: true, removed: true };
      });
      const { respond } = await invokeCron("cron.remove", { id: job.id }, { context, client });
      expect(context.cron.remove).toHaveBeenCalledOnce();
      expectResponseError(respond, {
        code: "INVALID_REQUEST",
        messageIncludes: `unknown cron job id: ${job.id}`,
      });
    },
  );

  it("keeps new jobs scoped to their creator account while preserving accountless legacy jobs", async () => {
    const workOwned = createCronJob({
      owner: { agentId: "ops", sessionKey: "agent:ops:main", accountId: "work" },
    });
    const context = createCronContext(workOwned);

    const wrongAccount = await invokeCron(
      "cron.list",
      { compact: true },
      { context, client: callerClient("ops", "default") },
    );
    expect(wrongAccount.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ total: 0, jobs: [] }),
      undefined,
    );

    const matchingAccount = await invokeCron(
      "cron.list",
      { compact: true },
      { context, client: callerClient("ops", "work") },
    );
    expect(matchingAccount.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ total: 1 }),
      undefined,
    );

    const legacyContext = createCronContext(
      createCronJob({ owner: { agentId: "ops", sessionKey: "agent:ops:main" } }),
    );
    const legacy = await invokeCron(
      "cron.list",
      { compact: true },
      { context: legacyContext, client: callerClient("ops", "other") },
    );
    expect(legacy.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ total: 1 }),
      undefined,
    );

    const accountOnlyContext = createCronContext(
      createCronJob({ agentId: "ops", owner: { accountId: "work" } }),
    );
    const accountOnlyWrong = await invokeCron(
      "cron.list",
      { compact: true },
      { context: accountOnlyContext, client: callerClient("ops", "other") },
    );
    expect(accountOnlyWrong.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ total: 0, jobs: [] }),
      undefined,
    );
    const accountOnlyMatch = await invokeCron(
      "cron.list",
      { compact: true },
      { context: accountOnlyContext, client: callerClient("ops", "work") },
    );
    expect(accountOnlyMatch.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ total: 1 }),
      undefined,
    );
  });

  it("binds scheduled authority access to its exact creator session", async () => {
    const ownerSessionKey = "agent:ops:discord:work:group:creator";
    const accountJob = createCronJob({
      owner: { agentId: "ops", sessionKey: ownerSessionKey, accountId: "work" },
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey,
        ownerAccountId: "work",
      },
    });
    const context = createCronContext(accountJob);

    const siblingClient = callerClient("ops", "work", "agent:ops:discord:work:group:sibling");
    const siblingList = await invokeCron(
      "cron.list",
      { compact: true },
      { context, client: siblingClient },
    );
    expect(siblingList.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ total: 0, jobs: [] }),
      undefined,
    );

    const siblingUpdate = await invokeCron(
      "cron.update",
      {
        id: accountJob.id,
        patch: {
          payload: {
            kind: "agentTurn",
            message: "replace creator prompt",
            toolsAllow: ["*"],
          },
        },
      },
      { context, client: siblingClient },
    );
    expect(siblingUpdate.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("Automation not found: cron-1") }),
    );
    expect(context.cron.updateWithPrecondition).not.toHaveBeenCalled();

    const ownerList = await invokeCron(
      "cron.list",
      { compact: true },
      { context, client: callerClient("ops", "work", ownerSessionKey) },
    );
    expect(ownerList.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ total: 1 }),
      undefined,
    );
  });

  it("preserves only current-job self-management for a capped scheduled run", async () => {
    const ownerSessionKey = "agent:ops:discord:work:group:creator";
    const accountJob = createCronJob({
      agentId: "ops",
      owner: { agentId: "ops", sessionKey: ownerSessionKey, accountId: "work" },
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey,
        ownerAccountId: "work",
      },
    });
    const siblingJob = createCronJob({
      id: "cron-2",
      agentId: "ops",
      owner: { agentId: "ops", sessionKey: ownerSessionKey, accountId: "work" },
      scheduledToolPolicy: accountJob.scheduledToolPolicy,
    });
    const context = createCronContext([accountJob, siblingJob]);
    const runClient = callerClient(
      "ops",
      "work",
      `agent:ops:cron:${accountJob.id}:run:run-1`,
      accountJob.id,
    );

    const list = await invokeCron("cron.list", { compact: true }, { context, client: runClient });
    expect(list.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ total: 1 }),
      undefined,
    );

    const get = await invokeCron("cron.get", { id: accountJob.id }, { context, client: runClient });
    expectCronSuccess(get.respond);

    const siblingGet = await invokeCron(
      "cron.get",
      { id: siblingJob.id },
      { context, client: runClient },
    );
    expectResponseError(siblingGet.respond, {
      code: "INVALID_REQUEST",
      messageIncludes: `cron job not found: ${siblingJob.id}`,
    });

    const expiredRunClient = callerClient(
      "ops",
      "work",
      `agent:ops:cron:${accountJob.id}:run:expired`,
      accountJob.id,
      Date.now() - 1,
    );
    const expiredGet = await invokeCron(
      "cron.get",
      { id: accountJob.id },
      { context, client: expiredRunClient },
    );
    expectResponseError(expiredGet.respond, {
      code: "INVALID_REQUEST",
      messageIncludes: `cron job not found: ${accountJob.id}`,
    });

    const runs = await invokeCron(
      "cron.runs",
      { id: accountJob.id },
      { context, client: runClient },
    );
    expect(runs.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ entries: [], total: 0 }),
      undefined,
    );

    const remove = await invokeCron(
      "cron.remove",
      { id: accountJob.id },
      { context, client: runClient },
    );
    expect(remove.respond).toHaveBeenCalledWith(true, { ok: true, removed: true }, undefined);
    expect(context.cron.remove).toHaveBeenCalledWith(accountJob.id, {
      commitGuard: expect.any(Function),
    });

    cronRunRecordsOverride.mockImplementationOnce(async () => {
      runClient.internal!.agentRuntimeIdentity!.cronSelfManagementContext!.expiresAtMs =
        Date.now() - 1;
      return [];
    });
    const expiredHistory = await invokeCron(
      "cron.runs",
      { id: accountJob.id },
      { context, client: runClient },
    );
    expectResponseError(expiredHistory.respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "Automation not found",
    });

    const update = await invokeCron(
      "cron.update",
      { id: accountJob.id, patch: { enabled: false } },
      { context, client: runClient },
    );
    expectResponseError(update.respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "Automation not found: cron-1",
    });

    const run = await invokeCron("cron.run", { id: accountJob.id }, { context, client: runClient });
    expectResponseError(run.respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "Automation not found: cron-1",
    });
    expect(context.cron.enqueueRun).not.toHaveBeenCalled();
  });

  it("keeps trusted scheduled authority operator-only", async () => {
    const trustedJob = createCronJob({
      owner: { agentId: "ops", sessionKey: "agent:ops:main", accountId: "default" },
      scheduledToolPolicy: { version: 1, mode: "trusted" },
    });
    const context = createCronContext(trustedJob);

    const agentList = await invokeCron(
      "cron.list",
      { compact: true },
      { context, client: callerClient("ops") },
    );
    expect(agentList.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ total: 0, jobs: [] }),
      undefined,
    );

    const operatorGet = await invokeCron("cron.get", { id: trustedJob.id }, { context });
    expectCronSuccess(operatorGet.respond);
  });

  it("scopes operator declaration convergence by normalized owner account", async () => {
    const owner = {
      agentId: "ops",
      sessionKey: "agent:ops:main",
      accountId: "work",
    };
    const { context, respond } = await invokeCronAdd(
      agentTurnCronParams({ declarationKey: "daily-report", owner }),
    );

    const options = requireRecord(context.cron.add.mock.calls[0]?.[1], "cron.add options");
    const matchesExisting = options.matchesExisting as ((job: CronJob) => boolean) | undefined;
    expect(
      matchesExisting?.(
        createCronJob({ declarationKey: "daily-report", owner: { ...owner, accountId: "WORK" } }),
      ),
    ).toBe(true);
    expect(
      matchesExisting?.(
        createCronJob({
          declarationKey: "daily-report",
          owner: { ...owner, accountId: "personal" },
        }),
      ),
    ).toBe(false);
    expect(
      matchesExisting?.(
        createCronJob({
          declarationKey: "daily-report",
          owner: { agentId: owner.agentId, sessionKey: owner.sessionKey },
        }),
      ),
    ).toBe(false);
    expectCronSuccess(respond);
  });

  it("returns the published declarative cron.add result shape", async () => {
    const context = createCronContext();
    const job = createCronJob({ declarationKey: "daily-report" });
    context.cron.add.mockImplementationOnce(
      async () => ({ ...job, created: false, updated: false, job }) as never,
    );
    const { respond } = await invokeCron(
      "cron.add",
      agentTurnCronParams({ declarationKey: "daily-report" }),
      { context },
    );

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        created: false,
        updated: false,
        job: expect.objectContaining({ id: "cron-1", declarationKey: "daily-report" }),
        deliveryPreview: { label: "not requested", detail: "not requested" },
      },
      undefined,
    );
  });

  it.each([
    { declarationKey: "x".repeat(201) },
    { displayName: "   " },
    { declarationKey: "daily", enabled: null },
  ])("rejects invalid authored cron.add fields %j", async (fields) => {
    const { context, respond } = await invokeCronAdd(agentTurnCronParams(fields));
    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, { code: "INVALID_REQUEST" });
  });

  it("projects declaration metadata and existing run and delivery state in compact lists", async () => {
    const job = createCronJob({
      declarationKey: "daily-report",
      displayName: "Daily report",
      owner: { agentId: "ops", sessionKey: "agent:ops:main" },
      state: {
        nextRunAtMs: 2000,
        lastRunAtMs: 1000,
        lastRunStatus: "error",
        lastError: "boom",
        lastDelivered: false,
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: "offline",
        lastFailureNotificationDelivered: true,
        lastFailureNotificationDeliveryStatus: "delivered",
      },
    });
    const context = createCronContext(job);
    const { respond } = await invokeCron("cron.list", { compact: true }, { context });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        jobs: [
          expect.objectContaining({
            declarationKey: "daily-report",
            displayName: "Daily report",
            owner: { agentId: "ops", sessionKey: "agent:ops:main" },
            nextRunAtMs: 2000,
            lastRunAtMs: 1000,
            lastRunStatus: "error",
            lastRunError: "boom",
            lastDelivered: false,
            lastDeliveryStatus: "not-delivered",
            lastDeliveryError: "offline",
            lastFailureNotificationDelivered: true,
            lastFailureNotificationDeliveryStatus: "delivered",
          }),
        ],
      }),
      undefined,
    );
  });

  it.each([
    { params: { agentId: "worker" }, messageIncludes: "outside caller scope" },
    {
      params: { agentId: "ops", sessionTarget: "session:agent:worker:telegram:direct:alice" },
      messageIncludes: "outside caller scope",
    },
    {
      params: { payload: { kind: "agentTurn", message: "hello" } },
      messageIncludes: "explicit payload.toolsAllow cap",
    },
  ])("rejects scoped cron.add params %j", async ({ params, messageIncludes }) => {
    const { context, respond } = await invokeCronAdd(agentTurnCronParams(params), {
      client: callerClient("ops"),
    });
    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes });
  });

  it.each([{ agentId: "ops", sessionKey: "agent:ops:discord:group:ops" }])(
    "rejects capless prompt edits without a proven owner account: %j",
    async (owner) => {
      const { context, respond } = await invokeCronUpdate(
        {
          id: "cron-1",
          patch: { payload: { kind: "agentTurn", message: "updated" } },
        },
        createCronJob({
          agentId: "ops",
          owner,
          payload: { kind: "agentTurn", message: "legacy" },
        }),
        { client: callerClient("ops", undefined, owner?.sessionKey) },
      );

      expect(context.cron.update).not.toHaveBeenCalled();
      expectResponseError(respond, {
        code: "INVALID_REQUEST",
        messageIncludes: "explicit payload.toolsAllow cap",
      });
    },
  );

  it("updates a legacy creator's prompt through the tool after Doctor without adopting permissions", async () => {
    const { storePath } = await makeStorePath();
    const sessionKey = "agent:ops:discord:work:direct:user-1";
    const legacy = createCronJob({
      enabled: false,
      agentId: "ops",
      owner: { agentId: "ops", sessionKey },
      payload: { kind: "agentTurn", message: "legacy" },
    });
    await saveCronStore(storePath, { version: 1, jobs: [legacy] });
    const cfg: OpenClawConfig = { agents: { entries: { ops: {} } } };
    const state = expectDefined(
      await loadLegacyCronRepairState({ cfg, storePath }),
      "legacy cron repair state",
    );
    const repair = await applyLegacyCronStoreRepair({ cfg, state });
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      cronEnabled: false,
      defaultAgentId: "ops",
      log: cronLogger,
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const context = createCronContext();
    context.cron.readJob.mockImplementation((id) => cron.readJob(id));
    context.cron.updateWithPrecondition.mockImplementation((...args) =>
      cron.updateWithPrecondition(...args),
    );
    let client = callerClient("ops", "work", sessionKey);
    const edit = async (payload: Record<string, unknown>) =>
      await updateCronJobFromAgentTool({
        id: legacy.id,
        patch: { payload },
        creatorToolAllowlist: [{ name: "read" }],
        gatewayOpts: {},
        callGateway: async (method, _opts, params) => {
          if (method !== "cron.get" && method !== "cron.update") {
            throw new Error(`unexpected method: ${method}`);
          }
          const { respond } = await invokeCron(method, requireRecord(params, "cron params"), {
            context,
            client,
          });
          const [ok, result, error] = expectDefined(respond.mock.calls[0], "cron response");
          if (!ok) {
            throw new Error(error.message);
          }
          return result;
        },
      });
    try {
      await expect(edit({ message: "updated" })).resolves.toMatchObject({
        owner: { ...legacy.owner, accountId: "work" },
        payload: { kind: "agentTurn", message: "updated" },
      });
      const updated = expectDefined((await loadCronStore(storePath)).jobs[0], "updated cron job");
      expect(updated.payload).toEqual({ kind: "agentTurn", message: "updated" });
      expect(updated.scheduledToolPolicy).toBeUndefined();
      expect(repair.changes).toContain(
        "Reconciled 1 cron job owner account from persisted creator identity; existing tool permissions were preserved.",
      );
      client = callerClient("ops", "personal", sessionKey);
      await expect(edit({ message: "foreign" })).rejects.toThrow("cron job not found: cron-1");
      expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual(updated.payload);
      client = callerClient("ops", "work", "agent:ops:discord:work:direct:user-2");
      await expect(edit({ message: "another session" })).rejects.toThrow(
        "explicit payload.toolsAllow cap",
      );
      expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual(updated.payload);
      client = callerClient("ops", "work", sessionKey);
      await expect(edit({ kind: "agentTurn", toolsAllow: ["read"] })).resolves.toMatchObject({
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: sessionKey,
          ownerAccountId: "work",
        },
      });
    } finally {
      cron.stop();
    }
  });

  it("rejects a blank cron.update display name", async () => {
    const { context, respond } = await invokeCronUpdate(
      { id: "cron-1", patch: { displayName: "   " } },
      createCronJob({ displayName: "Daily report" }),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes: "must not be blank" });
  });

  it.each([null])("rejects caller-scoped cron.update agentId %j", async (agentId) => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: { agentId },
      },
      createCronJob({ agentId: "ops" }),
      { client: callerClient("ops") },
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "agentId cannot be changed",
    });
  });

  it("rejects caller-scoped cron.update with a foreign sessionTarget", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: { sessionTarget: "session:agent:worker:telegram:direct:alice" },
      },
      createCronJob({ agentId: "ops" }),
      { client: callerClient("ops") },
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "session target outside caller scope",
    });
  });

  it("rejects execution-derived diagnostics in cron.update state patches", async () => {
    const { context, respond } = await invokeCronUpdate(
      {
        id: "cron-1",
        patch: {
          state: {
            lastDiagnostics: {
              summary: "forged",
              entries: [
                {
                  ts: 1,
                  source: "agent-run",
                  severity: "error",
                  message: "forged",
                },
              ],
            },
          },
        },
      },
      createCronJob(),
    );

    expect(context.cron.update).not.toHaveBeenCalled();
    expectResponseError(respond, { code: "INVALID_REQUEST" });
  });

  it.each([
    {
      name: "noncanonical disabled account key",
      config: {
        channels: {
          telegram: {
            accounts: {
              primary: { botToken: "telegram-token-primary" },
              "Team Ops": { botToken: "telegram-token-team", enabled: false },
            },
          },
        },
        plugins: pluginEntries("telegram"),
      },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:123456",
        accountId: "team-ops",
      },
      messageIncludes: "delivery.accountId",
    },
    {
      name: "disabled account through a channel alias",
      config: {
        channels: {
          msteams: { accounts: { work: { botToken: "teams-token-work", enabled: false } } },
        },
        plugins: pluginEntries("msteams"),
      } as OpenClawConfig,
      delivery: {
        mode: "announce",
        channel: "teams",
        to: "msteams:conversation",
        accountId: "work",
      },
      messageIncludes: "delivery.accountId",
    },
    {
      name: "mismatched underscored provider prefix",
      config: slackSynologyConfig(),
      delivery: { mode: "announce", channel: "slack", to: "synology_chat:123" },
      messageIncludes: "belongs to synology-chat, not slack",
    },
  ])("rejects cron.add delivery with $name", async ({ config, delivery, messageIncludes }) => {
    setRuntimeConfig(config);
    const { context, respond } = await invokeCronAdd(agentTurnCronParams({ delivery }));
    expect(context.cron.add).not.toHaveBeenCalled();
    expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes });
  });

  it.each([["delivery.to", { mode: "announce", channel: "telegram", to: "   " }]])(
    "rejects invalid cron.add %s (%j) before normalization",
    async (field, delivery) => {
      const { context, respond } = await invokeCronAdd(
        agentTurnCronParams({ name: "invalid delivery target", delivery }),
      );

      expect(context.cron.add).not.toHaveBeenCalled();
      expectResponseError(respond, {
        code: "INVALID_REQUEST",
        messageIncludes: `${field} must be a non-empty string`,
      });
    },
  );

  const failureAlertChannelError = {
    code: "INVALID_REQUEST",
    messageIncludes: "failureAlert.channel",
  } as const;

  function globalFailureAlertConfig(
    config: OpenClawConfig,
    failureAlert: NonNullable<OpenClawConfig["cron"]>["failureAlert"],
  ): OpenClawConfig {
    return { ...config, cron: { failureAlert } };
  }

  function createRoutedCronJob(
    channel: string,
    to: string,
    overrides: Pick<Partial<CronJob>, "failureAlert"> = {},
  ): CronJob {
    return createCronJob({ delivery: { mode: "announce", channel, to }, ...overrides });
  }

  function failureAlertUpdateAccepted(
    title: string,
    patch: Record<string, unknown>,
    currentJob: CronJob = createCronJob(),
    config: OpenClawConfig = telegramSlackConfig(),
  ): void {
    it(title, async () => {
      setRuntimeConfig(config);
      const { context, respond } = await invokeCronUpdate({ id: "cron-1", patch }, currentJob);
      expect(context.cron.update).toHaveBeenCalled();
      expectCronSuccess(respond);
    });
  }

  function failureAlertUpdateRejected(
    title: string,
    patch: Record<string, unknown>,
    currentJob: CronJob = createCronJob(),
    config: OpenClawConfig = telegramSlackConfig(),
  ): void {
    it(title, async () => {
      setRuntimeConfig(config);
      const { context, respond } = await invokeCronUpdate({ id: "cron-1", patch }, currentJob);
      expect(context.cron.update).not.toHaveBeenCalled();
      expectResponseError(respond, failureAlertChannelError);
    });
  }

  function failureAlertAddRejected(
    title: string,
    params: Record<string, unknown>,
    config: OpenClawConfig,
  ): void {
    it(title, async () => {
      setRuntimeConfig(config);
      const { context, respond } = await invokeCronAdd(params);
      expect(context.cron.add).not.toHaveBeenCalled();
      expectResponseError(respond, failureAlertChannelError);
    });
  }

  // An explicit job channel selects announce routing ahead of the global
  // webhook destination, so the canonical resolver must validate it.
  failureAlertUpdateRejected(
    "validates an explicit failureAlert channel ahead of a global webhook on cron.update",
    { failureAlert: { channel: "C0EXAMPLE01", to: "https://example.invalid/hook" } },
    createCronJob(),
    globalFailureAlertConfig(telegramSlackConfig(), { enabled: true, mode: "webhook" }),
  );

  failureAlertAddRejected(
    "validates an explicit failureAlert channel ahead of a global webhook on cron.add",
    agentTurnCronParams({
      name: "inherited webhook alert",
      failureAlert: { channel: "C0EXAMPLE01", to: "https://example.invalid/hook" },
    }),
    globalFailureAlertConfig(slackConfig(), { enabled: true, mode: "webhook" }),
  );

  // Route-backed alerts are already active by default, so a threshold-only edit
  // must not revalidate a legacy channel that the patch does not change.
  failureAlertUpdateAccepted(
    "does not revalidate a route-backed legacy channel for a threshold-only edit",
    { failureAlert: { after: 3 } },
    createRoutedCronJob("c0legacyinvalid", "123"),
  );

  it.each([
    {
      name: "provider-alias recipient",
      delivery: { mode: "announce", channel: "slack", to: "slack:C123" },
      alertTo: "tg:123",
    },
  ] as const)("lets a $name select its own alert channel", async ({ delivery, alertTo }) => {
    setRuntimeConfig(telegramSlackConfig());

    const { context, respond } = await invokeCronUpdate(
      { id: "cron-1", patch: { failureAlert: { to: alertTo } } },
      createCronJob({ delivery }),
    );

    expect(context.cron.update).toHaveBeenCalled();
    expectCronSuccess(respond);
  });

  failureAlertUpdateAccepted(
    "does not inherit a primary recipient for another explicit failure-alert channel",
    { failureAlert: { channel: "slack" } },
    createRoutedCronJob("telegram", "telegram:1"),
  );

  failureAlertAddRejected(
    "rejects an unconfigured inherited global failure-alert channel",
    agentTurnCronParams({
      delivery: { mode: "announce", channel: "telegram", to: "telegram:1" },
    }),
    globalFailureAlertConfig(telegramConfig(), {
      enabled: true,
      channel: "slack",
      to: "slack:C123",
    }),
  );

  it("accepts provider-prefixed announce targets when delivery.channel uses a channel alias", async () => {
    setRuntimeConfig(msteamsConfig());

    for (const to of ["teams:19:meeting_abc@thread.tacv2", "msteams:19:meeting_abc@thread.tacv2"]) {
      const { context, respond } = await invokeCronAdd(
        agentTurnCronParams({
          name: `aliased announce add ${to}`,
          delivery: {
            mode: "announce",
            channel: "teams",
            to,
          },
        }),
      );

      expect(context.cron.add).toHaveBeenCalled();
      expectCronSuccess(respond);
    }
  });

  it.each([
    {
      name: "bare target returns to last",
      config: telegramSlackConfig(),
      current: { mode: "announce", channel: "telegram", to: "123" },
      patch: { channel: null },
      messageIncludes: undefined,
    },
    {
      name: "explicitly disabled account",
      config: telegramDisabledAccountConfig(),
      current: { mode: "announce", channel: "telegram", to: "telegram:123456" },
      patch: { accountId: "retired" },
      messageIncludes: "delivery.accountId",
    },
  ] satisfies Array<{
    name: string;
    config: OpenClawConfig;
    current: CronDelivery;
    patch: Record<string, unknown>;
    messageIncludes?: string;
  }>)(
    "validates merged delivery when $name",
    async ({ config, current, patch, messageIncludes }) => {
      setRuntimeConfig(config);
      const { context, respond } = await invokeCronUpdateDelivery(
        patch,
        createCronJob({ delivery: current }),
      );
      if (messageIncludes) {
        expect(context.cron.update).not.toHaveBeenCalled();
        expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes });
      } else {
        expect(context.cron.update).toHaveBeenCalled();
        expectCronSuccess(respond);
      }
    },
  );

  it.each([
    {
      field: "delivery.completionDestination.to",
      patch: { completionDestination: { mode: "webhook", to: " " } },
      current: { mode: "announce" },
    },
  ] as const)(
    "rejects blank $field patches before normalization",
    async ({ field, patch, current }) => {
      const { context, respond } = await invokeCronUpdateDelivery(
        patch,
        createCronJob({ delivery: current }),
      );

      expect(context.cron.update).not.toHaveBeenCalled();
      expectResponseError(respond, {
        code: "INVALID_REQUEST",
        messageIncludes: `${field} must be a non-empty string`,
      });
    },
  );

  it.each(["add", "update"] as const)(
    "classifies cron.%s parse errors as INVALID_REQUEST (#74066)",
    async (method) => {
      const context = createCronContext(createCronJob());
      context.cron[method].mockRejectedValueOnce(
        method === "add"
          ? new TypeError("CronPattern: Expected 5 or 6 fields")
          : new RangeError("CronPattern: Value out of range (99)"),
      );
      const { respond } = await invokeCron(
        `cron.${method}`,
        method === "add"
          ? agentTurnCronParams({
              name: "bad-cron",
              schedule: { kind: "cron", expr: "not-a-cron-expr" },
              payload: { kind: "agentTurn", message: "ping" },
            })
          : { id: "cron-1", patch: { schedule: { kind: "cron", expr: "99 * * * *" } } },
        { context },
      );
      expectInvalidCronPatternError(respond);
    },
  );

  it("keeps malformed cron.run params classified as invalid params", async () => {
    const { context, respond } = await invokeCron(
      "cron.run",
      { id: 42 },
      { context: createCronContext() },
    );

    expect(context.cron.readJob).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.run params",
    });
    expect(requireRecord(respond.mock.calls[0]?.[2], "response error").details).toBeUndefined();
  });

  registerCronRunWaitTests({ handlers: cronHandlers, getRuntimeConfig });

  it("waits for a command job named for an administrator's own session", async () => {
    // Command jobs run as processes, so a target naming the caller's session never
    // queues them behind the caller's turn.
    const client = callerClient("main");
    const identity = client.internal!.agentRuntimeIdentity!;
    const authority = claimAgentRunDelegatedAuthority(identity.operationalRunInstance);
    identity.delegatedAuthority = { kind: "local", ...authority };
    const scope = createCronCreatorAuthorityRunScope(
      identity.operationalRunInstance.runId,
      { kind: "local" },
      { source: "control-ui-admin" },
    );
    const context = createCronContext(
      createCronJob({
        id: "cron-1",
        agentId: "main",
        sessionTarget: "session:main",
        payload: { kind: "command", argv: ["echo", "report"] },
        delivery: { mode: "none" },
      }),
    );
    try {
      await runWithCronCreatorAuthorityCapability(scope, () =>
        withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, async () => {
          identity.cronManagementGrant = bindCronManagementGrant(scope.runId)!.mint("cron.run");
          return await invokeCron(
            "cron.run",
            { id: "cron-1", waitTimeoutMs: 60_000 },
            { client, context },
          );
        }),
      );
      expect(context.cron.waitForManualRun).toHaveBeenCalledOnce();
    } finally {
      revokeCronCreatorAuthorityRunScope(scope);
      releaseAgentRunDelegatedAuthority(authority);
    }
  });

  it.each([
    { caller: "allowed", releasesOutcome: true },
    { caller: "revoked during the history read", releasesOutcome: false },
  ])("returns the finished run only to a caller still $caller", async ({ releasesOutcome }) => {
    const context = createCronContext(createCronJob({ id: "cron-1", agentId: "ops" }));
    context.cron.waitForManualRun.mockResolvedValueOnce(true);
    let authorized = true;
    cronRunRecordsOverride.mockImplementation(async () => {
      authorized = releasesOutcome;
      return [
        {
          id: "cron-1-history",
          jobId: "cron-1",
          runId: "run-1",
          agentId: "ops",
          createdAt: 1,
          startedAt: 1,
          endedAt: 1,
          status: "succeeded",
          detail: cronRunLogEntryToDetail(
            { jobId: "cron-1", runId: "run-1", action: "finished", status: "ok", ts: 1 },
            { storeKey: cronStoreKey(context.cronStorePath) },
          ),
        },
      ];
    });

    const { respond } = await invokeCron(
      "cron.run",
      { id: "cron-1", waitTimeoutMs: 60_000 },
      { context, client: callerClient("ops"), hasCurrentClientAuthority: () => authorized },
    );

    const ack = {
      ok: true,
      enqueued: true,
      runId: "run-1",
      processInstanceId: getGatewayProcessInstanceId(),
    };
    expect(respond).toHaveBeenCalledWith(
      true,
      releasesOutcome
        ? { ...ack, run: expect.objectContaining({ runId: "run-1", status: "ok" }) }
        : ack,
      undefined,
    );
  });

  it("rejects cron.run before enqueue when the Gateway process changed after preflight", async () => {
    const context = createCronContext(createCronJob({ id: "cron-1", agentId: "ops" }));

    const { respond } = await invokeCron(
      "cron.run",
      { id: "cron-1", expectedProcessInstanceId: "stale-process" },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.enqueueRun).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "Gateway process changed after preflight",
    });
  });

  it("rejects caller-scoped cron.runs all-scope history", async () => {
    const context = createCronContext(createCronJob({ id: "cron-1", agentId: "ops" }));

    const { respond } = await invokeCron(
      "cron.runs",
      { scope: "all" },
      { context, client: callerClient("ops") },
    );

    expect(context.cron.list).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "scope all is not allowed by caller scope",
    });
  });

  it.each(["job", "all"] as const)(
    "withholds %s history when client authority closes during the worker read",
    async (scope) => {
      const context = createCronContext(createCronJob({ id: "cron-1", agentId: "ops" }));
      const respond = vi.fn();
      let current = true;
      cronRunRecordsOverride.mockImplementation(async () => {
        current = false;
        return [];
      });

      await expect(
        invokeCron("cron.runs", scope === "job" ? { id: "cron-1" } : { scope }, {
          context,
          respond,
          hasCurrentClientAuthority: () => current,
        }),
      ).rejects.toThrow("Cron history authority closed");
      expect(respond).not.toHaveBeenCalled();
    },
  );

  it("rechecks the scoped job after reading history in the worker", async () => {
    const context = createCronContext(createCronJob({ id: "cron-1", agentId: "ops" }));
    cronRunRecordsOverride.mockImplementation(async () => {
      context.cron.getJob.mockReturnValue(undefined);
      return [];
    });

    const { respond } = await invokeCron(
      "cron.runs",
      { id: "cron-1" },
      {
        context,
        client: callerClient("ops"),
      },
    );
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "Automation not found",
    });
  });

  it("retains full cron job discovery for all-scope history", async () => {
    const context = createCronContext(createCronJob({ id: "cron-1" }));

    const { respond } = await invokeCron("cron.runs", { scope: "all" }, { context });

    expect(context.cron.list).toHaveBeenCalledExactlyOnceWith({ includeDisabled: true });
    expect(context.cron.readJob).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ entries: expect.any(Array) }),
      undefined,
    );
  });

  it("does not widen a whitespace-only cron.runs selector to all history", async () => {
    const context = createCronContext();

    const { respond } = await invokeCron("cron.runs", { id: "   " }, { context });

    expect(context.cron.list).not.toHaveBeenCalled();
    expect(context.cron.readJob).not.toHaveBeenCalled();
    expectResponseError(respond, {
      code: "INVALID_REQUEST",
      messageIncludes: "invalid cron.runs params: missing id",
    });
  });

  it("re-throws non-parse errors from cron.add instead of masking as INVALID_REQUEST", async () => {
    const context = createCronContext();
    context.cron.add.mockRejectedValueOnce(new Error("DB write failed"));
    const respond = vi.fn();
    await expect(
      invokeCron(
        "cron.add",
        agentTurnCronParams({
          name: "db-fail",
          payload: { kind: "agentTurn", message: "ping" },
        }),
        { context, respond },
      ),
    ).rejects.toThrow("DB write failed");
    expect(respond).not.toHaveBeenCalled();
  });

  describe("wake", () => {
    beforeEach(() => {
      setRuntimeConfig({
        agents: {
          entries: { main: {}, ops: {}, "agent-123": {}, "agent-456": {} },
        },
      });
    });

    it.each([
      {
        name: "matching explicit agent",
        params: {
          mode: "now",
          text: "ping",
          sessionKey: "agent:agent-456:discord:thread-xyz",
          agentId: "agent-456",
        },
        expected: {
          mode: "now",
          text: "ping",
          sessionKey: "agent:agent-456:discord:thread-xyz",
          agentId: "agent-456",
        },
      },
      {
        name: "blank session key",
        params: { mode: "now", text: "ping", sessionKey: "   " },
        expected: { mode: "now", text: "ping" },
      },
    ])("resolves wake target for $name", async ({ params, expected }) => {
      const { context, respond } = await invokeWake(params);
      const expectedWake = {
        ...expected,
        commitGuard: expect.any(Function),
        createIfMissing: true,
      };
      expect(context.cron.wake).toHaveBeenCalledWith(expectedWake);
      expect(context.cron.prepareWake).toHaveBeenCalledOnce();
      expect(context.cron.prepareWake.mock.invocationCallOrder[0]).toBeLessThan(
        context.cron.wake.mock.invocationCallOrder[0]!,
      );
      expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    });

    it.each([
      { name: "non-string sessionKey at schema", sessionKey: 42 },
      {
        name: "subagent sessionKey targets before enqueueing",
        sessionKey: "agent:main:subagent:worker",
      },
    ])("rejects $name", async ({ sessionKey }) => {
      const { context, respond } = await invokeWake({
        mode: "now",
        text: "ping",
        sessionKey,
      });
      expect(context.cron.wake).not.toHaveBeenCalled();
      expect(context.cron.prepareWake).not.toHaveBeenCalled();
      expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes: "sessionKey" });
    });

    it("rejects a contradictory explicit agentId + agent-prefixed sessionKey pair", async () => {
      // The cron target resolver treats agentId as authoritative; a
      // contradictory pair would silently wake a lane the caller never named.
      const { context, respond } = await invokeWake({
        mode: "now",
        text: "ping",
        sessionKey: "agent:agent-456:discord:thread-xyz",
        agentId: "ops",
      });
      expect(context.cron.wake).not.toHaveBeenCalled();
      expectResponseError(respond, {
        code: "INVALID_REQUEST",
        messageIncludes: "does not match session key agent",
      });
    });

    it.each([
      {
        name: "agentId",
        params: { agentId: "agent-456" },
        message: "wake agentId outside caller scope",
      },
      {
        name: "sessionKey",
        params: { sessionKey: "agent:agent-456:discord:thread-xyz" },
        message: "does not match session key agent",
      },
    ])("rejects a cross-agent $name for agent-runtime callers", async ({ params, message }) => {
      const { context, respond } = await invokeWake(
        { mode: "now", text: "ping", ...params },
        callerClient("agent-123"),
      );
      expect(context.cron.wake).not.toHaveBeenCalled();
      expectResponseError(respond, { code: "INVALID_REQUEST", messageIncludes: message });
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
