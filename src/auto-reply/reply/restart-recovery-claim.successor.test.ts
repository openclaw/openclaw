import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { isRestartRecoveryClaimChangedError } from "../../infra/agent-lifecycle-error.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createRecoveryControllerFixture } from "./recovery-controller.fixture.test-support.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const claim = (runId: string, sourceRunId = runId) => ({
  restartRecoveryDeliveryRunId: runId,
  restartRecoveryDeliverySourceRunId: sourceRunId,
});
type ClaimOptions = Parameters<typeof createReplyRestartRecoveryClaimController>[0];

async function claimFixture(sessionKey: string, overrides: Partial<InternalSessionEntry> = {}) {
  const scope = {
    agentId: "main",
    storePath: path.join(tempDirs.make("openclaw-claim-"), "agents/main/sessions/sessions.json"),
    sessionKey,
  };
  const fixture = await createRecoveryControllerFixture(scope, {
    abortedLastRun: true,
    ...claim("interrupted-run"),
    restartRecoverySourceIngress: "control-ui",
    sessionId: "session",
    status: "interrupted",
    updatedAt: 1,
    ...overrides,
  });
  const setEntry = vi.fn(fixture.setEntry);
  return {
    ...fixture,
    get entry() {
      return fixture.entry;
    },
    setEntry,
    updateEntry: fixture.setEntry,
    read: () => loadSessionEntry(scope),
    controller: (options: Partial<ClaimOptions>) =>
      fixture.controller({
        admissionRunId: "queued-run",
        setEntry,
        ...options,
      }),
  };
}

it.each([
  [undefined, true, false],
  ["interrupted", true, false],
  ["killed", false, false],
  ["failed", false, false],
  ["interrupted", false, true],
] as const)(
  "handles Control UI status %s (transfer: %s; ownership lost: %s)",
  async (status, transfers, losesOwnership) => {
    await using fixture = await claimFixture("agent:main:main", {
      restartRecoveryDeliveryRequestFingerprint: losesOwnership ? undefined : "request-fingerprint",
      status,
    });
    const before = fixture.read();
    let replacement: ReturnType<typeof updateSessionEntry> | undefined;
    const controller = fixture.controller({
      resolveDeliveryContext: () => {
        if (losesOwnership) {
          replacement ??= updateSessionEntry(fixture.scope, () => ({
            abortedLastRun: false,
            ...claim("replacement-run"),
            updatedAt: 2,
          }));
        }
        return undefined;
      },
    });
    const outcome = await controller.admitUserTurn().catch((error: unknown) => error);
    await replacement;
    if (losesOwnership) {
      expect(isRestartRecoveryClaimChangedError(outcome)).toBe(true);
      expect(fixture.setEntry).not.toHaveBeenCalled();
      expect(fixture.read()).toMatchObject(claim("replacement-run"));
    } else if (!transfers) {
      expect(isRestartRecoveryClaimChangedError(outcome)).toBe(true);
      expect(fixture.read()).toEqual(before);
    } else {
      expect(outcome).toBe("admitted");
      expect(fixture.read()).toMatchObject({
        abortedLastRun: false,
        ...claim("queued-run"),
        restartRecoverySourceIngress: "control-ui",
        restartRecoveryTerminalRunIds: ["interrupted-run"],
      });
      expect(fixture.read()?.status).toBeUndefined();
    }
  },
);

it("tracks a channel claim after retiring an aborted Control UI predecessor", async () => {
  setRuntimeConfigSnapshot({});
  onTestFinished(clearRuntimeConfigSnapshot);
  const sourceTurnId = "channel-turn";
  await using fixture = await claimFixture(
    "agent:main:telegram:group:chat",
    claim("interrupted-control-ui-run"),
  );
  const recorder = createUserTurnTranscriptRecorder({
    message: {
      role: "user",
      content: "continue from Telegram",
      idempotencyKey: sourceTurnId,
      timestamp: Date.now(),
    },
    target: {
      agentId: "main",
      sessionEntry: fixture.entry,
      sessionId: fixture.entry.sessionId,
      ...fixture.scope,
    },
    updateMode: "none",
  });
  const controller = fixture.controller({
    admissionRunId: sourceTurnId,
    resolveDeliveryContext: () => ({ channel: "telegram", to: "chat", accountId: "default" }),
    sourceTurnId,
  });

  await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
  const admittedRunId = fixture.read()?.restartRecoveryDeliveryRunId;
  expect(admittedRunId).toEqual(expect.any(String));
  expect(fixture.read()?.status).toBeUndefined();
  await expect(controller.beginBeforeAgentReply()).resolves.toBe(true);
  await controller.checkpointBeforeAgentReply({
    state: "handled-reply",
    pendingFinalDelivery: {
      intentId: "channel-intent",
      text: "channel reply",
      deliveries: [{ id: "channel-delivery", state: "prepared" }],
    },
  });
  const preserved = {
    pendingFinalDelivery: { intentId: "channel-intent", text: "channel reply" },
    restartRecoveryBeforeAgentReplyState: "handled-reply",
  };
  expect(fixture.read()).toMatchObject({
    ...preserved,
    restartRecoveryDeliveryRunId: admittedRunId,
    restartRecoveryDeliverySourceRunId: sourceTurnId,
    restartRecoverySourceIngress: "channel",
  });

  fixture.updateEntry(
    (await updateSessionEntry(fixture.scope, () => ({
      abortedLastRun: true,
    }))) as InternalSessionEntry,
  );
  await expect(controller.isArmed()).resolves.toBe(true);
  await controller.clear();

  expect(fixture.read()).toMatchObject({
    ...preserved,
    restartRecoveryTerminalRunIds: ["interrupted-control-ui-run", sourceTurnId],
  });
  expect(fixture.read()?.restartRecoveryDeliveryRunId).toBeUndefined();
});
