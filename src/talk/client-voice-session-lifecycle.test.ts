import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  emitTrustedDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import {
  retainGatewayRootWorkAdmissionContinuationScope,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { prepareClientVoiceSessionClose } from "./client-voice-session-lifecycle.js";
import {
  closeClientVoiceSession,
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "./client-voice-session.js";
import { clientVoiceSessionTesting } from "./client-voice-session.test-support.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let tempDir: string;

async function registerRun(
  agentId: string,
  voiceSessionId: string,
  sessionKey: string,
  runId: string,
): Promise<() => void> {
  return await registerClientVoiceConsultRun({
    agentId,
    sessionKey,
    voiceSessionId,
    runId,
  });
}

async function completeRun(runId: string): Promise<void> {
  emitTrustedDiagnosticEvent({
    type: "run.completed",
    runId,
    durationMs: 5,
    outcome: "completed",
  });
  await waitForDiagnosticEventsDrained();
}

describe("client voice run lifecycle", () => {
  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-voice-run-lifecycle-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(async () => {
    clientVoiceSessionTesting.reset();
    resetGatewayWorkAdmission();
    await cleanupSessionStateForTest({ stateDir: tempDir });
    envSnapshot.restore();
  });

  it("keeps a live run after close and releases it on completion", async () => {
    const sessionKey = "agent:main:active";
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    await registerRun("main", voiceSessionId, sessionKey, "run-active");

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey,
      voiceSessionId,
      config: {},
    });

    expect(resolveClientVoiceRunBinding("run-active")).toMatchObject({ voiceSessionId });

    await completeRun("run-active");
    expect(resolveClientVoiceRunBinding("run-active")).toBeUndefined();
  });

  it("keeps shared-state close pending after a live consult loses read admission", async () => {
    const database = openOpenClawStateDatabase();
    const context = captureOpenClawStateWorkerContext();
    const sessionKey = "agent:main:state-close";
    const runId = "state-close-consult";
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });
    const voiceClose = prepareClientVoiceSessionClose();
    const root = tryBeginGatewayRootWorkAdmission()!;
    await root.run(async () => registerRun("main", voiceSessionId, sessionKey, runId));
    let voiceDrained = false;
    let stateClosed = false;
    const voiceDrain = voiceClose.drain().then(() => {
      voiceDrained = true;
    });
    const stateClose = closeOpenClawStateDatabaseAsync().then(() => {
      stateClosed = true;
    });
    try {
      expect(() => context.admission.assertCurrent()).toThrow();
      emitTrustedDiagnosticEvent({
        type: "tool.execution.started",
        runId,
        toolCallId: "after-state-fence",
        toolName: "message",
        mutatingAction: true,
      });
      await nextEventLoopTurn();
      expect(resolveClientVoiceRunBinding(runId)).toMatchObject({ voiceSessionId });
      expect(voiceDrained, "failed entry cannot release the live run's persistence custody").toBe(
        false,
      );
      expect(stateClosed).toBe(false);
      expect(database.db.isOpen).toBe(true);
      root.release();
      await Promise.all([voiceDrain, stateClose]);
      expect(database.db.isOpen).toBe(false);
      expect(resolveClientVoiceRunBinding(runId)).toBeUndefined();
    } finally {
      root.release();
      await Promise.all([voiceDrain, stateClose]);
    }
  });

  it.each(["before launch", "after ACK", "runtime reset"] as const)(
    "releases an accepted run after failure %s",
    async (failure) => {
      const sessionKey = "agent:main:failed-consult";
      const runId = "failed-consult";
      const voiceSessionId = await createOrResumeClientVoiceSession({
        agentId: "main",
        sessionKey,
        origin: "client",
      });
      const close = prepareClientVoiceSessionClose();
      const root = tryBeginGatewayRootWorkAdmission()!;
      const retained = await root.run(async () => {
        await registerRun("main", voiceSessionId, sessionKey, runId);
        return failure === "after ACK" ? retainGatewayRootWorkAdmissionContinuationScope() : null;
      });
      try {
        // A diagnostic can precede deferred work; it cannot retire accepted ownership.
        await completeRun(runId);
        expect(resolveClientVoiceRunBinding(runId)).toMatchObject({ voiceSessionId });
        close.beginClose();
        if (failure === "runtime reset") {
          resetGatewayWorkAdmission();
        } else {
          const error = new Error("synthetic consult failure");
          if (retained) {
            root.release();
            expect(resolveClientVoiceRunBinding(runId)).toMatchObject({ voiceSessionId });
            await expect(
              retained
                .run(async () => {
                  throw error;
                })
                .finally(retained.release),
            ).rejects.toBe(error);
          } else {
            await expect(
              root
                .run(async () => {
                  throw error;
                })
                .finally(root.release),
            ).rejects.toBe(error);
          }
        }
        expect(resolveClientVoiceRunBinding(runId)).toBeUndefined();
        await close.drain();
      } finally {
        root.release();
        retained?.release();
        await close.drain();
      }
    },
  );

  it("keeps completion ownership for a run registered after transport close", async () => {
    const sessionKey = "agent:main:stale-bind";
    const voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
    });

    await closeClientVoiceSession({
      agentId: "main",
      sessionKey,
      voiceSessionId,
      config: {},
    });
    await registerRun("main", voiceSessionId, sessionKey, "run-stale-bind");

    expect(resolveClientVoiceRunBinding("run-stale-bind")).toMatchObject({ voiceSessionId });

    await completeRun("run-stale-bind");
    expect(resolveClientVoiceRunBinding("run-stale-bind")).toBeUndefined();
  });

  it("releases only the prior scope when a run binding is replaced", async () => {
    const firstAgentId = "agent-a";
    const firstSessionKey = "agent:agent-a:first";
    const firstVoiceSessionId = await createOrResumeClientVoiceSession({
      agentId: firstAgentId,
      sessionKey: firstSessionKey,
      origin: "client",
      voiceSessionId: "voice-first",
    });
    const firstRoot = tryBeginGatewayRootWorkAdmission()!;
    const releaseFirst = await firstRoot.run(async () =>
      registerRun(firstAgentId, firstVoiceSessionId, firstSessionKey, "run-shared"),
    );
    await closeClientVoiceSession({
      agentId: firstAgentId,
      sessionKey: firstSessionKey,
      voiceSessionId: firstVoiceSessionId,
      config: {},
    });

    const replacementAgentId = "agent-b";
    const unrelatedSessionKey = "agent:agent-b:unrelated";
    const unrelatedVoiceSessionId = await createOrResumeClientVoiceSession({
      agentId: replacementAgentId,
      sessionKey: unrelatedSessionKey,
      origin: "client",
      voiceSessionId: "voice-unrelated",
    });
    await registerRun(
      replacementAgentId,
      unrelatedVoiceSessionId,
      unrelatedSessionKey,
      "run-unrelated",
    );

    const replacementSessionKey = "agent:agent-b:replacement";
    const replacementVoiceSessionId = await createOrResumeClientVoiceSession({
      agentId: replacementAgentId,
      sessionKey: replacementSessionKey,
      origin: "client",
      voiceSessionId: "voice-replacement",
    });
    const replacementRoot = tryBeginGatewayRootWorkAdmission()!;
    await replacementRoot.run(async () => {
      await registerRun(
        replacementAgentId,
        replacementVoiceSessionId,
        replacementSessionKey,
        "run-shared",
      );
    });

    releaseFirst();
    expect(resolveClientVoiceRunBinding("run-shared")).toMatchObject({
      voiceSessionId: replacementVoiceSessionId,
    });
    expect(resolveClientVoiceRunBinding("run-unrelated")).toMatchObject({
      voiceSessionId: unrelatedVoiceSessionId,
    });

    const close = prepareClientVoiceSessionClose();
    close.beginClose();
    replacementRoot.release();
    // Reassignment released the old permit even while its original root survives.
    await close.drain();
    firstRoot.release();
    expect(resolveClientVoiceRunBinding("run-shared")).toBeUndefined();

    await completeRun("run-unrelated");
  });
});
