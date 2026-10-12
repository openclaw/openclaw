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
import { makeCronJob } from "../cron/delivery.test-helpers.js";
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
import { sendGatewayCronFailureAlert } from "./server-cron-notifications.js";
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
  const job: CronStoredJob = {
    ...makeCronJob({
      id: `${kind}-job`,
      agentId: "main",
      createdAtMs: 1,
      updatedAtMs: 1,
      sessionKey: executionSessionKey,
      payload:
        kind === "script"
          ? { kind: "script", script: "return { notify: 'Script finished' };" }
          : { kind: "command", argv: ["printf", "Command finished"] },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      state: { runningAtMs: 1000 },
    }),
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
    requestHeartbeat: vi.fn(),
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
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
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
  const assertResult = async (scope = destination) => {
    expect(await messages(scope)).toEqual([
      expect.objectContaining({
        content: [
          {
            type: "text",
            text:
              scope.sessionKey === source.sessionKey
                ? text
                : `${text}\nInspect: https://automation.example.test/automations?job=${kind}-job&run=cron%3A${kind}-job%3A1000`,
          },
        ],
        model: "automation-result",
        ...(scope.sessionKey === source.sessionKey
          ? { openclawAutomation: { kind: "cron", jobId: job.id, runId: `cron:${job.id}:1000` } }
          : {}),
      }),
    ]);
  };
  const assertNoOtherResults = async (resultScope = destination) => {
    for (const scope of [source, ...otherScopes]) {
      if (scope !== resultScope) {
        expect(await messages(scope)).toEqual([]);
      }
    }
  };
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
    warn,
    messages,
    assertResult,
    assertNoOtherResults,
    finalize,
    async loadReleasedRows() {
      // v2026.9.9: types.ts CronStoredJob and store/row-codec.ts persisted config.
      // Jobs from that release did not capture a creating conversation.
      const jobJson = JSON.stringify({
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
      });
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
            receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
            status, owner_pid, owner_start_time, started_at_ms, finished_at_ms, error_text
          ) VALUES (?, ?, ?, ?, 'main', 'released-request', 'ok', 123, NULL, 10, 20, NULL)`,
        ).run("released-receipt", receipt.storeKey, job.id, receipt.configRevision);
      });
      const loaded = (await loadCronStore(cronStorePath)).jobs[0]!;
      expect(loaded).not.toHaveProperty("sourceConversation");
      const database = openOpenClawStateDatabase().db;
      expect(readActiveCronRunReceiptsInDatabase(database, receipt.storeKey, [job.id])).toEqual([
        receipt,
      ]);
      const retainedQuery = database.prepare(
        "SELECT * FROM cron_run_receipts WHERE receipt_id = 'released-receipt'",
      );
      const retained = retainedQuery.get();
      expect(retained).toMatchObject({
        request_run_id: "released-request",
        status: "ok",
        started_at_ms: 10,
        finished_at_ms: 20,
        delivery_attempt_state: "unknown",
      });
      const schemaQuery = database.prepare(
        "SELECT name, sql FROM sqlite_schema WHERE name IN ('cron_jobs', 'cron_run_receipts') ORDER BY name",
      );
      const schema = schemaQuery.all();
      return {
        job: loaded,
        assertPreserved() {
          expect(retainedQuery.get()).toEqual(retained);
          expect(schemaQuery.all()).toEqual(schema);
          expect(
            database
              .prepare("SELECT job_json FROM cron_jobs WHERE store_key = ? AND job_id = ?")
              .get(receipt.storeKey, job.id)?.job_json,
          ).toBe(jobJson);
        },
      };
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

async function withCompletionFixture(
  kind: "script" | "command",
  run: (fixture: Awaited<ReturnType<typeof createCompletionFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const registry = captureActivePluginRegistrySnapshot();
    const fixture = await createCompletionFixture(state, kind);
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
  const kind = "script";

  it("records a failure alert once in its destination, not the creating conversation", async () => {
    await withCompletionFixture("command", async (fixture) => {
      fixture.cfg.gateway = undefined;
      fixture.job.sessionKey = fixture.destination.sessionKey;
      const onDeliverySettled = vi.fn(async () => {});
      await sendGatewayCronFailureAlert({
        deps: {},
        logger: { warn: vi.fn() },
        resolveCronAgent: () => ({ agentId: "main", cfg: fixture.cfg }),
        job: fixture.job,
        routing: { defaultAgentId: "main" },
        payload: { text: "Scheduled command failed." },
        channel: "telegram",
        to: "123",
        mode: "announce",
        onDeliverySettled,
      });
      expect(fixture.sendText).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Scheduled command failed." }),
      );
      expect(await fixture.messages(fixture.destination)).toEqual([
        expect.objectContaining({
          content: [{ type: "text", text: "Scheduled command failed." }],
          provider: "openclaw",
          model: "automation-result",
        }),
      ]);
      await fixture.assertNoOtherResults();
      expect(onDeliverySettled).toHaveBeenCalledExactlyOnceWith({
        delivered: true,
        status: "delivered",
      });
    });
  });

  it("commits the effective post-hook payload shown to the recipient", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const registry = captureActivePluginRegistrySnapshot();
      const fixture = await createCompletionFixture(state, "command", "Redacted cron update");
      try {
        await expect(fixture.finalize({ text: "Sensitive cron update" })).resolves.toMatchObject({
          delivered: true,
        });
        expect(fixture.sendText).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "Redacted cron update" }),
        );
        expect(await fixture.messages(fixture.destination)).toEqual([
          expect.objectContaining({
            content: [{ type: "text", text: "Redacted cron update" }],
          }),
        ]);
        await fixture.assertNoOtherResults();
      } finally {
        await fixture.dispose();
        vi.restoreAllMocks();
        restoreActivePluginRegistrySnapshot(registry);
      }
    });
  });

  it.each([
    { kind: "script", failure: "none" },
    { kind: "command", failure: "none" },
    { kind: "script", failure: "rejected" },
    { kind: "script", failure: "uncertain" },
  ] as const)(
    "adds the $kind result only after confirmed notification (failure=$failure)",
    async ({ kind: payloadKind, failure }) => {
      await withCompletionFixture(payloadKind, async (fixture) => {
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
          await expect(fixture.finalize()).resolves.toMatchObject({
            deliveryAttempted: true,
            delivered: true,
          });
        }

        expect(fixture.sendText).toHaveBeenCalledOnce();
        expect(fixture.sendText.mock.calls[0]?.[0]).toMatchObject({
          to: "123",
          text: `${fixture.text}\nInspect: https://automation.example.test/automations?job=${payloadKind}-job&run=cron%3A${payloadKind}-job%3A1000`,
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
          expect(fixture.warn).toHaveBeenCalledOnce();
        }
        if (failure === "none") {
          await fixture.assertResult();
        } else {
          expect(await fixture.messages(fixture.destination)).toEqual([]);
          if (failure === "uncertain") {
            expect(result).toMatchObject({
              diagnostics: {
                entries: expect.arrayContaining([
                  expect.objectContaining({
                    source: "delivery",
                    severity: "warn",
                    message: "result may have been delivered but was not added to the conversation",
                  }),
                ]),
              },
            });
          }
        }
        await fixture.assertNoOtherResults();
      });
    },
  );

  it("still sends when destination conversation preparation fails", async () => {
    await withCompletionFixture(kind, async (fixture) => {
      vi.spyOn(outboundSession, "bindOutboundSessionEntry").mockRejectedValueOnce(
        new Error("conversation binding unavailable"),
      );

      const result = await fixture.finalize();

      expect(result).toMatchObject({
        delivered: true,
        deliveryError: undefined,
        diagnostics: {
          entries: [
            expect.objectContaining({
              source: "delivery",
              severity: "warn",
              message:
                "result was delivered but was not added to the conversation: conversation binding unavailable",
            }),
          ],
        },
      });
      expect(fixture.sendText).toHaveBeenCalledOnce();
      await fixture.assertNoOtherResults();
      expect(await fixture.messages(fixture.destination)).toEqual([]);
    });
  });

  it("sends a cross-agent destination without writing either conversation", async () => {
    await withCompletionFixture(kind, async (fixture) => {
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
      const otherDestination = {
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

      const result = await fixture.finalize();

      expect(result).toMatchObject({
        delivered: true,
        deliveryError: undefined,
        diagnostics: {
          entries: [
            expect.objectContaining({
              source: "delivery",
              severity: "warn",
              message:
                "Conversation context skipped: the destination belongs to a different agent.",
            }),
          ],
        },
      });
      expect(fixture.sendText).toHaveBeenCalledOnce();
      expect(fixture.sendText.mock.calls[0]?.[0]).toMatchObject({
        to: "123",
        accountId: "default",
      });
      await fixture.assertNoOtherResults();
      expect(await fixture.messages(fixture.destination)).toEqual([]);
      expect(await fixture.messages(otherDestination)).toEqual([]);
    });
  });

  it.each(["deleted", "reset"] as const)(
    "delivers to the explicit destination when the captured source was %s",
    async (change) => {
      await withCompletionFixture(kind, async (fixture) => {
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

        await expect(fixture.finalize()).resolves.toMatchObject({
          deliveryAttempted: true,
          delivered: true,
        });
        expect(fixture.sendText).toHaveBeenCalledOnce();
        await fixture.assertResult();
        await fixture.assertNoOtherResults();
      });
    },
  );

  it("refuses destination output without an occurrence identity", async () => {
    await withCompletionFixture(kind, async (fixture) => {
      await expect(fixture.finalize({ runStartedAtMs: undefined })).resolves.toMatchObject({
        deliveryAttempted: true,
        delivered: false,
        deliveryError: "cron result is missing its occurrence start time",
      });
      expect(fixture.sendText).not.toHaveBeenCalled();
      expect(await fixture.messages(fixture.destination)).toEqual([]);
      await fixture.assertNoOtherResults();
    });
  });

  it("loads and delivers v2026.9.9-shaped jobs without rewriting retained receipts or schema", async () => {
    await withCompletionFixture(kind, async (fixture) => {
      const released = await fixture.loadReleasedRows();

      await expect(fixture.finalize({ job: released.job })).resolves.toMatchObject({
        deliveryAttempted: true,
        delivered: true,
      });
      expect(fixture.sendText).toHaveBeenCalledOnce();
      await fixture.assertResult();
      await fixture.assertNoOtherResults();
      released.assertPreserved();
    });
  });

  it("completes in the source without inheriting the shared main external route", async () => {
    await withCompletionFixture(kind, async (fixture) => {
      fixture.job.delivery = { mode: "announce", channel: "last" };

      await expect(fixture.finalize()).resolves.toMatchObject({
        deliveryAttempted: true,
        delivered: true,
        deliveryState: { status: "delivered" },
      });
      expect(fixture.sendText).not.toHaveBeenCalled();
      await fixture.assertResult(fixture.source);
      await fixture.assertNoOtherResults(fixture.source);
    });
  });

  it.each(["NO_REPLY", "Scheduled report\nNO_REPLY"])(
    "suppresses script control text before committing or adding an inspection link: %s",
    async (text) => {
      await withCompletionFixture("script", async (fixture) => {
        await expect(fixture.finalize({ text })).resolves.toMatchObject({
          delivered: false,
          deliveryAttempted: false,
          deliveryError: undefined,
          deliverySuppressionReason: "silent",
        });
        expect(fixture.sendText).not.toHaveBeenCalled();
        expect(fixture.warn).not.toHaveBeenCalled();
        expect(await fixture.messages(fixture.destination)).toEqual([]);
        await fixture.assertNoOtherResults();
      });
    },
  );

  it.each(["none", "webhook"] as const)(
    "does not write a conversation result for %s delivery",
    async (mode) => {
      await withCompletionFixture(kind, async (fixture) => {
        fixture.job.delivery =
          mode === "webhook" ? { mode, to: "https://receiver.example.test/cron" } : { mode };
        await expect(fixture.finalize()).resolves.toMatchObject({
          deliveryAttempted: false,
          delivered: false,
        });
        expect(fixture.sendText).not.toHaveBeenCalled();
        expect(await fixture.messages(fixture.destination)).toEqual([]);
        await fixture.assertNoOtherResults();
      });
    },
  );

  it("does not commit or notify an aborted occurrence", async () => {
    await withCompletionFixture(kind, async (fixture) => {
      const controller = new AbortController();
      controller.abort(new Error("occurrence aborted"));

      await expect(fixture.finalize({ abortSignal: controller.signal })).resolves.toMatchObject({
        deliveryAttempted: true,
        delivered: false,
        deliveryError: expect.stringContaining("occurrence aborted"),
      });
      expect(fixture.sendText).not.toHaveBeenCalled();
      expect(await fixture.messages(fixture.destination)).toEqual([]);
      await fixture.assertNoOtherResults();
    });
  });

  it.each(["deleted", "cancelled"] as const)(
    "keeps confirmed delivery when transcript preparation loses occurrence authority (%s)",
    async (outcome) => {
      await withCompletionFixture(kind, async (fixture) => {
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
          diagnostics: {
            entries: expect.arrayContaining([
              expect.objectContaining({
                source: "delivery",
                severity: "warn",
                message: expect.stringContaining(
                  "result was delivered but was not added to the conversation: cron delivery owner retired",
                ),
              }),
            ]),
          },
        });
        expect(fixture.sendText).toHaveBeenCalledOnce();
        expect(await fixture.messages(fixture.destination)).toEqual([]);
        await fixture.assertNoOtherResults();
      });
    },
  );
});
