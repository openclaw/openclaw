import { expect, it, vi } from "vitest";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { applySessionEntryOperation } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayLifecycleRuntime } from "./server-instance-runtime.types.js";
import { registerGatewayLifecycleRuntime } from "./server-lifecycle-runtime-context.js";
import { pauseInterruptedShellTurn } from "./session-restart-shell.js";

it.each(["deliver", "replace-marker", "transcript-only"] as const)(
  "guards the original channel, thread and reply before handoff (%s)",
  async (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const db = openOpenClawAgentDatabase({ agentId: "main" });
      const target = { agentId: "main", sessionKey: "agent:main:original", storePath: db.path };
      const runId = "interrupted",
        marker = { sourceRunId: runId };
      writeSessionEntry(db, target.sessionKey, {
        sessionId: "window",
        updatedAt: 1,
        activeWriterRunId: runId,
      });
      await applySessionEntryOperation(target, {
        kind: "fields",
        patch: {
          resumeAfterRestart: marker,
          delivery: {
            kind: "external",
            context: { channel: "telegram", accountId: "fixture", to: "different-chat" },
            route: {
              channel: "telegram",
              accountId: "fixture",
              target: { to: "different-chat", chatType: "direct" },
            },
            origin: { provider: "telegram", accountId: "fixture", to: "different-chat" },
          },
        },
      });
      const route = {
        channel: "telegram",
        to: "original-chat",
        threadId: 7,
        accountId: "fixture",
        replyToId: "original-message",
      };
      const entry = await applySessionEntryOperation(target, {
        kind: "shell-call",
        runId,
        call: { callId: "child", key: "private-receipt" },
        notice: route,
      });
      expect(entry?.delivery).toMatchObject({
        kind: "external",
        context: { to: "different-chat" },
      });
      expect(entry?.pendingShellCalls?.notice).toEqual(route);
      const handedOff: string[] = [];
      const sendNotice: GatewayLifecycleRuntime["sendNotice"] = async (notice) => {
        expect(notice).toMatchObject(route);
        if (mode === "replace-marker") {
          await applySessionEntryOperation(target, {
            kind: "fields",
            patch: { resumeAfterRestart: { sourceRunId: "another-run" } },
          });
        }
        notice.isCurrent?.({});
        handedOff.push(notice.to);
        return { suppressed: false };
      };
      const unexpected = vi.fn(async () => {
        throw new Error("Unexpected model dispatch");
      });
      const release = registerGatewayLifecycleRuntime({
        dispatchSessionMethod: unexpected,
        dispatchAgent: unexpected,
        waitForAgent: unexpected,
        sendNotice,
      });
      try {
        const paused = pauseInterruptedShellTurn({
          target,
          marker,
          entry: entry!,
          assertCurrent() {},
          transcriptOnly: mode === "transcript-only",
        });
        if (mode !== "replace-marker") {
          await expect(paused).resolves.toBe(true);
          expect(handedOff).toEqual(mode === "deliver" ? ["original-chat"] : []);
          expect(
            (await readSessionEntryReadOnlyInWorker(target))?.resumeAfterRestart,
          ).toBeUndefined();
        } else {
          await expect(paused).rejects.toThrow();
          expect(handedOff).toEqual([]);
          expect(
            (await readSessionEntryReadOnlyInWorker(target))?.resumeAfterRestart?.sourceRunId,
          ).toBe("another-run");
        }
        expect(unexpected).not.toHaveBeenCalled();
      } finally {
        release();
      }
    }),
);
