// karmaterminal/openclaw#1271: an incognito session has no recipient authority, so a delegate it
// elects fails visibly before any record exists. A fanout binds its recipients later, at spawn and
// return, and once skipped the capture that refuses a default return: an incognito post-compaction
// tree/all election was accepted, and its release wrote a durable row addressed to the session.
// Real: the continue_delegate tool, the custody store, the compaction seam's claim and release, the
// delivery drain, and the pending-row reader session maintenance uses. Observed only: the spawn.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createContinueDelegateTool } from "../../agents/tools/continue-delegate-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { listPendingContinuationSessionDeliveryKeys } from "../../infra/session-delivery-queue-storage.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { drainPostCompactionDelegateDeliveries } from "../reply/post-compaction-delegate-dispatch.js";
import {
  listCustodyRecordsForTest,
  useContinuationCustodyTestState,
} from "./custody/custody.test-support.js";
import {
  consumeStagedPostCompactionDelegates,
  releaseStagedPostCompactionDelegateToQueue,
} from "./delegate-store-post-compaction.js";

const spawnSubagentDirect = vi.hoisted(() => vi.fn());
// mock-isolation: the drain's spawn owner is observed without starting a subagent run.
vi.mock("../../agents/subagents/spawn/subagent-spawn.js", () => ({ spawnSubagentDirect }));

useContinuationCustodyTestState();
beforeEach(() => {
  setRuntimeConfigSnapshot({
    agents: { defaults: { continuation: { enabled: true, crossSessionTargeting: "enabled" } } },
  });
  spawnSubagentDirect.mockReset().mockResolvedValue({ status: "accepted" });
});
afterEach(() => closeOpenClawAgentDatabasesForTest());

/** The compaction seam: claim the staged delegates, release each to the queue, then drain it. */
async function compact(sessionKey: string, source?: { sessionId: string }) {
  const claimed = await consumeStagedPostCompactionDelegates(sessionKey);
  for (const [sequence, delegate] of claimed.entries()) {
    const released = await releaseStagedPostCompactionDelegateToQueue({
      sessionKey,
      sourceSessionId: source?.sessionId,
      sourceLifecycleRevision: source?.sessionId,
      delegate,
      sequence,
      compactionCount: 1,
    });
    expect(released).toMatchObject({ released: true });
  }
  const rows = await listPendingContinuationSessionDeliveryKeys(
    captureOpenClawStateWorkerContext(),
  );
  await drainPostCompactionDelegateDeliveries({ sessionKey });
  return { claimed, rows: rows ?? [] };
}

it.each([
  ["post-compaction", undefined],
  ["post-compaction", "tree"],
  ["post-compaction", "all"],
  ["normal", "tree"],
  ["normal", "all"],
] as const)(
  "refuses an incognito %s election (fanout %s) and leaves nothing",
  async (mode, fanoutMode) => {
    const sessionKey = `agent:main:dashboard:incognito-${mode}-${fanoutMode ?? "default"}`;
    const tool = createContinueDelegateTool({ agentSessionKey: sessionKey });
    await expect(
      tool.execute("call", { task: "carry state", mode, ...(fanoutMode ? { fanoutMode } : {}) }),
    ).rejects.toThrow("Incognito collaboration command requires its dedicated owner");
    expect(await listCustodyRecordsForTest()).toEqual([]);
    expect(await compact(sessionKey)).toEqual({ claimed: [], rows: [] });
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  },
);

it.each(["tree", "all"] as const)(
  "elects, releases and delivers a durable session's post-compaction %s fanout",
  async (fanoutMode) => {
    const sessionKey = `agent:main:durable-${fanoutMode}`;
    const source = { sessionId: `session-${fanoutMode}` };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { ...source, lifecycleRevision: source.sessionId, updatedAt: Date.now() },
    );
    const tool = createContinueDelegateTool({ agentSessionKey: sessionKey });
    const result = await tool.execute("call", {
      task: "carry state",
      mode: "post-compaction",
      fanoutMode,
    });
    expect(result.details).toMatchObject({ status: "queued-for-compaction", fanoutMode });
    const { claimed, rows } = await compact(sessionKey, source);
    expect(claimed).toHaveLength(1);
    expect(rows).toEqual([sessionKey]);
    expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);
    expect(spawnSubagentDirect.mock.calls[0]?.[0]).toMatchObject({
      task: expect.stringContaining("carry state"),
      continuationFanoutMode: fanoutMode,
      continuationRecipientAuthorityBinding: { version: 1, selection: "pending", fanoutMode },
    });
  },
);
