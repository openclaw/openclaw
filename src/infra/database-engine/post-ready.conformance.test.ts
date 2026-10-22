import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { loadPersistedPluginModelCatalogs } from "../../agents/plugin-model-catalog-execution.js";
import * as catalogs from "../../agents/plugin-model-catalog.js";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import { createSubagentStoreRunFixture } from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { readAllSubagentRunsInWorker } from "../../agents/subagents/registry/subagent-registry.store.read.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import * as configIO from "../../config/io.factory.js";
import { buildConversationIdentity } from "../../config/sessions/conversation-identity.js";
import {
  listConversations,
  readConversation,
  registerConversationAddresses as registerAddresses,
} from "../../config/sessions/conversation-registry.js";
import { appendSessionTranscriptReport } from "../../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  readSessionPendingInput,
  readSessionSubmittedInput,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionTranscriptJsonlBytesInDatabase } from "../../config/sessions/session-accessor.sqlite-maintenance-store.js";
import { readCurrentProjectionSnapshot } from "../../config/sessions/session-accessor.sqlite-projection-read.js";
import { readVisibleTranscriptStats } from "../../config/sessions/session-accessor.sqlite-reset-window.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readTranscriptStatsFromDatabase } from "../../config/sessions/session-accessor.sqlite-transcript-stats.js";
import { replaceSqliteTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { readSessionPendingInputContext } from "../../config/sessions/session-pending-input-history.js";
import { discardSessionPendingInput } from "../../config/sessions/session-pending-input-withdrawal.js";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import { CronService } from "../../cron/service.js";
import { loadCronJobsStore, saveCronJobsStore } from "../../cron/store.js";
import { makeStore } from "../../cron/store.test-support.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import {
  withPluginLifecycleLeaseAsync,
  type PluginMetadataLeaseContext,
} from "../../plugins/plugin-lifecycle-lease.js";
import { readPluginMetadataStateRow } from "../../plugins/plugin-metadata-state-worker.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseByPathAsync,
} from "../../state/openclaw-state-db.js";
import type { OpenClawStateReadCommand } from "../../state/openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  getCanonicalUserPreferences,
  setCanonicalUserPreferences,
} from "../../state/user-preferences.js";
import { setAvatar } from "../../state/user-profile-writes.worker.js";
import { createProfileAvatarReader } from "../../state/user-profiles-avatar.js";
import { ensureUserProfileRoleSchema } from "../../state/user-profiles-schema.js";
import { ensureGatewayOwnerProfile } from "../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { executeSqliteQuerySync } from "../kysely-sync.js";
import {
  bindCurrentConversationRecordAsync as bind,
  listCurrentConversationBindingRecordsBySessionsAsync as listBindings,
  readCurrentConversationBindingSelectionAsync as selectBindings,
} from "../outbound/current-conversation-bindings.js";
import type { SessionBindingRecord } from "../outbound/session-binding.types.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

function conformance(
  name: string,
  run: (fixture: ReturnType<typeof useMixedAgentPair>, engine: "sqlite" | "postgres") => void,
) {
  describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
    "%s " + name,
    (engine) => run(useMixedAgentPair(engine, engine), engine),
  );
}

