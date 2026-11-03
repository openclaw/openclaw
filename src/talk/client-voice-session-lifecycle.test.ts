import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
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
import { completeRun, createVoiceSession } from "./client-voice-session.fixture.test-support.js";
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

async function open(name: string, agentId = "main") {
  const target = { agentId, sessionKey: `agent:${agentId}:${name}` };
  return {
    ...target,
    voiceSessionId: await createOrResumeClientVoiceSession({
      ...target,
      origin: "client",
      voiceSessionId: `voice-${name}`,
    }),
  };
}
const registerRun = registerClientVoiceConsultRun;

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

  it.each(["before", "after"])(
    "keeps completion ownership when a run registers %s transport close",
    async (when) => {
      const session = await open("active");
      const register = () => registerRun({ ...session, runId: "run-active" });
      if (when === "before") {
        await register();
      }
      await closeClientVoiceSession({ ...session, config: {} });
      if (when === "after") {
        await register();
      }
      expect(resolveClientVoiceRunBinding("run-active")).toMatchObject({
        voiceSessionId: session.voiceSessionId,
      });
      await completeRun("run-active");
      expect(resolveClientVoiceRunBinding("run-active")).toBeUndefined();
    },
  );

  it("keeps shared-state close pending after a live consult loses read admission", async () => {
    const database = openOpenClawStateDatabase();
    const context = captureOpenClawStateWorkerContext();
    const sessionKey = "agent:main:state-close";
    const runId = "state-close-consult";
    const voiceSessionId = await createVoiceSession({ sessionKey });
    const voiceClose = prepareClientVoiceSessionClose();
    const root = tryBeginGatewayRootWorkAdmission()!;
    await root.run(() => registerRun({ agentId: "main", voiceSessionId, sessionKey, runId }));
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
      expect({ voiceDrained, stateClosed, databaseOpen: database.db.isOpen }).toEqual({
        voiceDrained: false,
        stateClosed: false,
        databaseOpen: true,
      });
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
      const voiceSessionId = await createVoiceSession({ sessionKey });
      const close = prepareClientVoiceSessionClose();
      const root = tryBeginGatewayRootWorkAdmission()!;
      const retained = await root.run(async () => {
        await registerRun({ agentId: "main", voiceSessionId, sessionKey, runId });
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
          }
          const scope = retained ?? root;
          await expect(
            scope
              .run(async () => {
                throw error;
              })
              .finally(scope.release),
          ).rejects.toBe(error);
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

  it("releases only the prior scope when a run binding is replaced", async () => {
    const first = await open("first", "agent-a");
    const firstRoot = tryBeginGatewayRootWorkAdmission()!;
    const releaseFirst = await firstRoot.run(() =>
      registerClientVoiceConsultRun({ ...first, runId: "run-shared" }),
    );
    await closeClientVoiceSession({ ...first, config: {} });
    const unrelated = await open("unrelated", "agent-b");
    await registerClientVoiceConsultRun({ ...unrelated, runId: "run-unrelated" });
    const replacement = await open("replacement", "agent-b");
    const replacementRoot = tryBeginGatewayRootWorkAdmission()!;
    await replacementRoot.run(() =>
      registerClientVoiceConsultRun({ ...replacement, runId: "run-shared" }),
    );

    releaseFirst();
    expect(resolveClientVoiceRunBinding("run-shared")).toMatchObject({
      voiceSessionId: replacement.voiceSessionId,
    });
    expect(resolveClientVoiceRunBinding("run-unrelated")).toMatchObject({
      voiceSessionId: unrelated.voiceSessionId,
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
