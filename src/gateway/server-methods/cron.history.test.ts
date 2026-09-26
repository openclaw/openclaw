import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import type { CronHistoryResult } from "../../../packages/gateway-protocol/src/index.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { cronRunLogEntryToDetail } from "../../cron/run-history-detail.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createTaskFixture } from "../../tasks/task-registry.test-support.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  forbidMainThreadSql,
  observeMainThreadSql,
} from "../../test-utils/main-thread-sql-spies.test-support.js";
import { seedTaskRegistryRowsForTests } from "../../test-utils/task-registry-sqlite.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { cronHandlers } from "./cron.js";
import { withHistoryState } from "./task-history.test-support.js";
import { identifiedClient, runTaskHandler } from "./tasks.test-helpers.js";
import type { GatewayClient, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

async function withCronTranscript(
  run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  await withHistoryState(async () => {
    const fixture = await setup();
    try {
      await run(fixture);
    } finally {
      fixture.cron.stop();
    }
  });
}

async function setup() {
  const profile = ensureProfileForEmail("cron-reader@example.test");
  const baseKey = "agent:main:cron:history-job";
  const oldScope = { agentId: "main", sessionKey: baseKey, sessionId: "old-cron" };
  await upsertSessionEntryCore(oldScope, {
    sessionId: oldScope.sessionId,
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: profile.id },
  });
  for (const content of ["Old first", "Old second", "Old last"]) {
    await appendTranscriptMessage(oldScope, { message: { role: "assistant", content } });
  }
  const alias = `${baseKey}:run:${oldScope.sessionId}`;
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: alias },
    {
      sessionId: oldScope.sessionId,
      updatedAt: 1,
    },
  );
  await deleteSessionEntryLifecycle({
    agentId: "main",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    target: { canonicalKey: alias, storeKeys: [alias] },
    archiveTranscript: false,
    expectedSessionId: oldScope.sessionId,
  });
  const latest = { ...oldScope, sessionId: "new-cron" };
  await upsertSessionEntryCore(latest, {
    sessionId: latest.sessionId,
    updatedAt: 2,
    visibility: "shared",
  });
  await appendTranscriptMessage(latest, {
    message: { role: "assistant", content: "Latest run only" },
  });
  const storePath = path.join(
    expectDefined(process.env.OPENCLAW_STATE_DIR, "isolated state"),
    "cron",
    "jobs.json",
  );
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath,
    defaultAgentId: "main",
    cronEnabled: false,
    log: createNoopLogger(),
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });
  const created = await cron.add(
    {
      name: "History job",
      agentId: "main",
      owner: { agentId: "main", sessionKey: baseKey },
      schedule: { kind: "every", everyMs: 60_000 },
      enabled: false,
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "fixture" },
      delivery: { mode: "none" },
    },
    { scheduledToolPolicy: { version: 1, mode: "trusted" } },
  );
  const job = "job" in created ? created.job : created;
  const task = createTaskFixture("cron", {
    taskKind: "automation_run",
    sourceId: job.id,
    runId: "internal-old-run",
    requesterSessionKey: "",
    ownerKey: "",
    scopeKind: "system",
    childSessionKey: alias,
    agentId: "main",
    task: "History job",
    status: "succeeded",
    detail: cronRunLogEntryToDetail(
      {
        jobId: job.id,
        action: "finished",
        ts: 20,
        runAtMs: 10,
        runId: "public-old-run",
        sessionKey: alias,
        sessionId: oldScope.sessionId,
        status: "ok",
      },
      { storeKey: cronStoreKey(storePath) },
    ),
  });
  const context = await createHistoryReadContext({ cron, cronStorePath: storePath });
  const query = async (
    params: Record<string, unknown>,
    options: Partial<
      Pick<GatewayRequestHandlerOptions, "client" | "hasCurrentClientAuthority">
    > = {},
    readContext = context,
  ) => {
    const respond = vi.fn<RespondFn>();
    await expectDefined(
      cronHandlers["cron.history"],
      "registered cron.history",
    )({
      req: { type: "req", id: "history", method: "cron.history", params },
      params,
      client: null,
      context: readContext,
      respond,
      isWebchatConnect: () => false,
      ...options,
    });
    return { respond, payload: respond.mock.calls[0]?.[1] as CronHistoryResult | undefined };
  };
  return { cron, storePath, baseKey, alias, oldScope, latest, job, task, context, query, profile };
}

