import { createHash } from "node:crypto";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { CronHistoryResult } from "../../../packages/gateway-protocol/src/index.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronService } from "../../cron/service.js";
import { cronStoreKey } from "../../cron/store/key.js";
import * as cronReadOnly from "../../cron/store/read-only.js";
import {
  applyCronRunHistoryMaintenanceInDatabase,
  planCronRunHistoryMaintenance,
  readCronRunRecordsInDatabase,
} from "../../cron/store/run-history.kernel.js";
import type { CronRunHistoryWrite } from "../../cron/store/run-history.types.js";
import { prepareCronRunReceiptWriteSchema } from "../../cron/store/run-receipt-write-admission.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolvePluginMetadataSnapshotAsync } from "../../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  forbidMainThreadSql,
  observeMainThreadSql,
} from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import {
  callCron as invokeCron,
  createReadService,
  createHistoryJob,
  historyRecord,
  persistRuns as persistHistory,
} from "./cron-read.test-support.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const limitedConfig = (): OpenClawConfig => ({
  gateway: {
    roles: {
      default: "limited",
      definitions: {
        limited: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
      },
    },
  },
});

async function callCron(
  context: GatewayRequestHandlerOptions["context"],
  method: string,
  params: Record<string, unknown>,
  options: Partial<Pick<GatewayRequestHandlerOptions, "client" | "hasCurrentClientAuthority">> = {},
) {
  const respond = await invokeCron(context, method, params, options);
  const calls = respond.mock.calls;
  return {
    respond,
    calls,
    ok: calls[0]?.[0],
    payload: calls[0]?.[1] as CronHistoryResult | undefined,
  };
}

async function limitedReader(
  cron: CronService,
  storePath: string,
  user: string,
  prepareMetadata = false,
) {
  const cfg = limitedConfig();
  const context = await createHistoryReadContext({
    cron,
    cronStorePath: storePath,
    getRuntimeConfig: () => cfg,
  });
  if (prepareMetadata) {
    await resolvePluginMetadataSnapshotAsync({ config: cfg });
  }
  const client = sharingPolicyClient({ scopes: ["operator.read"], user });
  prepareGatewayRecipientProfile(client);
  expect(operatorSessionCap(client, cfg)).toBe("none");
  return { cfg, context, client };
}

function expectMessages(page: { payload?: CronHistoryResult }, ...contents: string[]) {
  expect(page.payload?.messages).toMatchObject(contents.map((content) => ({ content })));
}

async function withCronTranscript(
  run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  let registry: ReturnType<typeof captureActivePluginRegistrySnapshot> | undefined;
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      registry = captureActivePluginRegistrySnapshot();
      setActivePluginRegistry(createEmptyPluginRegistry());
      try {
        const fixture = await setup();
        try {
          await run(fixture);
        } finally {
          fixture.cron.stop();
        }
      } finally {
        await disposeSessionReadContexts();
      }
    });
  } finally {
    if (registry) {
      restoreActivePluginRegistrySnapshot(registry);
    }
  }
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
  const cron = createReadService({
    storePath,
    defaultAgentId: "main",
    cronEnabled: false,
    enqueueSystemEvent() {},
    requestHeartbeat() {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });
  const created = await cron.add(createHistoryJob("main", baseKey, "History job"), {
    scheduledToolPolicy: { version: 1, mode: "trusted" },
  });
  const job = "job" in created ? created.job : created;
  const record = historyRecord(
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
    storePath,
    "main",
    "internal-old-run",
  );
  const detail = expectDefined(record.detail, "record detail");
  if (typeof detail !== "object" || Array.isArray(detail)) {
    throw new Error("Expected detail object");
  }
  const withDetail = (patch: typeof detail, fields: Partial<CronRunHistoryWrite> = {}) => ({
    ...record,
    ...fields,
    detail: { ...detail, ...patch },
  });
  persistHistory([record]);
  const context = await createHistoryReadContext({ cron, cronStorePath: storePath });
  const query = async (
    params: Record<string, unknown>,
    options: Partial<
      Pick<GatewayRequestHandlerOptions, "client" | "hasCurrentClientAuthority">
    > = {},
    readContext = context,
  ) => {
    return callCron(readContext, "cron.history", { id: job.id, ...params }, options);
  };
  return {
    cron,
    storePath,
    baseKey,
    alias,
    oldScope,
    latest,
    job,
    record,
    detail,
    withDetail,
    query,
    profile,
  };
}