conformance("post-ready storage consumers", (fixture) => {
  it("reads and updates operator preferences with absent and binary profile avatars", async () => {
    const profile = admit(() => {
      const owner = ensureGatewayOwnerProfile("Synthetic operator");
      ensureUserProfileRoleSchema({});
      return owner;
    });
    const preferences = { profileId: profile.id, entries: {} };
    await expect(getCanonicalUserPreferences(profile.id)).resolves.toEqual(preferences);
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(admit(() => setAvatar(profile.id, bytes, "image/png")).ok).toBe(true);
    await expect(getCanonicalUserPreferences(profile.id)).resolves.toEqual(preferences);
    const avatar = await createProfileAvatarReader(profile.id).inspect();
    await expect(avatar.loadBytes()).resolves.toMatchObject({ bytes, mime: "image/png" });
    const set = (entries: Record<string, unknown>, expectedEntries?: Record<string, unknown>) =>
      setCanonicalUserPreferences(profile.id, entries, { expectedEntries });
    expect(await set({ accent: "blue" })).toMatchObject({ ok: true });
    expect(await set({ accent: null }, { accent: "blue" })).toMatchObject({ ok: true });
    await expect(getCanonicalUserPreferences(profile.id)).resolves.toEqual(preferences);
    expect(await set({}, { accent: null })).toMatchObject({ ok: true });
    expect(await set({ accent: "green" })).toMatchObject({ ok: true });
    expect(await set({ accent: null }, { accent: "blue" })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await expect(getCanonicalUserPreferences(profile.id)).resolves.toEqual({
      profileId: profile.id,
      entries: { accent: "green" },
    });
  });

  it("reads cold placement projections and committed turn claims", async () => {
    admit(() => openOpenClawStateDatabase());
    const store = createWorkerSessionPlacementStore();
    const claimInput = {
      agentId: "main",
      sessionKey: "agent:main:placement-projection",
      sessionId: "placement-projection",
      owner: { kind: "local" as const },
      runId: "projection-run",
      claimId: "projection-claim",
    };
    const sessionId = claimInput.sessionId;
    expect((await store.readProjection([sessionId])).placements.size).toBe(0);
    const claim = await store.claimTurn(claimInput);
    try {
      expect(await store.claimTurn(claimInput)).toEqual(claim);
      const projection = await store.readProjection([sessionId], { current: true });
      expect(projection.placements.get(sessionId)).toMatchObject({
        state: "local",
        turnClaim: { claimId: "projection-claim", runId: "projection-run" },
      });
      expect([projection.environments.size, projection.pendingResults.size]).toEqual([0, 0]);
    } finally {
      await store.releaseTurn(claim);
    }
  });

  it("reads refreshed provider catalogs through the selected agent owner", async () => {
    const database = admit(() => openOpenClawAgentDatabase({ agentId: "main" }));
    const agentDir = path.dirname(database.path);
    for (const [contents, ids] of [
      ['{"marker":"first catalog"}', ["fixture", "missing"]],
      ['{"marker":"refreshed catalog"}', ["fixture"]],
    ] satisfies [string, string[]][]) {
      await catalogs.replacePersistedPluginModelCatalogs({
        agentDir,
        pluginCatalogWrites: {
          [catalogs.encodePluginModelCatalogRelativePath("fixture")]: contents,
          [catalogs.encodePluginModelCatalogRelativePath("other")]: '{"marker":"other"}',
        },
      });
      expect(await loadPersistedPluginModelCatalogs(agentDir, ids)).toEqual([
        { pluginId: "fixture", contents },
      ]);
    }
  });

  it("persists cron authority and recovery on the first authority write", async () => {
    const storePath = path.join(fixture.root, "cron", "authority.json");
    const isolated = {
      ...makeStore("captured-authority", false).jobs[0],
      sessionTarget: "isolated" as const,
      payload: { kind: "agentTurn" as const, message: "synthetic scheduled turn" },
    };
    const runtimeAuthority: CronRuntimeAuthority = {
      version: 1,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: [
        { ...isolated, runtimeAuthority: structuredClone(runtimeAuthority) },
        { ...isolated, id: "authority-recovery", runtimeAuthorityRecoveryRequired: true },
      ],
    });
    const loaded = await loadCronJobsStore(storePath);
    const find = (id: string) => loaded.jobs.find((job) => job.id === id);
    expect(find("captured-authority")).toMatchObject({ runtimeAuthority });
    expect(find("authority-recovery")).toMatchObject({
      runtimeAuthorityRecoveryRequired: true,
    });
  });

  it("starts cron and retains a disabled job across scheduler restart", async () => {
    const unexpectedDispatch = () => {
      throw new Error("Disabled cron conformance job must not dispatch");
    };
    const createCron = () =>
      new CronService({
        scheduler: createTestGatewayScheduler(),
        storePath: path.join(fixture.root, "cron", "post-ready.json"),
        cronEnabled: false,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        enqueueSystemEvent: unexpectedDispatch,
        runIsolatedAgentJob: unexpectedDispatch,
      });
    const original = createCron();
    const restarted = createCron();
    const retained = {
      name: "post-ready durable job",
      enabled: false,
      payload: { kind: "systemEvent" as const, text: "synthetic cron marker" },
    };
    try {
      await original.start();
      const job = await original.add({
        ...structuredClone(retained),
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
      });
      original.stop();
      await original.waitForIdle();
      await restarted.start();
      expect(await restarted.list({ includeDisabled: true })).toMatchObject([
        { id: job.id, ...retained },
      ]);
    } finally {
      original.stop();
      restarted.stop();
      await Promise.all([original.waitForIdle(), restarted.waitForIdle()]);
    }
  });
});
conformance("pending input workers", () => {
  const receipts: SessionPendingInputReceipt[] = [];
  let sequence = 0;
  let scope: Parameters<typeof stageSessionPendingInput>[0];
  afterEach(async () => {
    const retained = receipts.splice(0);
    for (const receipt of retained) {
      receipt.finish("interrupted");
    }
    await Promise.all(retained.map(async (receipt) => receipt.settled?.()));
  });

  beforeEach(async () => {
    const sessionId = `pending-${++sequence}`;
    const { path: storePath } = admit(() => openOpenClawAgentDatabase({ agentId: "main" }));
    scope = { agentId: "main", sessionKey: `agent:main:${sessionId}`, sessionId, storePath };
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
  });
  const stage = async (runId: string, trackCompletion = false) => {
    const idempotencyKey = `${runId}:user`;
    const receipt = await stageSessionPendingInput(scope, {
      runId,
      message: { role: "user", content: runId, timestamp: 1, idempotencyKey },
      trackCompletion,
      assertCurrent() {},
    });
    assert(receipt);
    receipts.push(receipt);
    return receipt;
  };

  it("retains interrupted history and excludes consumed inputs from counted and context pages", async () => {
    const retained = await stage("retained");
    retained.finish("interrupted");
    await retained.settled?.();
    const consumed = await stage("consumed");
    expect(
      await consumed.run(() => appendTranscriptMessage(scope, { message: consumed.message })),
    ).toMatchObject({ appended: true });
    expect(consumed.state).toBe("consumed");

    const expected = {
      id: retained.inputId,
      state: "interrupted",
      message: { content: "retained" },
    };
    expect(await listSessionPendingInputs(scope)).toMatchObject({
      total: 1,
      items: [expected],
    });
    expect(await readSessionPendingInputContext(scope)).toMatchObject({ items: [expected] });
  });

  it("recovers submitted input from its retained pending row before transcript consumption", async () => {
    await stage("submitted");
    expect(await readSessionSubmittedInput(scope, "submitted:user")).toMatchObject({
      role: "user",
      content: "submitted",
      idempotencyKey: "submitted:user",
    });
  });

  it("returns a persisted completion when the same input is submitted again", async () => {
    const first = await stage("completed", true);
    assert(first.completeAsync);
    const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
    expect(await first.completeAsync(outcome)).toEqual(outcome);
    first.finish("interrupted");
    await first.settled?.();

    const replay = await stage("completed", true);
    expect(replay).toMatchObject({ state: "consumed", completion: outcome });
    expect(() => replay.run(() => {})).toThrow("Input processing has already completed");
  });

  it("withdraws the selected queued input without changing its sibling", async () => {
    const removed = await stage("removed");
    const retained = await stage("sibling");
    expect(await discardSessionPendingInput(scope, "removed", () => {})).toBe(true);
    expect(await readSessionPendingInput(scope, removed.inputId)).toMatchObject({
      state: "cancelled",
      message: { display: false },
    });
    expect(await readSessionPendingInput(scope, retained.inputId)).toMatchObject({
      state: "queued",
      message: { content: "sibling" },
    });
  });
});
conformance("subagent registry", (fixture) => {
  it("persists child runs through the worker and cold-reads full, maintenance, and session projections", async () => {
    const database = admit(() => openOpenClawStateDatabase());
    const storePath = path.join(fixture.root, "agents", "main", "agent", "openclaw-agent.sqlite");
    const runs = new Map<string, SubagentRunRecord>();
    const records = ([undefined, "parent"] as const).map((completionTarget, index) =>
      createSubagentStoreRunFixture({
        runId: `child-${index}`,
        childSessionKey: `agent:main:subagent:child-${index}`,
        requesterSessionKey: "agent:main:parent",
        requesterDisplayKey: "parent",
        controllerSessionKey: "agent:main:controller",
        requesterStorePath: storePath,
        controllerStorePath: storePath,
        task: index === 0 ? "retained task" : "retained task with escaped NUL \0",
        createdAt: 100 + index,
        completion: { required: true, resultText: "retained child result" },
        delivery: { status: "pending" },
        ...(completionTarget ? { completionTarget } : {}),
      }),
    );
    const runIds = records.map((entry) => entry.runId);
    const postimages = new Map(records.map((entry) => [entry.runId, entry]));
    await mutateSubagentRuns(runIds, () => ({ value: undefined, postimages }), { runs });
    const before = await readAllSubagentRunsInWorker(captureOpenClawStateWorkerContext());
    expect([...before]).toMatchObject([...postimages]);

    await closeOpenClawStateDatabaseByPathAsync(database.path);
    admit(() => openOpenClawStateDatabase());
    const context = captureOpenClawStateWorkerContext();
    const options = { path: database.path, env: process.env };
    const read = <C extends OpenClawStateReadCommand>(command: C) =>
      executeExistingOpenClawStateRead(options, command, { context, current: true });
    expect(await readAllSubagentRunsInWorker(context)).toEqual(before);

    const maintenance = await read({ type: "subagents.runs", scope: { kind: "maintenance" } });
    assert(maintenance?.ok && maintenance.type === "subagents.runs");
    const sessions = await read({ type: "subagents.sessionList" });
    assert(sessions?.ok && sessions.type === "subagents.sessionList" && "runs" in sessions);
    for (const [projection, fields] of [
      [maintenance, { execution: { status: "terminal", endedAt: 250 } }],
      [
        sessions,
        {
          requesterStorePath: storePath,
          controllerStorePath: storePath,
          controllerSessionKey: "agent:main:controller",
          execution: { status: "terminal", outcome: { status: "ok" } },
        },
      ],
    ] as const) {
      expect([...projection.runs.keys()]).toEqual(runIds);
      for (const record of projection.runs.values()) {
        expect(record).toMatchObject({ ...fields, delivery: { status: "pending" } });
        expect(record).not.toHaveProperty("task");
        expect(record).not.toHaveProperty("completion");
      }
    }

    const selected = await read({
      type: "subagents.runs",
      scope: { kind: "ids", runIds: [runIds[1]!] },
    });
    assert(selected?.ok && selected.type === "subagents.runs");
    expect([...selected.runs]).toEqual([[runIds[1], before.get(runIds[1]!)]]);
  });
});
const scopeFor = (sessionId: string) => ({
  agentId: "main",
  sessionKey: `agent:main:${sessionId}`,
  sessionId,
});
const message = (id: string, parentId: string | null, role: string, content: string) => ({
  type: "message",
  id,
  parentId,
  message: { role, content },
});
function withTranscript(
  scope: ReturnType<typeof scopeFor>,
  events: unknown[],
  inspect: (database: OpenClawAgentDatabase, resolved: ResolvedTranscriptScope) => void,
) {
  admit(() => {
    const resolved = resolveSqliteTranscriptScope(scope);
    runOpenClawAgentWriteTransaction((database) => {
      writeSessionEntry(database, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
      replaceSqliteTranscriptEventsInTransaction(database, resolved, events);
      inspect(database, resolved);
    }, toDatabaseOptions(resolved));
  });
}

conformance("transcript report navigation", (_fixture, engine) => {
  it("returns numeric transcript bytes for raw, reset-tail, and maintenance reads", () => {
    const scope = scopeFor("transcript-byte-counts");
    const kept = message("kept", "discarded", "user", "Retained λ🦞 preference.");
    const tail = message("tail", "reset", "assistant", "Fresh 日本語 response.");
    const events = [
      { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
      message("discarded", null, "user", "Discarded earlier context."),
      kept,
      { type: "reset", id: "reset", parentId: "kept", firstKeptEntryId: "kept", reason: "new" },
      tail,
    ];
    const bytes = (event: unknown) => Buffer.byteLength(JSON.stringify(event));
    const payloadBytes = events.reduce((total, event) => total + bytes(event), 0);
    withTranscript(scope, events, (database, resolved) => {
      expect(readTranscriptStatsFromDatabase(database, scope.sessionId)).toMatchObject({
        eventCount: events.length,
        sizeBytes: payloadBytes + events.length - 1,
      });
      expect(
        readSessionTranscriptJsonlBytesInDatabase(database, [scope.sessionId, "missing"]),
      ).toEqual(new Map([[scope.sessionId, payloadBytes + events.length]]));
      const visible = readCurrentProjectionSnapshot(database, resolved, (projection) =>
        // Cold projections reconstruct the retained prefix without cached accounting facts.
        readVisibleTranscriptStats({
          ...projection,
          contextMetadata: undefined,
          contextStats: undefined,
        }),
      );
      expect(visible).toMatchObject({
        kind: "value",
        value: { eventCount: 2, sizeBytes: bytes(kept) + bytes(tail) + 2 },
      });
    });
  });

  it("selects the latest custom report from persisted transcript navigation", async () => {
    const scope = scopeFor("report-navigation");
    const content = "synthetic report content ".repeat(400);
    const selected = { customType: "status", content, details: { selected: true } };
    withTranscript(
      scope,
      [
        { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
        message("root", null, "user", content),
        {
          type: "custom_message",
          id: "selected",
          parentId: "root",
          ...selected,
          display: true,
        },
      ],
      (database) => {
        const rows = executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("transcript_events")
            .select(["event_json", "event_zstd"])
            .where("session_id", "=", scope.sessionId),
        ).rows;
        // SQLite uses zstd navigation; PostgreSQL keeps canonical JSON and delegates to TOAST.
        expect(
          rows.filter((row) => row.event_json === null && row.event_zstd !== null),
        ).toHaveLength(engine === "sqlite" ? 2 : 0);
      },
    );
    const selectReport = vi.fn();
    await expect(
      appendSessionTranscriptReport(scope, {
        kind: "custom",
        customTypes: ["status"],
        selectReport,
      }),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(selectReport).toHaveBeenCalledExactlyOnceWith(selected);
  });
});
conformance("post-ready plugin registry", (fixture) => {
  afterEach(() => vi.restoreAllMocks());
  const retained = { retained: { source: "archive" as const, version: "1.0.0" } };
  const publish =
    (records: Record<string, PluginInstallRecord> = retained, warn?: (message: string) => void) =>
    (lease: PluginMetadataLeaseContext) =>
      refreshPluginRegistryAfterConfigMutation({
        reason: "source-changed",
        lease,
        installRecords: records,
        invalidateRuntimeCache: false,
        logger: { warn },
      });

  beforeEach(async () => {
    const configPath = path.join(fixture.root, "openclaw.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    await fs.writeFile(configPath, JSON.stringify({ ...config, plugins: { enabled: false } }));
  });

  it("publishes a durable registry with no PostgreSQL SQL on the main thread", async () => {
    const statements: unknown[] = [];
    const observation = channel("openclaw.database.statement");
    const observe = (event: unknown) => {
      if (isRecord(event) && event.engine === "postgres") {
        statements.push(event);
      }
    };
    const warn = vi.fn();
    observation.subscribe(observe);
    try {
      await withPluginLifecycleLeaseAsync({ processBound: true }, publish(retained, warn));
      const row = await readPluginMetadataStateRow("installed-index", {});
      expect(row).toBeDefined();
      expect(JSON.parse(row!.value_json)).toMatchObject({
        index: { refreshReason: "source-changed", installRecords: retained },
      });
      expect(warn).not.toHaveBeenCalled();
      expect(statements).toEqual([]);
    } finally {
      observation.unsubscribe(observe);
    }
  });

  it("rejects authority lost during config preparation without replacing the durable registry", async () => {
    await withPluginLifecycleLeaseAsync({}, publish());
    const before = await readPluginMetadataStateRow("installed-index", {});
    expect(before).toBeDefined();
    const refusal = new Error("Post-ready plugin owner revoked during config preparation");
    let current = true;
    const create = configIO.createConfigIO;
    vi.spyOn(configIO, "createConfigIO").mockImplementation((options) => {
      const io = create(options);
      return {
        ...io,
        readConfigFileSnapshot: async () => {
          const snapshot = await io.readConfigFileSnapshot();
          current = false;
          return snapshot;
        },
      };
    });
    const warn = vi.fn();
    await expect(
      withPluginLifecycleLeaseAsync(
        {
          processBound: true,
          assertCurrent: () => {
            if (!current) {
              throw refusal;
            }
          },
        },
        publish({ replacement: { source: "archive", version: "2.0.0" } }, warn),
      ),
    ).rejects.toBe(refusal);
    expect(current).toBe(false);
    expect(await readPluginMetadataStateRow("installed-index", {})).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
  });
});

conformance("conversation batches", () => {
  it("registers distinct addresses with each duplicate's final postimage", async () => {
    const addresses = ["first", "second"].map((id) => {
      const identity = buildConversationIdentity({
        channel: "demo",
        accountId: "default",
        kind: "direct",
        peerId: id,
        deliveryTarget: `demo:${id}`,
        label: id,
      });
      assert(identity);
      return identity;
    });
    const scope = { agentId: "main", env: process.env };
    await registerAddresses(scope, [...addresses, { ...addresses[0]!, label: "final first" }], 100);
    expect(await listConversations(scope, { channel: "demo" })).toHaveLength(2);
    for (const [index, identity] of addresses.entries()) {
      expect(await readConversation(scope, identity.conversationRef)).toMatchObject({
        conversationRef: identity.conversationRef,
        target: identity.deliveryTarget,
        label: index === 0 ? "final first" : "second",
        firstSeenAt: 100,
        lastSeenAt: 100,
      });
    }
  });

  it("selects and lists binding batches with absences, duplicates, and account scope", async () => {
    const records: SessionBindingRecord[] = ["first", "second"].map((id) => ({
      bindingId: id === "first" ? "generic:demo\u241fdefault\u241f\u241ffirst" : `fixture:${id}`,
      conversation: {
        channel: "demo",
        accountId: id === "first" ? "default" : "other",
        conversationId: id,
      },
      targetSessionKey: `agent:main:${id}`,
      targetKind: "session",
      status: "active",
      boundAt: 1,
      metadata: {},
    }));
    for (const record of records) {
      await bind({ record });
    }
    const [first, second] = records;
    assert(first && second);
    expect(
      await selectBindings([
        second.conversation,
        { ...first.conversation, conversationId: "missing" },
        first.conversation,
        second.conversation,
      ]),
    ).toEqual([second, null, first, second]);
    const targets = [
      second.targetSessionKey,
      "agent:main:missing",
      first.targetSessionKey,
      second.targetSessionKey,
    ];
    for (const [accountId, expected] of [
      [undefined, [[], [], [first], []]],
      ["default", [[], [], [first], []]],
      ["other", [[second], [], [], [second]]],
    ] as const) {
      expect(
        await listBindings(targets, accountId ? { channel: "demo", accountId } : undefined),
      ).toEqual(expected);
    }
  });
});
