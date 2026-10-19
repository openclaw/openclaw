import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  listSessionEntriesReadOnly,
  loadExactSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { claimHeartbeatOutcomeForRun } from "./heartbeat-outcome-store.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { withTempTelegramHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { resetSystemEventsForTest } from "./system-events.js";

installHeartbeatRunnerTestRuntime();

describe("heartbeat next-user outcomes", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    resetSystemEventsForTest();
  });

  it.each([
    { sessionKey: "agent:ops:main", runKey: "agent:ops:main:heartbeat", isolatedSession: true },
    { sessionKey: "global", runKey: "global", isolatedSession: false },
  ])(
    "retains the next-user outcome in the owning agent store: $runKey",
    async ({ sessionKey, runKey, isolatedSession }) => {
      await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const scope = { agentId: "ops", storePath, sessionKey };
        const mainScope = { agentId: "main", storePath };
        const readEntry = (key: string) =>
          loadExactSessionEntryReadOnly({ ...scope, sessionKey: key })?.entry;
        const cfg: OpenClawConfig = {
          agents: {
            entries: { main: {}, ops: {} },
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                isolatedSession,
                session: sessionKey,
                target: "telegram",
                to: "12345",
              },
            },
          },
          messages: { visibleReplies: "message_tool" },
          channels: { telegram: { enabled: true, botToken: "test", allowFrom: ["*"] } },
          session: { store: storePath, ...(!isolatedSession ? { scope: "global" } : {}) },
        };
        if (!isolatedSession) {
          await replaceSessionEntry(scope, {
            sessionId: "existing-user-session",
            updatedAt: Date.now(),
          });
        } else {
          expect(readEntry(sessionKey)).toBeUndefined();
        }
        await replaceSessionEntry(
          { ...mainScope, sessionKey: "global" },
          {
            sessionId: "unrelated-main-global",
            updatedAt: Date.now(),
            delivery: normalizeSessionDeliveryState({
              context: { channel: "telegram", to: "-10099999" },
            }),
          },
        );
        const initialMainEntries = listSessionEntriesReadOnly(mainScope);
        const summary = `Quiet work completed in ${runKey}`;
        replySpy.mockResolvedValue(
          createHeartbeatToolResponsePayload({ outcome: "done", notify: false, summary }),
        );
        const sendTelegram = vi.fn();
        expect(
          await runHeartbeatOnce({
            cfg,
            agentId: "ops",
            sessionKey,
            deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
          }),
        ).toMatchObject({ status: "ran" });
        expect(sendTelegram).not.toHaveBeenCalled();
        expect(readEntry(sessionKey)?.sessionId).toBeTruthy();
        if (isolatedSession) {
          expect(readEntry(sessionKey)?.sessionId).not.toBe(readEntry(runKey)?.sessionId);
          expect(readEntry(runKey)?.heartbeatIsolatedBaseSessionKey).toBe(sessionKey);
        } else {
          expect(readEntry(sessionKey)?.sessionId).toBe("existing-user-session");
        }
        const params = { ...scope, runId: "first-user-run" };
        expect(await claimHeartbeatOutcomeForRun(params)).toMatchObject({
          sessionKey,
          runSessionKey: runKey,
          summary,
        });
        expect(await claimHeartbeatOutcomeForRun(params)).toBeDefined();
        expect(
          await claimHeartbeatOutcomeForRun({ ...params, runId: "second-user-run" }),
        ).toBeUndefined();
        expect(listSessionEntriesReadOnly(mainScope)).toEqual(initialMainEntries);
      });
    },
  );
});
