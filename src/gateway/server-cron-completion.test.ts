import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCronJobActive,
  noteActiveCronJobRemoval,
  requestActiveCronJobCancellation,
} from "../cron/active-jobs.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import { createCronCompletionDeliveryFence } from "../cron/service/delivery-attempt-fence.js";
import { markServiceCronJobActive } from "../cron/service/run-receipts.js";
import { createCronServiceState } from "../cron/service/state.js";
import { loadCronStore, saveCronStore } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import { readActiveCronRunReceiptsInDatabase } from "../cron/store/run-receipt-read.js";
import {
  claimCronRunReceiptForTest,
  finishCronRunReceiptAsync,
} from "../cron/store/run-receipt-store.test-support.js";
import type { CronStoredJob } from "../cron/types.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../infra/outbound/deliver-types.js";
import * as outboundSession from "../infra/outbound/outbound-session.js";
import { getChildLogger } from "../logging.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { finalizeCronCompletionAnnouncement } from "./server-cron-completion.js";
import * as assistantContent from "./server-methods/chat-assistant-content.js";

async function createCompletionFixture(
  state: OpenClawTestState,
  kind: "script" | "command",
  hookText?: string,
) {
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const source = {
    agentId: "main",
    storePath,
    sessionKey: "agent:main:webchat:direct:creator",
    sessionId: "creator-session",
  };
  const generation = { sessionId: source.sessionId, lifecycleRevision: "creator-generation" };
  const executionSessionKey = `agent:main:cron:${kind}-job`;
  // Keep the v2026.9.9 persisted shape independent of current job defaults.
  const releasedJob = {
    id: `${kind}-job`,
    agentId: "main",
    name: "test",
    enabled: true,
    createdAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload:
      kind === "script"
        ? { kind: "script", script: "return { notify: 'Script finished' };" }
        : { kind: "command", argv: ["printf", "Command finished"] },
    delivery: { mode: "announce", channel: "telegram", to: "123" },
    state: {},
  } satisfies Omit<CronStoredJob, "updatedAtMs">;
  const job: CronStoredJob = {
    ...releasedJob,
    updatedAtMs: 1,
    sessionKey: executionSessionKey,
    state: { runningAtMs: 1000 },
    sourceConversation: { sessionKey: source.sessionKey, ...generation },
  };
  const otherScopes = [
    { ...source, sessionKey: executionSessionKey, sessionId: "execution-session" },
    { ...source, sessionKey: "agent:main:telegram:direct:123", sessionId: "recipient-session" },
    { ...source, sessionKey: "agent:main:main", sessionId: "main-session" },
  ];
  await replaceSessionEntry(source, { ...generation, updatedAt: 1 });
  for (const scope of otherScopes) {
    await replaceSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      // A tempting unrelated route must not become the source result destination.
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "123" },
      }),
    });
  }
  const destination = otherScopes[1]!;
  const cronStorePath = state.statePath("cron", "jobs.json");
  await saveCronStore(cronStorePath, { version: 1, jobs: [job] });
  const receipt = claimCronRunReceiptForTest(cronStorePath, job, 1000);
  const service = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => 1000,
    storePath: cronStorePath,
    cronEnabled: true,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
  });
  const marker = markServiceCronJobActive(service, job, receipt);
  const controller = new AbortController();
  const deliveryAttemptFence = createCronCompletionDeliveryFence({
    state: service,
    job,
    handle: receipt,
    activeJobMarker: marker,
    signal: controller.signal,
  });
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    session: { store: storePath, dmScope: "per-channel-peer" },
    gateway: { publicOrigin: "https://automation.example.test" },
  };
  const sendText = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>().mockResolvedValue({
    channel: "telegram",
    messageId: "notification-message",
  });
  const pluginRegistry = createTestRegistry([
    {
      pluginId: "telegram",
      source: "test",
      plugin: {
        ...createChannelTestPluginBase({
          id: "telegram",
          config: { listAccountIds: () => ["default", "work"] },
        }),
        outbound: { deliveryMode: "direct", sendText },
      },
    },
  ]);
  if (hookText !== undefined) {
    addTestHook({
      registry: pluginRegistry,
      pluginId: "telegram",
      hookName: "message_sending",
      handler: () => ({ content: hookText }),
    });
  }
  setActivePluginRegistry(pluginRegistry);
  if (hookText !== undefined) {
    initializeGlobalHookRunner(pluginRegistry);
  }
  const logger = getChildLogger({ module: "cron-completion-test" });
  const text = kind === "script" ? "Script finished" : "Command finished";
  const messages = async (scope = source) => {
    const entry = loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });
    if (!entry) {
      return [];
    }
    return (await loadTranscriptEvents({ ...scope, sessionId: entry.sessionId }))
      .map(readTranscriptEventMessage)
      .filter((message) => message?.role === "assistant");
  };
  const inspectText = `${text}\n[Inspect run](https://automation.example.test/automations?job=${kind}-job&run=cron%3A${kind}-job%3A1000)`;
  const assertMessages = async (scope?: typeof source, messageText?: string, metadata = {}) => {
    for (const target of [source, ...otherScopes]) {
      expect(await messages(target)).toEqual(
        target === scope
          ? [
              expect.objectContaining({
                content: [{ type: "text", text: messageText }],
                ...metadata,
              }),
            ]
          : [],
      );
    }
  };
  const assertText = (value: string) => assertMessages(destination, value);
  const assertResult = (scope = destination) =>
    assertMessages(scope, scope.sessionKey === source.sessionKey ? text : inspectText, {
      model: "automation-result",
      openclawAutomation: { kind: "cron", jobId: job.id, runId: `cron:${job.id}:1000` },
    });
  const finalize = (
    overrides: Partial<Parameters<typeof finalizeCronCompletionAnnouncement>[0]> = {},
  ) =>
    finalizeCronCompletionAnnouncement({
      deliveryAttemptFence,
      job,
      text,
      runStartedAtMs: 1000,
      abortSignal: controller.signal,
      deps: {},
      resolveCronAgent: () => ({ agentId: "main", cfg }),
      logger,
      label: kind,
      ...overrides,
    });
  return {
    cfg,
    source,
    destination,
    job,
    text,
    sendText,
    messages,
    assertResult,
    assertText,
    assertNoResults: () => assertMessages(),
    finalize,
    async loadReleasedRows() {
      const jobJson = JSON.stringify(releasedJob);
      runOpenClawStateWriteTransaction(({ db }) => {
        db.prepare("UPDATE cron_jobs SET job_json = ? WHERE store_key = ? AND job_id = ?").run(
          jobJson,
          cronStoreKey(cronStorePath),
          job.id,
        );
        // v2026.9.9 receipts predate this column; migration assigns the unknown default.
        db.prepare(
          "UPDATE cron_run_receipts SET delivery_attempt_state = 'unknown' WHERE receipt_id = ?",
        ).run(receipt.receiptId);
        // A retained terminal receipt uses only columns shipped in v2026.9.9.
        db.prepare(
          `INSERT INTO cron_run_receipts (
            cursor_id, receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
            status, owner_pid, owner_start_time, started_at_ms, finished_at_ms, error_text
          ) VALUES ((SELECT coalesce(max(cursor_id), 0) + 1 FROM cron_run_receipts), ?, ?, ?, ?, 'main', 'released-request', 'ok', 123, NULL, 10, 20, NULL)`,
        ).run("released-receipt", receipt.storeKey, job.id, receipt.configRevision);
      });
      const loaded = (await loadCronStore(cronStorePath)).jobs[0]!;
      expect(loaded).not.toHaveProperty("sourceConversation");
      const database = openOpenClawStateDatabase().db;
      expect(readActiveCronRunReceiptsInDatabase(database, receipt.storeKey, [job.id])).toEqual([
        receipt,
      ]);
      const snapshot = () => ({
        retained: database
          .prepare("SELECT * FROM cron_run_receipts WHERE receipt_id = 'released-receipt'")
          .get(),
        schema: database
          .prepare(
            "SELECT name, sql FROM sqlite_schema WHERE name IN ('cron_jobs', 'cron_run_receipts') ORDER BY name",
          )
          .all(),
        jobJson: database
          .prepare("SELECT job_json FROM cron_jobs WHERE store_key = ? AND job_id = ?")
          .get(receipt.storeKey, job.id)?.job_json,
      });
      const before = snapshot();
      expect(before.retained).toMatchObject({
        request_run_id: "released-request",
        status: "ok",
        started_at_ms: 10,
        finished_at_ms: 20,
        delivery_attempt_state: "unknown",
      });
      expect(before.jobJson).toBe(jobJson);
      return { job: loaded, assertPreserved: () => expect(snapshot()).toEqual(before) };
    },
    async removeOccurrence() {
      await saveCronStore(cronStorePath, { version: 1, jobs: [] });
      noteActiveCronJobRemoval(job.id);
    },
    cancelOccurrence() {
      requestActiveCronJobCancellation(job.id, "Cancelled by operator.");
    },
    async dispose() {
      clearCronJobActive(job.id, marker);
      if (hookText !== undefined) {
        resetGlobalHookRunner();
      }
      await finishCronRunReceiptAsync({ handle: receipt, status: "ok", finishedAtMs: 2000 });
    },
  };
}