it("pages the exact archived Cron generation for a limited caller without main-thread SQL", () =>
  withCronTranscript(
    async ({ job, query, cron, storePath, profile, record, withDetail, alias, oldScope }) => {
      const recoveryMarker = "cron-recovery-only:";
      persistHistory(
        Array.from({ length: 32 }, (_, index) =>
          withDetail(
            {
              runId: index === 0 ? "public-old-run" : `public-payload-${index}`,
              runAtMs: index === 0 ? 10 : 30 + index,
              scriptStateChanged: true,
              scriptState: `${recoveryMarker}${index}:` + "x".repeat(64 * 1024),
            },
            {
              runId: index === 0 ? record.runId : `internal-payload-${index}`,
              startedAt: index === 0 ? record.startedAt : 30 + index,
              endedAt: index === 0 ? record.endedAt : 40 + index,
            },
          ),
        ),
      );
      const stored = runOpenClawStateWriteTransaction(
        ({ db }) => readCronRunRecordsInDatabase(db, job.id, record.runId)[0],
      );
      // Existing clients retain cursors across upgrades; the ordered identity bytes stay stable.
      const expectedBinding = createHash("sha256")
        .update(
          JSON.stringify([
            cronStoreKey(storePath),
            expectDefined(stored, "stored run").id,
            record.runId,
            job.id,
            "public-old-run",
            10,
            alias,
            oldScope.sessionId,
            "main",
          ]),
        )
        .digest("base64url");
      const { context, client } = await limitedReader(cron, storePath, profile.id, true);
      const options = { client };
      const read = (params: Record<string, unknown>) => query(params, options, context);
      const observation = observeMainThreadSql();
      const forbidden = forbidMainThreadSql("Cron history performed main-thread SQL");
      const workerRuns = vi.spyOn(WorkerTaskPool.prototype, "run");
      try {
        const first = await read({ id: job.id, runId: "public-old-run", limit: 2 });
        observation.expectIdle();
        expect(first.ok, JSON.stringify(first.calls)).toBe(true);
        expectMessages(first, "Old second", "Old last");
        const firstCursor = expectDefined(first.payload?.nextCursor, "bound cursor");
        expect(JSON.parse(Buffer.from(firstCursor, "base64url").toString("utf8"))).toEqual([
          expectedBinding,
          2,
        ]);
        const historyReplies = await Promise.all(
          workerRuns.mock.calls.flatMap(([input], index) =>
            asOptionalRecord(asOptionalRecord(input)?.history)?.jobId === job.id
              ? [workerRuns.mock.results[index]?.value]
              : [],
          ),
        );
        const serializedReplies = historyReplies.map((reply) => JSON.stringify(reply));
        expect(historyReplies.length).toBeGreaterThanOrEqual(2);
        for (const reply of serializedReplies) {
          expect(reply.includes(recoveryMarker)).toBe(false);
          expect(Buffer.byteLength(reply)).toBeLessThan(1024);
        }
        const next = await read({
          runAtMs: 10,
          limit: 2,
          cursor: firstCursor,
        });
        expectMessages(next, "Old first");
        expect(next.payload?.nextCursor).toBeUndefined();
        const invalid = await read({
          runId: "public-old-run",
          sessionKey: "agent:main:private",
        });
        expect(invalid.calls[0]).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
        for (const [method, params, expected] of [
          ["cron.get", { id: job.id }, { id: job.id }],
          ["cron.list", { includeDisabled: true }, { jobs: [{ id: job.id }] }],
          ["cron.runs", { id: job.id }, { entries: [], total: 0 }],
          ["cron.runs", { scope: "all" }, { entries: [], total: 0 }],
        ] as const) {
          const { respond } = await callCron(context, method, params, options);
          expect(respond.mock.calls[0]?.[0], method).toBe(true);
          expect(respond.mock.calls[0]?.[1], method).toMatchObject(expected);
        }
        observation.expectIdle();
      } finally {
        workerRuns.mockRestore();
        forbidden.restore();
        observation.restore();
      }
    },
  ));

