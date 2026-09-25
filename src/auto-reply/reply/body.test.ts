import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  claimMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getAbortMemory, setAbortMemory } from "./abort-primitives.js";
import { applySessionHints } from "./body.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("applySessionHints", () => {
  it("preserves interrupted work for recovery when a prepared foreground turn cannot start", async () => {
    const storePath = path.join(tempDirs.make("openclaw-session-hints-"), "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionId = "interrupted-session";
    const scope = { storePath, sessionKey };
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    let entry: SessionEntry = {
      sessionId,
      updatedAt: 1,
      status: "running",
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "interrupted-claim",
      restartRecoveryDeliverySourceRunId: "channel-user:original-input",
      restartRecoveryDeliveryContext: { channel: "discord", to: "synthetic-channel" },
      restartRecoverySourceIngress: "channel",
    };
    await replaceSessionEntry(scope, entry);
    const owner = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId,
      target: scope,
    });
    expect(owner.kind).toBe("claimed");
    if (owner.kind !== "claimed") {
      throw new Error("foreground recovery owner was not acquired");
    }
    entry = owner.entry;
    const prepared = {
      baseBody: "organize my sessions",
      abortedLastRun: true,
      sessionEntry: entry,
      sessionStore: { [sessionKey]: entry },
      ...scope,
    };
    const body = await Promise.resolve(applySessionHints(prepared));
    expect(body).toContain("organize my sessions");

    const controller = createReplyRestartRecoveryClaimController({
      agentId: "main",
      admissionRunId: "new-input",
      lifecycleGeneration,
      getEntry: () => entry,
      getSessionId: () => sessionId,
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      setEntry: (next) => {
        entry = next;
      },
      ...scope,
    });
    await expect(controller.admitUserTurn()).rejects.toThrow(
      "restart recovery claim changed before agent adoption",
    );
    await controller.clear();

    await expect(releaseMainSessionRecoveryOwner(owner.lease)).resolves.toMatchObject({
      sessionId,
      ...scope,
    });
    expect(loadSessionEntry(scope)).toMatchObject({
      abortedLastRun: true,
      status: "running",
      restartRecoveryDeliveryRunId: "interrupted-claim",
      restartRecoveryDeliverySourceRunId: "channel-user:original-input",
    });
    expect(body).not.toContain("aborted by the user");
  });

  it("consumes the process-local abort hint without a session write", () => {
    const abortKey = "session-hint-without-store";
    setAbortMemory(abortKey, true);
    expect(applySessionHints({ baseBody: "continue", abortedLastRun: true, abortKey })).toContain(
      "previous agent run was interrupted",
    );
    expect(getAbortMemory(abortKey)).toBeUndefined();
  });
});