function deliveryDiagnostics(message: string, contains = false, substring = false) {
  const entry = expect.objectContaining({
    source: "delivery",
    severity: "warn",
    message: substring ? expect.stringContaining(message) : message,
  });
  return { diagnostics: { entries: contains ? expect.arrayContaining([entry]) : [entry] } };
}

async function withCompletionFixture(
  kind: "script" | "command",
  run: (fixture: Awaited<ReturnType<typeof createCompletionFixture>>) => Promise<void>,
  hookText?: string,
) {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const registry = captureActivePluginRegistrySnapshot();
    const fixture = await createCompletionFixture(state, kind, hookText);
    try {
      await run(fixture);
    } finally {
      await fixture.dispose();
      vi.restoreAllMocks();
      restoreActivePluginRegistrySnapshot(registry);
    }
  });
}

// Exercise the shared Gateway completion entry point with real conversation persistence,
// target resolution, and durable notification delivery. Only the channel I/O is synthetic.
// Command execution and script evaluation belong to their respective runner suites.
describe("completion announcement", () => {
  const confirmed = { deliveryAttempted: true, delivered: true };

  it("commits the effective post-hook payload shown to the recipient", async () => {
    await withCompletionFixture(
      "command",
      async (fixture) => {
        await expect(fixture.finalize({ text: "Sensitive cron update" })).resolves.toMatchObject({
          delivered: true,
        });
        expect(fixture.sendText).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "Redacted cron update" }),
        );
        await fixture.assertText("Redacted cron update");
      },
      "Redacted cron update",
    );
  });

  it.each([
    { kind: "script", failure: "none" },
    { kind: "script", failure: "rejected" },
    { kind: "script", failure: "uncertain" },
  ] as const)(
    "adds the $kind result only after confirmed notification (failure=$failure)",
    async ({ kind: payloadKind, failure }) => {
      await withCompletionFixture("script", async (fixture) => {
        fixture.sendText.mockImplementation(async () => {
          expect(await fixture.messages(fixture.destination)).toEqual([]);
          if (failure === "uncertain") {
            throw new OutboundDeliveryError("read ECONNRESET after send", {
              cause: new Error("response lost"),
              results: [{ channel: "telegram", messageId: "possibly-delivered" }],
              stage: "platform_send",
            });
          }
          if (failure === "rejected") {
            throw new PlatformMessageNotDispatchedError("notification rejected", {
              cause: new Error("synthetic recipient rejection"),
              retryable: false,
            });
          }
          return { channel: "telegram", messageId: "notification-message" };
        });

        const result = await fixture.finalize();
        if (failure === "none") {
          await expect(fixture.finalize()).resolves.toMatchObject(confirmed);
        }

        expect(fixture.sendText).toHaveBeenCalledOnce();
        expect(fixture.sendText.mock.calls[0]?.[0]).toMatchObject({
          to: "123",
          text: `${fixture.text}\n[Inspect run](https://automation.example.test/automations?job=${payloadKind}-job&run=cron%3A${payloadKind}-job%3A1000)`,
        });
        expect(result).toMatchObject({
          deliveryAttempted: true,
          delivered: failure === "uncertain" ? undefined : failure === "none",
        });
        if (failure !== "none") {
          expect(result).toMatchObject({
            deliveryError: expect.stringContaining(
              failure === "uncertain" ? "ECONNRESET" : "notification rejected",
            ),
            deliveryState: { status: failure === "uncertain" ? "unknown" : "not-delivered" },
          });
        }
        if (failure === "none") {
          await fixture.assertResult();
        } else {
          await fixture.assertNoResults();
          if (failure === "uncertain") {
            expect(result).toMatchObject({
              ...deliveryDiagnostics(
                "result may have been delivered but was not added to the conversation",
                true,
              ),
            });
          }
        }
      });
    },
  );

  it.each(["binding failure", "cross-agent destination"] as const)(
    "delivers without conversation writes after %s",
    async (reason) => {
      await withCompletionFixture("script", async (fixture) => {
        let otherDestination: typeof fixture.destination | undefined;
        if (reason === "binding failure") {
          vi.spyOn(outboundSession, "bindOutboundSessionEntry").mockRejectedValueOnce(
            new Error("conversation binding unavailable"),
          );
        } else {
          fixture.cfg.agents = { entries: { main: {}, other: {} } };
          fixture.cfg.bindings = [
            {
              agentId: "other",
              match: {
                channel: "telegram",
                accountId: "default",
                peer: { kind: "direct", id: "123" },
              },
            },
          ];
          fixture.job.delivery = {
            mode: "announce",
            channel: "telegram",
            to: "123",
            accountId: "default",
          };
          otherDestination = {
            ...fixture.destination,
            agentId: "other",
            sessionKey: "agent:other:telegram:direct:123",
            sessionId: "other-recipient-session",
            storePath: path.resolve(
              fixture.destination.storePath,
              "../../../other/sessions/sessions.json",
            ),
          };
          await replaceSessionEntry(otherDestination, {
            sessionId: otherDestination.sessionId,
            updatedAt: 1,
          });
        }
        expect(await fixture.finalize()).toMatchObject({
          delivered: true,
          deliveryError: undefined,
          ...deliveryDiagnostics(
            reason === "binding failure"
              ? "result was delivered but was not added to the conversation: conversation binding unavailable"
              : "Conversation context skipped: the destination belongs to a different agent.",
          ),
        });
        expect(fixture.sendText).toHaveBeenCalledOnce();
        await fixture.assertNoResults();
        if (otherDestination) {
          expect(fixture.sendText.mock.calls[0]?.[0]).toMatchObject({
            to: "123",
            accountId: "default",
          });
          expect(await fixture.messages(otherDestination)).toEqual([]);
        }
      });
    },
  );

  it.each(["deleted", "reset"] as const)(
    "delivers to the explicit destination when the captured source was %s",
    async (change) => {
      await withCompletionFixture("script", async (fixture) => {
        const target = {
          canonicalKey: fixture.source.sessionKey,
          storeKeys: [fixture.source.sessionKey],
        };
        if (change === "deleted") {
          await deleteSessionEntryLifecycle({
            archiveTranscript: false,
            storePath: fixture.source.storePath,
            target,
          });
        } else {
          await resetSessionEntryLifecycle({
            storePath: fixture.source.storePath,
            target,
            buildNextEntry: () => ({
              sessionId: "replacement-session",
              lifecycleRevision: "replacement-generation",
              updatedAt: 2,
            }),
          });
        }

        await expect(fixture.finalize()).resolves.toMatchObject(confirmed);
        expect(fixture.sendText).toHaveBeenCalledOnce();
        await fixture.assertResult();
      });
    },
  );

  it("refuses destination output without an occurrence identity", async () => {
    await withCompletionFixture("script", async (fixture) => {
      await expect(fixture.finalize({ runStartedAtMs: undefined })).resolves.toMatchObject({
        deliveryAttempted: true,
        delivered: false,
        deliveryError: "cron result is missing its occurrence start time",
      });
      expect(fixture.sendText).not.toHaveBeenCalled();
      await fixture.assertNoResults();
    });
  });

  it("loads and delivers v2026.9.9-shaped jobs without rewriting retained receipts or schema", async () => {
    await withCompletionFixture("script", async (fixture) => {
      const released = await fixture.loadReleasedRows();

      await expect(fixture.finalize({ job: released.job })).resolves.toMatchObject(confirmed);
      expect(fixture.sendText).toHaveBeenCalledOnce();
      await fixture.assertResult();
      released.assertPreserved();
    });
  });

  it("completes in the source without inheriting the shared main external route", async () => {
    await withCompletionFixture("script", async (fixture) => {
      fixture.job.delivery = { mode: "announce", channel: "last" };

      await expect(fixture.finalize()).resolves.toMatchObject({
        deliveryAttempted: true,
        delivered: true,
        deliveryState: { status: "delivered" },
      });
      expect(fixture.sendText).not.toHaveBeenCalled();
      await fixture.assertResult(fixture.source);
    });
  });

  it.each(["NO_REPLY", "Scheduled report\nNO_REPLY"])(
    "delivers prepared script text literally without a second control parser: %s",
    async (text) => {
      await withCompletionFixture("script", async (fixture) => {
        await expect(fixture.finalize({ text })).resolves.toMatchObject({
          delivered: true,
          deliveryAttempted: true,
          deliveryError: undefined,
        });
        const deliveredText = `${text}\n[Inspect run](https://automation.example.test/automations?job=script-job&run=cron%3Ascript-job%3A1000)`;
        expect(fixture.sendText).toHaveBeenCalledWith(
          expect.objectContaining({ text: deliveredText }),
        );
        await fixture.assertText(deliveredText);
      });
    },
  );

  it.each(["none", "webhook"] as const)(
    "does not write a conversation result for %s delivery",
    async (mode) => {
      await withCompletionFixture("script", async (fixture) => {
        fixture.job.delivery =
          mode === "webhook" ? { mode, to: "https://receiver.example.test/cron" } : { mode };
        await expect(fixture.finalize()).resolves.toMatchObject({
          deliveryAttempted: false,
          delivered: false,
        });
        expect(fixture.sendText).not.toHaveBeenCalled();
        await fixture.assertNoResults();
      });
    },
  );

  it("does not commit or notify an aborted occurrence", async () => {
    await withCompletionFixture("script", async (fixture) => {
      const controller = new AbortController();
      controller.abort(new Error("occurrence aborted"));

      await expect(fixture.finalize({ abortSignal: controller.signal })).resolves.toMatchObject({
        deliveryAttempted: true,
        delivered: false,
        deliveryError: expect.stringContaining("occurrence aborted"),
      });
      expect(fixture.sendText).not.toHaveBeenCalled();
      await fixture.assertNoResults();
    });
  });

  it.each(["deleted", "cancelled"] as const)(
    "keeps confirmed delivery when transcript preparation loses occurrence authority (%s)",
    async (outcome) => {
      await withCompletionFixture("script", async (fixture) => {
        const entered = createDeferred();
        const resume = createDeferred();
        const prepare = assistantContent.buildAssistantReplyContent;
        vi.spyOn(assistantContent, "buildAssistantReplyContent").mockImplementationOnce(
          async (params) => {
            entered.resolve();
            await resume.promise;
            return prepare(params);
          },
        );
        const completion = fixture.finalize();
        try {
          await awaitGateBeforeSettlement(
            entered.promise,
            completion,
            "completion settled before preparing destination content",
          );
          expect(fixture.sendText).toHaveBeenCalledOnce();
          expect(await fixture.messages()).toEqual([]);
          expect(await fixture.messages(fixture.destination)).toEqual([]);
          if (outcome === "deleted") {
            await fixture.removeOccurrence();
          } else if (outcome === "cancelled") {
            fixture.cancelOccurrence();
          }
        } finally {
          resume.resolve();
        }
        const result = await completion;
        expect(result).toMatchObject({
          deliveryAttempted: true,
          delivered: true,
          deliveryError: undefined,
          ...deliveryDiagnostics(
            "result was delivered but was not added to the conversation: cron delivery owner retired",
            true,
            true,
          ),
        });
        expect(fixture.sendText).toHaveBeenCalledOnce();
        await fixture.assertNoResults();
      });
    },
  );
});