it("preserves shared custom-session conversation history across recorded runs", () =>
  withCronTranscript(async ({ cron, job, record, withDetail, oldScope, query }) => {
    await cron.update(job.id, { sessionTarget: `session:${oldScope.sessionKey}` });
    await upsertSessionEntryCore(oldScope, { sessionId: oldScope.sessionId, updatedAt: 3 });
    await appendTranscriptMessage(oldScope, {
      message: { role: "assistant", content: "A later run in this same conversation" },
    });
    persistHistory([
      record,
      withDetail({ runId: "public-later-run", runAtMs: 30 }, { runId: "internal-later-run" }),
    ]);
    const current = await query({ runId: "public-old-run" });
    expect(current.ok).toBe(true);
    expectMessages(
      current,
      "Old first",
      "Old second",
      "Old last",
      "A later run in this same conversation",
    );
  }));

it("does not disclose hidden session keys in cron.history errors", () =>
  withCronTranscript(async ({ cron, storePath, baseKey, alias, query }) => {
    await patchSessionEntryCore({ agentId: "main", sessionKey: baseKey }, () => ({
      visibility: "draft",
    }));
    const otherProfile = ensureProfileForEmail("cron-other-reader@example.test");
    const { context, client } = await limitedReader(cron, storePath, otherProfile.id);
    for (const selector of [
      { runId: "public-old-run" },
      { runAtMs: 10 },
      { runId: "missing-run" },
      { runId: "public-old-run", cursor: "invalid" },
    ]) {
      const { respond } = await query({ ...selector }, { client }, context);
      expect(respond.mock.calls).toEqual([
        [
          false,
          undefined,
          {
            code: "UNAVAILABLE",
            message: "The recorded cron transcript is unavailable. Refresh the run and try again.",
          },
        ],
      ]);
      expect(JSON.stringify(respond.mock.calls)).not.toContain(baseKey);
      expect(JSON.stringify(respond.mock.calls)).not.toContain(alias);
    }
  }));

it("removes runs and totals when detail hydration reveals a hidden session", () =>
  withCronTranscript(async ({ cron, storePath, baseKey, job, withDetail, profile }) => {
    const hiddenKey = "agent:main:hidden-cron-run";
    const hiddenProfile = ensureProfileForEmail("hidden-cron-owner@example.test");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: hiddenKey },
      {
        sessionId: "hidden-cron-session",
        updatedAt: 3,
        visibility: "draft",
        createdActor: { type: "human", source: "profile", id: hiddenProfile.id },
      },
    );
    persistHistory([withDetail({ sessionKey: baseKey }, { sessionKey: baseKey })]);
    const { context, client } = await limitedReader(cron, storePath, profile.id);
    const queryRuns = async () => {
      return (await callCron(context, "cron.runs", { id: job.id }, { client })).calls;
    };
    expect(await queryRuns()).toMatchObject([
      [true, { entries: [{ runId: "public-old-run", sessionKey: baseKey }], total: 1 }, undefined],
    ]);
    const readDetails = cronReadOnly.readCronRunHistoryRecords;
    const detailRead = vi
      .spyOn(cronReadOnly, "readCronRunHistoryRecords")
      .mockImplementationOnce(async (...args) => {
        persistHistory([withDetail({ sessionKey: hiddenKey }, { sessionKey: hiddenKey })]);
        return readDetails(...args);
      });
    try {
      const response = await queryRuns();
      expect(response).toMatchObject([[true, { entries: [], total: 0 }, undefined]]);
      expect(JSON.stringify(response)).not.toContain(hiddenKey);
    } finally {
      detailRead.mockRestore();
    }
  }));