it("pages the exact archived Cron generation for a limited caller without main-thread SQL", async () => {
  await withCronTranscript(async ({ job, query, cron, storePath, profile }) => {
    const cfg: OpenClawConfig = {
      gateway: {
        roles: {
          default: "limited",
          definitions: {
            limited: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
          },
        },
      },
    };
    const context = await createHistoryReadContext({
      cron,
      cronStorePath: storePath,
      getRuntimeConfig: () => cfg,
    });
    const options = { client: identifiedClient(["operator.read"], profile.id) };
    prepareGatewayRecipientProfile(options.client);
    expect(operatorSessionCap(options.client, cfg)).toBe("none");
    const observation = observeMainThreadSql();
    const forbidden = forbidMainThreadSql("Cron history performed main-thread SQL");
    try {
      const first = await query(
        { id: job.id, runId: "public-old-run", limit: 2 },
        options,
        context,
      );
      const failures: string[] = [];
      for (const call of observation.calls) {
        for (const result of call.mock.results) {
          if (result.type === "throw" && result.value instanceof Error) {
            failures.push(result.value.stack ?? result.value.message);
          }
        }
      }
      expect(observation.count(), failures.join("\n")).toBe(0);
      expect(first.respond.mock.calls[0]?.[0], JSON.stringify(first.respond.mock.calls)).toBe(true);
      expect(first.payload?.messages).toMatchObject([
        { content: "Old second" },
        { content: "Old last" },
      ]);
      const next = await query(
        {
          id: job.id,
          runAtMs: 10,
          limit: 2,
          cursor: expectDefined(first.payload?.nextCursor, "older page cursor"),
        },
        options,
        context,
      );
      expect(next.payload?.messages).toMatchObject([{ content: "Old first" }]);
      expect(next.payload?.nextCursor).toBeUndefined();
      const invalid = await query(
        {
          id: job.id,
          runId: "public-old-run",
          sessionKey: "agent:main:private",
        },
        options,
        context,
      );
      expect(invalid.respond.mock.calls[0]).toMatchObject([
        false,
        undefined,
        { code: "INVALID_REQUEST" },
      ]);
      for (const [method, params, expected] of [
        ["cron.get", { id: job.id }, { id: job.id }],
        ["cron.list", { includeDisabled: true }, { jobs: [{ id: job.id }] }],
        ["cron.runs", { id: job.id }, { entries: [], total: 0 }],
        ["cron.runs", { scope: "all" }, { entries: [], total: 0 }],
      ] as const) {
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          cronHandlers[method],
          method,
        )({
          req: { type: "req", id: method, method, params },
          params,
          client: options.client,
          context,
          respond,
          isWebchatConnect: () => false,
        });
        expect(respond.mock.calls[0]?.[0], method).toBe(true);
        expect(respond.mock.calls[0]?.[1], method).toMatchObject(expected);
      }
      observation.expectIdle();
    } finally {
      forbidden.restore();
      observation.restore();
    }
  });
});

