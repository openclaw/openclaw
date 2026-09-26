// Pins which production callers the durable follow-up queue actually recovers.
//
// The queue deliberately excludes work another durable owner already holds:
// exclusive channel ingress, pending-input receipts, and sender-bound channel
// turns. What remains is system-provenance `chat.send` work, which skips
// pending-input staging precisely because its provenance is not
// `external_user`. Two production callers build that request today —
// `session-recovery-continuation.ts` (`sourceTool: "sessions.recover"`) and
// `talk-agent-consult.ts` (the realtime-voice consult tool) — so this file
// keeps the residual population named and non-empty.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { followupQueueEntryContainsPrompt } from "../../../infra/followup-queue-sqlite.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  clearFollowupQueuesRestoredFlagForTest,
  clearRestoredPendingDrainKeysForTest,
  persistFollowupQueuesOrThrow,
  restoreFollowupQueues,
} from "./persist.js";
import {
  FOLLOWUP_PERSIST_TEST_KEY as TEST_KEY,
  FOLLOWUP_PERSIST_TEST_SETTINGS as SETTINGS,
  createFollowupPersistTestItem as makeFollowupRun,
} from "./persist.test-helpers.js";
import { FOLLOWUP_QUEUES, getFollowupQueue } from "./state.js";
import type { FollowupRun } from "./types.js";

function prompts(items: readonly FollowupRun[] | undefined): string[] {
  return (items ?? []).map((item) => item.prompt);
}

/**
 * The shape both production system-provenance callers produce: a cancel-only
 * Gateway adoption lifecycle, no channel sender identity, and no pending-input
 * receipt, because `chat-send-handler.ts` only stages approved input when the
 * provenance is absent or `external_user`.
 */
function systemProvenanceRun(prompt: string, sourceTool: string): FollowupRun {
  const item = makeFollowupRun(prompt);
  return {
    ...item,
    turnAdoptionLifecycle: { admission: "cancel-only", onAdopted: () => {} },
    run: {
      ...item.run,
      inputProvenance: { kind: "internal_system", sourceTool },
    },
  };
}

/** An ordinary operator chat.send: staged approved input leaves a receipt owner. */
function externalUserRun(prompt: string): FollowupRun {
  const item = makeFollowupRun(prompt);
  return {
    ...item,
    turnAdoptionLifecycle: { admission: "cancel-only", onAdopted: () => {} },
    run: { ...item.run, inputProvenance: { kind: "external_user" } },
    userTurnTranscriptRecorder: {
      getPendingInputMessage: () => ({ role: "user", content: prompt }),
    } as unknown as FollowupRun["userTurnTranscriptRecorder"],
  };
}

describe("durable follow-up residual production callers", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-residual-caller-");
    FOLLOWUP_QUEUES.clear();
    clearRestoredPendingDrainKeysForTest();
    clearFollowupQueuesRestoredFlagForTest();
    clearRuntimeConfigSnapshot();
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    FOLLOWUP_QUEUES.clear();
    clearFollowupQueuesRestoredFlagForTest();
    clearRuntimeConfigSnapshot();
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalEnv;
    }
  });

  it.each([
    ["sessions.recover", "session-recovery-continuation"],
    ["realtime_voice_agent_consult", "talk-agent-consult"],
  ])(
    "recovers %s work, the residual population this queue exists for",
    async (sourceTool, label) => {
      const queue = await getFollowupQueue(TEST_KEY, SETTINGS);
      queue.items.push(systemProvenanceRun(`${label} turn`, sourceTool));
      await persistFollowupQueuesOrThrow();

      expect(await followupQueueEntryContainsPrompt(TEST_KEY, `${label} turn`)).toBe(true);

      FOLLOWUP_QUEUES.delete(TEST_KEY);
      clearFollowupQueuesRestoredFlagForTest();
      await restoreFollowupQueues();

      const restored = FOLLOWUP_QUEUES.get(TEST_KEY);
      expect(prompts(restored?.items)).toEqual([`${label} turn`]);
      // Provenance survives as the closed non-authoritative descriptor.
      expect(restored?.items[0]?.run.inputProvenance).toEqual({
        kind: "internal_system",
        sourceTool,
      });
    },
  );

  it("leaves an operator chat.send to its pending-input receipt owner", async () => {
    const queue = await getFollowupQueue(TEST_KEY, SETTINGS);
    queue.items.push(
      externalUserRun("operator turn"),
      systemProvenanceRun("system turn", "sessions.recover"),
    );
    await persistFollowupQueuesOrThrow();

    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "operator turn")).toBe(false);
    expect(await followupQueueEntryContainsPrompt(TEST_KEY, "system turn")).toBe(true);

    FOLLOWUP_QUEUES.delete(TEST_KEY);
    clearFollowupQueuesRestoredFlagForTest();
    await restoreFollowupQueues();
    expect(prompts(FOLLOWUP_QUEUES.get(TEST_KEY)?.items)).toEqual(["system turn"]);
  });
});