it("refuses ambiguous timestamps and cursors moved to another recorded run", () =>
  withCronTranscript(async ({ record, detail, withDetail, query }) => {
    const first = await query({ runId: "public-old-run", limit: 1 });
    const cursor = expectDefined(first.payload?.nextCursor, "bound cursor");
    persistHistory([
      record,
      withDetail({ runId: "public-second-run" }, { runId: "internal-second-run" }),
    ]);
    for (const [selector, ok] of [
      [{ runAtMs: 10 }, false],
      [{ runId: "public-second-run", cursor }, false],
      [{ runId: "public-old-run", runAtMs: 11 }, false],
      [{ runId: "public-old-run", runAtMs: 10 }, true],
    ] as const) {
      expect((await query(selector)).ok).toBe(ok);
    }
    // An incomplete duplicate must not make an otherwise ambiguous public run selectable.
    const { sessionId: _sessionId, ...incompleteDetail } = detail;
    persistHistory([
      {
        ...record,
        runId: "internal-incomplete-run",
        detail: incompleteDetail,
      },
    ]);
    expect((await query({ runId: "public-old-run" })).ok).toBe(false);
  }));

it.each(["sharing", "binding", "retention", "transcript owner"] as const)(
  "rechecks %s before publishing a retained Cron transcript",
  (change) =>
    withCronTranscript(
      async ({ cron, storePath, baseKey, oldScope, latest, record, withDetail, query }) => {
        let storageChanged = false;
        const unrelatedKey = "agent:main:unrelated";
        if (change === "transcript owner") {
          await upsertSessionEntryCore(
            { agentId: oldScope.agentId, sessionKey: unrelatedKey },
            { sessionId: "unrelated-current", updatedAt: 3, visibility: "shared" },
          );
        }
        const client = sharingPolicyClient({ scopes: ["operator.read"], user: "retained-viewer" });
        const onRead = vi.fn(async () => {
          if (change === "sharing") {
            await patchSessionEntryCore({ agentId: "main", sessionKey: baseKey }, () => ({
              visibility: "draft",
            }));
          } else if (change === "binding") {
            persistHistory([withDetail({ sessionId: latest.sessionId })]);
          } else if (change === "retention") {
            storageChanged =
              runOpenClawStateWriteTransaction(({ db }) => {
                const now = record.endedAt + 7 * 24 * 60 * 60_000;
                const plan = planCronRunHistoryMaintenance(
                  readCronRunRecordsInDatabase(db),
                  now,
                  new Set(),
                );
                return applyCronRunHistoryMaintenanceInDatabase(
                  db,
                  plan,
                  now,
                  prepareCronRunReceiptWriteSchema(db),
                ).pruned;
              }) === 1;
          } else if (change === "transcript owner") {
            storageChanged =
              runOpenClawAgentWriteTransaction(
                ({ db }) =>
                  db
                    .prepare("UPDATE session_windows SET session_key = ? WHERE session_id = ?")
                    .run(unrelatedKey, oldScope.sessionId).changes,
                { agentId: oldScope.agentId },
              ) === 1;
          }
          return undefined;
        });
        const context = await createHistoryReadContext({
          cron,
          cronStorePath: storePath,
          readChatStartupProjection: onRead,
        });
        const result = await query({ runId: "public-old-run" }, { client }, context);
        expect(onRead).toHaveBeenCalled();
        if (change === "retention" || change === "transcript owner") {
          expect(storageChanged).toBe(true);
        }
        expect(result.calls).toHaveLength(1);
        expect(result.ok).toBe(false);
        expect(result.payload?.messages).toBeUndefined();
        expect(JSON.stringify(result.calls)).not.toContain(baseKey);
        expect(JSON.stringify(result.calls)).not.toContain(unrelatedKey);
      },
    ),
);
