// Full-chain regression for issue #137214: a restart-recovery tombstone raised
// by real reply-turn admission at the head of an ordered ingress lane must be
// dead-lettered by the shared ingress retry policy so the queued reset command
// behind it reaches session admission. The dispatch below mirrors the production
// wiring (reset classification + admission) from
// src/auto-reply/reply/dispatch-from-config.lifecycle.ts.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { testing } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { admitReplyTurn } from "../../auto-reply/reply/reply-turn-admission.js";
import { resolveAuthorizedSessionResetCommand } from "../../auto-reply/reply/session-reset-command.js";
import {
  SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE,
  isRestartRecoveryTombstone,
} from "../../config/sessions/lifecycle.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type RawEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetGatewayWorkAdmission();
  testing.resetReplyRunRegistry();
  closeOpenClawStateDatabaseForTest();
});

describe("channel ingress tombstone admission trace", () => {
  it("dead-letters a real admission tombstone so the queued reset command is admitted", async () => {
    const stateDir = tempDirs.make("openclaw-ingress-tombstone-admission-");
    const sessionKey = "agent:main:telegram:direct:80085";
    // The gateway keeps session entries next to the shared state database; the
    // sqlite-backed accessor resolves this handle to the per-agent DB.
    const storePath = path.join(stateDir, "sessions.json");
    replaceSessionEntrySync({ sessionKey, storePath }, {
      sessionId: "tombstoned-session",
      updatedAt: 100,
      status: "failed",
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 4,
        chargedAttempts: 3,
        tombstone: { reason: "automatic recovery exhausted" },
      },
    } as SessionEntry);
    expect(isRestartRecoveryTombstone(loadSessionEntry({ sessionKey, storePath }))).toBe(true);

    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "telegram",
      accountId: "bot",
      stateDir,
    });
    const admissions: Array<{ id: string; status: string; error?: { code?: string } }> = [];
    const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
      // Channel dispatch boundary: classify the inbound command exactly like
      // dispatch-from-config.lifecycle.ts, then admit through the real
      // reply-turn admission used by gateway channel dispatch.
      deliver: async (raw) => {
        const ctx = finalizeInboundContext({
          Body: raw.text,
          CommandBody: raw.text,
          CommandSource: "text",
          From: "telegram:80085",
          To: "telegram:bot",
          ChatType: "direct",
          Provider: "telegram",
          Surface: "telegram",
          CommandAuthorized: true,
        });
        const { resetCommand } = resolveAuthorizedSessionResetCommand({
          agentId: "main",
          cfg: {} as OpenClawConfig,
          commandAuthorized: true,
          ctx,
          isGroup: false,
        });
        const resetTriggered = resetCommand.matchedResetTriggerLower !== undefined;
        const entry = loadSessionEntry({ sessionKey, storePath });
        try {
          const admission = await admitReplyTurn({
            sessionKey,
            sessionId: entry?.sessionId ?? "",
            expectedSessionId: entry?.sessionId,
            storePath,
            kind: "visible",
            resetTriggered,
            allowRestartTombstoneReset: resetTriggered && isRestartRecoveryTombstone(entry),
          });
          if (admission.status === "owned") {
            admissions.push({ id: raw.id, status: admission.status });
            admission.operation.complete();
          } else {
            admissions.push({ id: raw.id, status: `skipped:${admission.reason}` });
          }
        } catch (error) {
          admissions.push({
            id: raw.id,
            status: "rejected",
            error: { code: (error as { code?: string }).code },
          });
          throw error;
        }
      },
      pollIntervalMs: 10,
      retention: { pruneIntervalMs: 60_000 },
      drain: {
        adoptionStallTimeoutMs: 5_000,
        retryPolicy: { baseMs: 1_000, maxMs: 1_000 },
        resolveNonRetryableFailure: () => null,
      },
    });

    monitor.start();
    await monitor.admit({ id: "evt-question", lane: "dm", text: "please answer" });
    await monitor.admit({ id: "evt-new", lane: "dm", text: "/new" });
    await monitor.waitForIdle();
    await monitor.stop();

    // The head message was rejected by real admission with the stable
    // tombstone code, and the shared retry policy dead-lettered it on the
    // first failure instead of keeping it at the lane head.
    expect(admissions.find((entry) => entry.id === "evt-question")).toMatchObject({
      status: "rejected",
      error: { code: SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE },
    });
    expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
      { id: "evt-question", reason: "restart-recovery-tombstone" },
    ]);
    // The queued reset command behind the dead-lettered head reached session
    // admission and was owned as an authorized restart-tombstone reset.
    expect(admissions.find((entry) => entry.id === "evt-new")).toMatchObject({
      status: "owned",
    });
    expect(await queue.listPending({ limit: "all" })).toEqual([]);
    expect(admissions.map((entry) => entry.id)).toEqual(["evt-question", "evt-new"]);
  });
});
