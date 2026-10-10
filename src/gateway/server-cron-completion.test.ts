import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import {
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import type { CronStoredJob } from "../cron/types.js";
import { getChildLogger } from "../logging.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { finalizeCronCompletionAnnouncement } from "./server-cron-completion.js";

async function createCompletionFixture(state: OpenClawTestState, kind: "script" | "command") {
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
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    session: { store: storePath },
    gateway: { publicOrigin: "https://automation.example.test" },
  };
  const sendText = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>().mockResolvedValue({
    channel: "telegram",
    messageId: "notification-message",
  });
  setActivePluginRegistry(
    createTestRegistry([
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
    ]),
  );
  const logger = getChildLogger({ module: "cron-completion-test" });
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const text = kind === "script" ? "Script finished" : "Command finished";
  const messages = async (scope = source) =>
    (await loadTranscriptEvents(scope))
      .map(readTranscriptEventMessage)
      .filter((message) => message?.role === "assistant");
  const assertSourceResult = async () => {
    expect(await messages()).toEqual([
      expect.objectContaining({
        content: [{ type: "text", text }],
        model: "automation-result",
        openclawAutomation: { kind: "cron", jobId: job.id, runId: `cron:${job.id}:1000` },
      }),
    ]);
  };
  const assertNoOtherResults = async () => {
    for (const scope of otherScopes) {
      expect(await messages(scope)).toEqual([]);
    }
  };
  const finalize = (
    overrides: Partial<Parameters<typeof finalizeCronCompletionAnnouncement>[0]> = {},
  ) =>
    finalizeCronCompletionAnnouncement({
      deliveryAttemptFence: null,
      job,
      text,
      runStartedAtMs: 1000,
      deps: {},
      resolveCronAgent: () => ({ agentId: "main", cfg }),
      logger,
      label: kind,
      ...overrides,
    });
  return {
    source,
    job,
    text,
    sendText,
    warn,
    messages,
    assertSourceResult,
    assertNoOtherResults,
    finalize,
  };
}

async function withCompletionFixture(
  kind: "script" | "command",
  run: (fixture: Awaited<ReturnType<typeof createCompletionFixture>>) => Promise<void>,
) {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const registry = captureActivePluginRegistrySnapshot();
    try {
      await run(await createCompletionFixture(state, kind));
    } finally {
      vi.restoreAllMocks();
      restoreActivePluginRegistrySnapshot(registry);
    }
  });
}

// Exercise the shared Gateway completion entry point with real conversation persistence,
// target resolution, and durable notification delivery. Only the channel I/O is synthetic.
// Command execution and script evaluation belong to their respective runner suites.
for (const kind of ["script", "command"] as const) {
  describe(`${kind} completion announcement`, () => {
    it.each([false, true])("commits the source before notification (failure=%s)", async (fails) => {
      await withCompletionFixture(kind, async (fixture) => {
        fixture.sendText.mockImplementation(async () => {
          await fixture.assertSourceResult();
          if (fails) {
            throw new Error("notification rejected");
          }
          return { channel: "telegram", messageId: "notification-message" };
        });

        const result = await fixture.finalize();

        expect(fixture.sendText).toHaveBeenCalledOnce();
        expect(fixture.sendText.mock.calls[0]?.[0]).toMatchObject({
          to: "123",
          text: `${fixture.text}\nInspect: https://automation.example.test/automations?job=${kind}-job&run=cron%3A${kind}-job%3A1000`,
        });
        expect(result).toMatchObject({ deliveryAttempted: true, delivered: !fails });
        if (fails) {
          expect(result).toMatchObject({
            deliveryError: expect.stringContaining("notification rejected"),
            deliveryState: { status: "not-delivered" },
          });
          expect(fixture.warn).toHaveBeenCalledOnce();
        }
        await fixture.assertSourceResult();
        await fixture.assertNoOtherResults();
      });
    });

    it.each(["deleted", "reset"] as const)(
      "refuses notification when the captured source was %s",
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
            delivered: false,
            deliveryError: expect.stringContaining("session rebound"),
          });
          expect(fixture.sendText).not.toHaveBeenCalled();
          expect(await fixture.messages()).toEqual([]);
          await fixture.assertNoOtherResults();
        });
      },
    );

    it("refuses source-bound output without an occurrence identity", async () => {
      await withCompletionFixture(kind, async (fixture) => {
        await expect(fixture.finalize({ runStartedAtMs: undefined })).resolves.toMatchObject({
          deliveryAttempted: true,
          delivered: false,
          deliveryError: "cron result is missing its occurrence start time",
        });
        expect(fixture.sendText).not.toHaveBeenCalled();
        expect(await fixture.messages()).toEqual([]);
        await fixture.assertNoOtherResults();
      });
    });

    it("keeps legacy unbound jobs external-only", async () => {
      await withCompletionFixture(kind, async (fixture) => {
        delete fixture.job.sourceConversation;

        await expect(fixture.finalize()).resolves.toMatchObject({
          deliveryAttempted: true,
          delivered: true,
        });
        expect(fixture.sendText).toHaveBeenCalledOnce();
        expect(await fixture.messages()).toEqual([]);
        await fixture.assertNoOtherResults();
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
        await fixture.assertSourceResult();
        await fixture.assertNoOtherResults();
      });
    });

    it("uses explicit channel coordinates only for the notification", async () => {
      await withCompletionFixture(kind, async (fixture) => {
        fixture.job.delivery = {
          mode: "announce",
          channel: "telegram",
          to: "123",
          accountId: "work",
          threadId: 17,
        };

        await expect(fixture.finalize()).resolves.toMatchObject({ delivered: true });
        expect(fixture.sendText).toHaveBeenCalledOnce();
        expect(fixture.sendText.mock.calls[0]?.[0]).toMatchObject({
          to: "123",
          accountId: "work",
          threadId: 17,
        });
        await fixture.assertSourceResult();
        await fixture.assertNoOtherResults();
      });
    });

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
        expect(await fixture.messages()).toEqual([]);
        await fixture.assertNoOtherResults();
      });
    });
  });
}
