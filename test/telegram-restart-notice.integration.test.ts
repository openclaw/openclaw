import { expect, it } from "vitest";
import { loadTelegramDispatchHttpFixture } from "../extensions/telegram/test-api.js";
import { createAgentRunRestartAbortError } from "../src/agents/run-termination.js";
import { replaceSessionEntrySync } from "../src/config/sessions/session-accessor.sqlite-entry.js";
import { readSessionTranscriptStartAsync } from "../src/config/sessions/session-transcript-watermark.js";
import { persistRunningSessionsForRestart } from "../src/gateway/session-restart-resume.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../src/infra/agent-run-registry.js";
import { readLatestAssistantTextByIdentity } from "../src/plugin-sdk/session-transcript-runtime.js";

const { createTelegramDispatchHttpFixture } = await loadTelegramDispatchHttpFixture();
const http = createTelegramDispatchHttpFixture();
const restartNotice = "Restarting. I'll finish this reply when I'm back.";
const failureNotice = "I couldn't deliver my reply. Please ask again.";

it.each([
  { saved: "this run", restart: true, mode: "off", notice: restartNotice },
  { saved: "this run", restart: true, mode: "progress", notice: restartNotice },
  { saved: "before final", restart: true, mode: "off", notice: restartNotice },
  { saved: "silent before final", restart: true, mode: "off", notice: undefined },
  { saved: "nothing", restart: true, mode: "off", notice: failureNotice },
  { saved: "nothing", restart: false, mode: "off", notice: failureNotice },
  { saved: "another run", restart: true, mode: "off", notice: failureNotice },
  { saved: "this run", restart: false, mode: "off", notice: failureNotice },
] as const)(
  "settles Telegram once with $saved saved (restart: $restart, $mode)",
  async ({ saved, restart, mode, notice }) => {
    const context = http.createContext();
    const target = {
      agentId: context.route.agentId,
      sessionKey: context.route.sessionKey,
      sessionId: "telegram-interrupted",
      storePath: context.turn.storePath,
    };
    const runId = "telegram-interrupted-run";
    const savedRun = saved === "another run" ? "unrelated-run" : runId;
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: Date.now(),
      lifecycleRunId: savedRun,
    });
    const transcriptStart = await readSessionTranscriptStartAsync(target);
    const answer = "Answer that Telegram did not accept";
    http.respondToCall = (call) =>
      call.fields.text === answer
        ? { error_code: 400, description: "Bad Request: test delivery rejected" }
        : undefined;
    await http.dispatchProgressTurn(async () => {}, {
      context,
      mode,
      toolProgress: true,
      allowErrors: true,
      suppressFailureFallback: true,
      telegramCfg: saved === "silent before final" ? { errorPolicy: "silent" } : undefined,
      producer: async ({ cfg, replyOptions, dispatcher }) => {
        await replyOptions?.onPreparedAgentRunStart?.({ runId, transcriptStart });
        if (mode === "progress") {
          await http.emitToolStart(replyOptions, {
            name: "read",
            toolCallId: "reading",
            phase: "start",
          });
          await http.waitForBotApiCall((call) => call.method === "sendMessage");
        }
        if (saved !== "nothing") {
          const claim = claimAgentRunContext(savedRun, target, {
            trackOwner: true,
            ownsContext: true,
          });
          try {
            await persistRunningSessionsForRestart({ cfg });
          } finally {
            releaseAgentRunContext(savedRun, claim);
          }
        }
        if (saved === "before final" || saved === "silent before final") {
          throw createAgentRunRestartAbortError();
        }
        // A shutdown can interrupt the producer while a rejected final settles.
        const queuedFinal = dispatcher.sendFinalReply({ text: answer });
        await dispatcher.waitForIdle();
        if (restart) {
          throw createAgentRunRestartAbortError();
        }
        return { queuedFinal, counts: dispatcher.getQueuedCounts() };
      },
    });
    expect(http.texts()).toEqual(notice ? [notice] : []);
    expect(http.acceptedFor("sendMessage")).toHaveLength(notice ? 1 : 0);
    if (notice === restartNotice) {
      expect((await readLatestAssistantTextByIdentity(target))?.text).not.toBe(restartNotice);
    }
  },
);
