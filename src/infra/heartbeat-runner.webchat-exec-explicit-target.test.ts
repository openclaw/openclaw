import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  readSessionStoreForTest,
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import * as sessionPublication from "./heartbeat-session-publication.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

// A command started from an internal (WebChat) session belongs to that session. An
// explicit heartbeat target (a channel for heartbeat chatter, cadence disabled) must
// not capture the session-owned completion reply, and ordinary heartbeat output and
// mixed batches must keep using that target.
describe("exec completion from a WebChat session with an explicit heartbeat target", () => {
  beforeEach(() => setupTelegramHeartbeatPluginRuntimeForTests());
  afterEach(() => {
    vi.restoreAllMocks();
    resetSystemEventsForTest();
    resetHeartbeatEventsForTest();
  });

  it("publishes into the WebChat session and does not send to the heartbeat channel", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const marker = "WEBCHAT_EXEC_COMPLETION_STAYS_HOME";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "0m", target: "telegram", to: "-100999000111" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        messages: { visibleReplies: "message_tool" },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
        sessionId: "webchat-exec-session",
        lifecycleRevision: "webchat-exec-generation",
        createdVia: "operator",
      });
      enqueueSystemEvent("Exec completed (bg-cmd, code 0) :: " + marker, { sessionKey });
      const sendTelegram = vi
        .fn()
        .mockResolvedValue({ messageId: "leaked", chatId: "-100999000111" });
      const reply = vi.fn().mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: true,
          summary: "private",
          notificationText: marker,
        }),
      );
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig: reply, telegram: sendTelegram },
      });
      expect(result.status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      expect(
        sendTelegram,
        "session-owned completion leaked to the heartbeat channel",
      ).not.toHaveBeenCalled();
      const entry = readSessionStoreForTest(storePath)[sessionKey];
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionKey,
        sessionId: entry!.sessionId!,
        storePath,
      });
      const published = events
        .map(readTranscriptEventMessage)
        .filter((m) => m?.role === "assistant" && JSON.stringify(m.content).includes(marker));
      expect(published).toHaveLength(1);
    });
  });

  it("still sends a genuine heartbeat poll to the explicit heartbeat channel", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "telegram", to: "-100999000111" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
        createdVia: "operator",
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "hb", chatId: "-100999000111" });
      const reply = vi.fn().mockResolvedValue({ text: "Heartbeat alert: disk 95%" });
      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "manual",
        intent: "immediate",
        reason: "wake",
        deps: { getReplyFromConfig: reply, telegram: sendTelegram },
      });
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(await publishedAssistantTexts(storePath, sessionKey, "Heartbeat alert")).toHaveLength(
        0,
      );
    });
  });

  it("keeps the explicit target for a batch that mixes an exec completion with another event", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const marker = "MIXED_BATCH_USES_HEARTBEAT_TARGET";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "0m", target: "telegram", to: "-100999000111" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
        createdVia: "operator",
      });
      enqueueSystemEvent("Exec completed (bg-cmd, code 0) :: done", { sessionKey });
      enqueueSystemEvent("Reminder: rotate the backup disk", { sessionKey });
      const sendTelegram = vi
        .fn()
        .mockResolvedValue({ messageId: "mixed", chatId: "-100999000111" });
      const reply = vi.fn().mockResolvedValue({ text: marker });
      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig: reply, telegram: sendTelegram },
      });
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(sendTelegram.mock.calls[0])).toContain(marker);
    });
  });

  it("publishes a restart continuation into the WebChat session, not the heartbeat channel", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const marker = "RESTART_CONTINUATION_STAYS_HOME";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "0m", target: "telegram", to: "-100999000111" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        messages: { visibleReplies: "message_tool" },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
        sessionId: "webchat-restart-session",
        lifecycleRevision: "webchat-restart-generation",
        createdVia: "operator",
      });
      enqueueSystemEvent("Gateway restarted. Continue the interrupted turn.", {
        sessionKey,
        contextKey: "task:restart-sentinel:queue-1",
      });
      const sendTelegram = vi
        .fn()
        .mockResolvedValue({ messageId: "leaked", chatId: "-100999000111" });
      const reply = vi.fn().mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: true,
          summary: "private",
          notificationText: marker,
        }),
      );
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "restart-sentinel",
        intent: "immediate",
        reason: "wake",
        deps: { getReplyFromConfig: reply, telegram: sendTelegram },
      });
      expect(result.status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      expect(
        sendTelegram,
        "restart continuation leaked to the heartbeat channel",
      ).not.toHaveBeenCalled();
      expect(await publishedAssistantTexts(storePath, sessionKey, marker)).toHaveLength(1);
    });
  });

  it.each(["rejected write", "thrown write", "failed model"] as const)(
    "retains a restart occurrence after %s and settles only the successful retry",
    async (failure) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
        setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
        const marker = "RESTART_RETRY_COMMITTED";
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: { every: "0m", target: "telegram", to: "-100999000111" },
            },
          },
          channels: { telegram: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        const sessionKey = await seedMainSessionStore(storePath, cfg, {
          lastChannel: "webchat",
          lastProvider: "",
          lastTo: "",
          sessionId: "restart-retry-session",
          lifecycleRevision: "restart-retry-generation",
          createdVia: "operator",
        });
        const continuation = "Gateway restarted. Continue the interrupted turn.";
        enqueueSystemEvent(continuation, {
          sessionKey,
          contextKey: "task:restart-sentinel:retry-1",
        });
        const captured = peekSystemEventEntries(sessionKey);
        const sendTelegram = vi
          .fn()
          .mockResolvedValue({ messageId: "leaked", chatId: "-100999000111" });
        const publish = vi.spyOn(sessionPublication, "publishHeartbeatSessionReply");
        if (failure === "rejected write") {
          publish.mockResolvedValueOnce({ ok: false, reason: "injected write rejection" });
        } else if (failure === "thrown write") {
          publish.mockRejectedValueOnce(new Error("injected write failure"));
        }
        const reply = vi.fn().mockImplementation(async (_ctx, options) => {
          const context = getReplySystemEventContext(options);
          // Exercise real admission: previous tests injected a reply without formatting
          // generic events, which hid the pre-publication drain.
          const block = await drainFormattedSystemEvents({
            cfg,
            agentId: "main",
            sessionKey,
            isMainSession: false,
            isNewSession: false,
            events: context?.events ?? [],
            deferredEventIds: context?.deferredEventIds,
          });
          expect(block).toContain(continuation);
          if (failure === "failed model" && reply.mock.calls.length === 1) {
            throw new Error("injected model failure after admission");
          }
          return createHeartbeatToolResponsePayload({
            outcome: "done",
            notify: true,
            summary: "private",
            notificationText: marker,
          });
        });
        const run = () =>
          runHeartbeatOnce({
            cfg,
            agentId: "main",
            sessionKey,
            source: "restart-sentinel",
            intent: "immediate",
            reason: "wake",
            deps: { getReplyFromConfig: reply, telegram: sendTelegram },
          });
        await run();
        expect(publish).toHaveBeenCalledTimes(failure === "failed model" ? 0 : 1);
        expect(peekSystemEventEntries(sessionKey).map((event) => event.id)).toEqual(
          captured.map((event) => event.id),
        );
        expect(await publishedAssistantTexts(storePath, sessionKey, marker)).toHaveLength(0);
        expect(sendTelegram).not.toHaveBeenCalled();
        await run();
        expect(reply).toHaveBeenCalledTimes(2);
        expect(publish).toHaveBeenCalledTimes(failure === "failed model" ? 1 : 2);
        expect(await publishedAssistantTexts(storePath, sessionKey, marker)).toHaveLength(1);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        expect(sendTelegram).not.toHaveBeenCalled();
      });
    },
  );

  it("keeps the explicit target when a restart wake carries an untagged event", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const marker = "UNTAGGED_WAKE_USES_HEARTBEAT_TARGET";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "0m", target: "telegram", to: "-100999000111" },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
        createdVia: "operator",
      });
      enqueueSystemEvent("Reminder: rotate the backup disk", { sessionKey });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "hb", chatId: "-100999000111" });
      const reply = vi.fn().mockResolvedValue({ text: marker });
      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        source: "restart-sentinel",
        intent: "immediate",
        reason: "wake",
        deps: { getReplyFromConfig: reply, telegram: sendTelegram },
      });
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(sendTelegram.mock.calls[0])).toContain(marker);
    });
  });
});

async function publishedAssistantTexts(storePath: string, sessionKey: string, needle: string) {
  const entry = readSessionStoreForTest(storePath)[sessionKey];
  if (!entry?.sessionId) {
    return [];
  }
  const events = await loadTranscriptEvents({
    agentId: "main",
    sessionKey,
    sessionId: entry.sessionId,
    storePath,
  });
  return events
    .map(readTranscriptEventMessage)
    .filter((m) => m?.role === "assistant" && JSON.stringify(m.content).includes(needle));
}
