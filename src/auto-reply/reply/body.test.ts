import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  claimMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getAbortMemory, setAbortMemory } from "./abort-primitives.js";
import { applySessionHints } from "./body.js";
import { createRecoveryControllerFixture } from "./recovery-controller.fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("preserves interrupted work for recovery when a prepared foreground turn cannot start", async () => {
  const storePath = path.join(tempDirs.make("openclaw-session-hints-"), "sessions.json");
  const sessionId = "interrupted-session";
  const scope = { storePath, sessionKey: "agent:main:main" };
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  await using fixture = await createRecoveryControllerFixture(
    { agentId: "main", ...scope },
    {
      sessionId,
      updatedAt: 1,
      status: "interrupted",
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: "interrupted-claim",
      restartRecoveryDeliverySourceRunId: "channel-user:original-input",
      restartRecoveryDeliveryContext: { channel: "discord", to: "synthetic-channel" },
      restartRecoverySourceIngress: "channel",
    },
    { lifecycleGeneration, getSessionId: () => sessionId },
  );
  const owner = await claimMainSessionRecoveryOwner({
    lifecycleGeneration,
    sessionId,
    target: scope,
  });
  assert(owner.kind === "claimed", "foreground recovery owner was not acquired");
  fixture.setEntry(owner.entry);
  const body = applySessionHints({ baseBody: "organize my sessions", abortedLastRun: true });
  expect(body).toContain("organize my sessions");

  const controller = fixture.controller({ admissionRunId: "new-input" });
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
    status: "interrupted",
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