it("preserves shared custom-session conversation history across recorded runs", async () => {
  await withCronTranscript(async ({ cron, job, task, oldScope, context, query }) => {
    await cron.update(job.id, { sessionTarget: `session:${oldScope.sessionKey}` });
    await upsertSessionEntryCore(oldScope, { sessionId: oldScope.sessionId, updatedAt: 3 });
    await appendTranscriptMessage(oldScope, {
      message: { role: "assistant", content: "A later run in this same conversation" },
    });
    const detail = expectDefined(task.detail, "record detail");
    if (typeof detail !== "object" || Array.isArray(detail)) {
      throw new Error("Expected detail object");
    }
    seedTaskRegistryRowsForTests([
      task,
      {
        ...task,
        taskId: "later-shared-run",
        runId: "internal-later-run",
        detail: { ...detail, runId: "public-later-run", runAtMs: 30 },
      },
    ]);
    const prior = await runTaskHandler("tasks.history", { taskId: task.taskId }, {}, null, context);
    const current = await query({ id: job.id, runId: "public-old-run" });
    expect(prior.calls[0]?.[0]).toBe(true);
    expect(current.respond.mock.calls[0]?.[0]).toBe(true);
    expect(current.payload?.messages).toEqual(prior.payload?.messages);
    expect(current.payload?.messages).toMatchObject([
      { content: "Old first" },
      { content: "Old second" },
      { content: "Old last" },
      { content: "A later run in this same conversation" },
    ]);
  });
});

it("refuses ambiguous timestamps and cursors moved to another recorded run", async () => {
  await withCronTranscript(async ({ job, task, query }) => {
    const first = await query({ id: job.id, runId: "public-old-run", limit: 1 });
    const cursor = expectDefined(first.payload?.nextCursor, "bound cursor");
    const detail = expectDefined(task.detail, "record detail");
    if (typeof detail !== "object" || Array.isArray(detail)) {
      throw new Error("Expected detail object");
    }
    seedTaskRegistryRowsForTests([
      task,
      {
        ...task,
        taskId: "second-record",
        runId: "internal-second-run",
        detail: { ...detail, runId: "public-second-run" },
      },
    ]);
    expect((await query({ id: job.id, runAtMs: 10 })).respond.mock.calls[0]?.[0]).toBe(false);
    expect(
      (await query({ id: job.id, runId: "public-second-run", cursor })).respond.mock.calls[0]?.[0],
    ).toBe(false);
  });
});

it.each(["sharing", "binding", "client", "grant"] as const)(
  "rechecks %s before publishing a retained Cron transcript",
  async (change) => {
    await withCronTranscript(async ({ cron, storePath, baseKey, latest, job, task, query }) => {
      let current = true;
      const instance = createOperationalRunInstanceRef("cron-history-run");
      const client: GatewayClient =
        change === "grant"
          ? {
              connect: {} as GatewayClient["connect"],
              internal: {
                agentRuntimeIdentity: {
                  kind: "agentRuntime",
                  agentId: "main",
                  sessionKey: "agent:main:cron:reader:run:one",
                  operationalRunInstance: instance,
                  delegatedAuthority: {
                    kind: "local",
                    operationalRunInstance: instance,
                    lifecycleGeneration: "fixture",
                    claimId: "fixture",
                  },
                  cronSelfManagementContext: { jobId: job.id, expiresAtMs: Date.now() + 60_000 },
                },
              },
            }
          : identifiedClient(["operator.read"], "retained-viewer");
      const onRead = vi.fn(async () => {
        if (change === "sharing") {
          await patchSessionEntryCore({ agentId: "main", sessionKey: baseKey }, () => ({
            visibility: "draft",
          }));
        } else if (change === "binding") {
          const detail = expectDefined(task.detail, "record detail");
          if (typeof detail !== "object" || Array.isArray(detail)) {
            throw new Error("Expected detail object");
          }
          seedTaskRegistryRowsForTests([
            { ...task, detail: { ...detail, sessionId: latest.sessionId } },
          ]);
        } else if (change === "client") {
          current = false;
        } else {
          client.internal!.agentRuntimeIdentity!.cronSelfManagementContext!.expiresAtMs =
            Date.now() - 1;
        }
        return undefined;
      });
      const context = await createHistoryReadContext({
        cron,
        cronStorePath: storePath,
        readChatStartupProjection: onRead,
      });
      const result = await query(
        { id: job.id, runId: "public-old-run" },
        {
          client,
          hasCurrentClientAuthority: () => current,
        },
        context,
      );
      expect(onRead).toHaveBeenCalled();
      expect(result.respond.mock.calls).toHaveLength(1);
      expect(result.respond.mock.calls[0]?.[0]).toBe(false);
      expect(result.payload?.messages).toBeUndefined();
    });
  },
);
