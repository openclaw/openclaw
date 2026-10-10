import { copyFileSync, renameSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  authorizeClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy,
  deactivateClientVoiceConfirmationSession,
} from "../../talk/client-voice-confirmation.js";
import {
  noteClientVoiceConfirmationUtteranceForTest as noteClientVoiceConfirmationUtterance,
  resetClientVoiceConfirmationStateForTest,
} from "../../talk/client-voice-confirmation.test-support.js";
import { captureClientVoiceSessionSource } from "../../talk/client-voice-session-source.js";
import { readVoiceSessionRecord } from "../../talk/client-voice-session-store.js";
import { createOrResumeClientVoiceSession } from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import { setTestEnvValue } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";

const { coreParams, deferred, mocks } = await vi.hoisted(
  () => import("./client-gateway-control.agent-consult.test-support.js"),
);

vi.mock("../../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
vi.mock("../../talk/agent-consult-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/agent-consult-runtime.js")>()),
  consultRealtimeVoiceAgent: mocks.consultRealtimeVoiceAgent,
}));
vi.mock("../../talk/agent-run-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/agent-run-control.js")>()),
  controlRealtimeVoiceAgentRun: mocks.controlRealtimeVoiceAgentRun,
}));

import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import {
  createConsultRunner,
  createRunner,
  resetConsultFixture,
} from "./client-gateway-control.agent-consult-fixture.test-support.js";
import type { ConsultParams } from "./client-gateway-control.agent-consult.test-support.js";
import { resolveTalkAgentConsultAuthority } from "./client-gateway-control.js";

describe("Talk client agent consult admission", () => {
  beforeEach(resetConsultFixture);

  afterEach(() => {
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    resetClientVoiceConfirmationStateForTest();
  });

  it("waits for backend publication and projects its registered caller authority", async () => {
    const announced = deferred<void>();
    const publish = deferred<void>();
    const finish = deferred<void>();
    const chatAbortControllers = new Map();
    const client = sharingPolicyClient({
      deviceId: "caller-device",
      scopes: ["operator.admin"],
    });
    const authority = resolveTalkAgentConsultAuthority(client.connect.scopes, client);
    const handle = createEmbeddedRunHandle({ runId: "run-talk" });
    const operationalRunInstance = {
      instanceId: "instance:publication",
      runId: "run-talk",
    };
    const projectToolAuthority = vi.fn((_overlay: ReplyToolAuthorityOverlay) => "authority");
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(operationalRunInstance);
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      announced.resolve();
      await publish.promise;
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance,
          embeddedRunToolAuthorityBinding: () => ({
            source: "reply",
            project: projectToolAuthority,
            projectAsync: async (overlay) => projectToolAuthority(overlay),
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk"),
      );
      await finish.promise;
      clearActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk");
      return { payloads: [] };
    });
    const runner = createConsultRunner({
      context: { chatAbortControllers, logGateway: { warn: vi.fn() } } as never,
      ownerConnId: "connection-owner",
      authority,
    });
    runner.runPrompt.adoptCompletionClaims();
    const run = runner.runPrompt({ prompt: "first task" });
    await announced.promise;
    const steer = runner.runPrompt.steer;
    if (!steer) {
      throw new Error("owned Talk runner did not expose steering");
    }
    const steering = steer({ prompt: "latest task" });

    try {
      await Promise.resolve();
      expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
      publish.resolve();
      await steering;

      const controlParams = mocks.controlRealtimeVoiceAgentRun.mock.calls[0]?.[0];
      expect(controlParams).toEqual(
        expect.objectContaining({
          sessionKey: "agent:researcher:talk",
          runTarget: expect.objectContaining({ runId: "run-talk" }),
          getToolAuthorityOverlay: expect.any(Function),
          text: "latest task",
          mode: "steer",
        }),
      );
      const expectedOverlay = runner.getToolAuthorityOverlay(authority, "reply");
      const capturedOverlay = controlParams?.getToolAuthorityOverlay?.();
      expect(capturedOverlay).toEqual(expectedOverlay);
      if (capturedOverlay) {
        await controlParams?.prepareToolAuthorityOverlay?.(capturedOverlay);
      }
      expect(projectToolAuthority).toHaveBeenCalledWith(expectedOverlay);
    } finally {
      publish.resolve();
      finish.resolve();
      await steering.catch(() => undefined);
      await run;
    }
    expect(runner.runPrompt.claimAppend()).toBe(true);
    expect(runner.runPrompt.claimAppend()).toBe(false);
    expect(chatAbortControllers.has("run-talk")).toBe(false);
    expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: true }),
    );
    expect(mocks.consultRealtimeVoiceAgent.mock.calls[0]?.[0]).not.toHaveProperty("toolsAllow");
  });

  it("refreshes steering authority when the admitted run publishes a new attempt", async () => {
    const secondPublished = deferred<void>();
    const finish = deferred<void>();
    const chatAbortControllers = new Map();
    const firstHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const secondHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const operationalRunInstance = {
      instanceId: "instance:retry",
      runId: "run-talk",
    };
    let firstLive = true;
    const firstProject = vi.fn((_overlay: ReplyToolAuthorityOverlay) => {
      if (!firstLive) {
        throw new Error("first attempt expired");
      }
      return "first-authority";
    });
    const secondProject = vi.fn((_overlay: ReplyToolAuthorityOverlay) => "second-authority");
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(operationalRunInstance);
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project: firstProject,
            projectAsync: async (overlay) => firstProject(overlay),
            assertActive: () => {
              if (!firstLive) {
                throw new Error("first attempt expired");
              }
            },
          }),
        },
        () => setActiveEmbeddedRun("session-talk", firstHandle, "agent:researcher:talk"),
      );
      await Promise.resolve();
      firstLive = false;
      clearActiveEmbeddedRun("session-talk", firstHandle, "agent:researcher:talk");
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project: secondProject,
            projectAsync: async (overlay) => secondProject(overlay),
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", secondHandle, "agent:researcher:talk"),
      );
      secondPublished.resolve();
      await finish.promise;
      clearActiveEmbeddedRun("session-talk", secondHandle, "agent:researcher:talk");
      return { payloads: [] };
    });
    mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(async (params) => {
      const overlay = params.getToolAuthorityOverlay?.();
      if (overlay) {
        await params.prepareToolAuthorityOverlay?.(overlay);
      }
      return {
        ok: true,
        mode: "steer",
        sessionKey: "agent:researcher:talk",
        sessionId: "session-talk",
        active: true,
        queued: true,
        target: "embedded",
        message: "Steering accepted.",
        speak: true,
        show: true,
        suppress: false,
      };
    });
    const runner = createConsultRunner({
      context: { chatAbortControllers, logGateway: { warn: vi.fn() } } as never,
      ownerConnId: "connection-owner",
    });
    runner.runPrompt.adoptCompletionClaims();
    const run = runner.runPrompt({ prompt: "first task" });
    await secondPublished.promise;

    try {
      await expect(runner.runPrompt.steer?.({ prompt: "latest task" })).resolves.toEqual({
        text: "",
      });
      expect(firstProject).not.toHaveBeenCalled();
      expect(secondProject).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      await run;
    }
  });

  it("rejects steering when a replacement reuses the run id from another admission", async () => {
    const secondPublished = deferred<void>();
    const finish = deferred<void>();
    const outbound = vi.fn();
    const admittedRun = { instanceId: "instance:owner", runId: "run-talk" };
    const replacementRun = { instanceId: "instance:replacement", runId: "run-talk" };
    const firstHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const secondHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const ownerProject = (_overlay: ReplyToolAuthorityOverlay) => "owner-authority";
    const replacementProject = vi.fn(
      (_overlay: ReplyToolAuthorityOverlay) => "replacement-authority",
    );
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(admittedRun);
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance: admittedRun,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project: ownerProject,
            projectAsync: async (overlay) => ownerProject(overlay),
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", firstHandle, "agent:researcher:talk"),
      );
      clearActiveEmbeddedRun("session-talk", firstHandle, "agent:researcher:talk");
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance: replacementRun,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project: replacementProject,
            projectAsync: async (overlay) => replacementProject(overlay),
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", secondHandle, "agent:researcher:talk"),
      );
      secondPublished.resolve();
      await finish.promise;
      clearActiveEmbeddedRun("session-talk", secondHandle, "agent:researcher:talk");
      return { payloads: [] };
    });
    mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(async (params) => {
      params.getToolAuthorityOverlay?.();
      outbound();
      throw new Error("unexpected outbound enqueue");
    });
    const runner = createConsultRunner({
      ownerConnId: "connection-owner",
    });
    runner.runPrompt.adoptCompletionClaims();
    const run = runner.runPrompt({ prompt: "first task" });
    await secondPublished.promise;

    try {
      await expect(runner.runPrompt.steer?.({ prompt: "latest task" })).rejects.toThrow(
        "backend is no longer current",
      );
      expect(replacementProject).not.toHaveBeenCalled();
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await run;
    }
  });

  it("does not let a stale runtime bind a replacement owner before admission", async () => {
    const firstAnnounced = deferred<void>();
    const secondAnnounced = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    const staleRun = { instanceId: "instance:stale", runId: "run-talk" };
    const currentRun = { instanceId: "instance:current", runId: "run-talk" };
    let invocation = 0;
    mocks.createOperationalRunInstanceRef
      .mockReturnValueOnce(staleRun)
      .mockReturnValueOnce(currentRun);
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      invocation += 1;
      await params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      if (invocation === 1) {
        firstAnnounced.resolve();
        await releaseFirst.promise;
      } else {
        secondAnnounced.resolve();
        await releaseSecond.promise;
      }
      await params.agentRuntime.runEmbeddedAgent(coreParams);
      return { text: "done" };
    });
    const runner = createConsultRunner({
      ownerConnId: "connection-owner",
    });
    runner.runPrompt.adoptCompletionClaims();
    const first = runner.runPrompt({ prompt: "first task" });
    await firstAnnounced.promise;
    expect(runner.runPrompt.claimFailureAppend()).toBe(true);
    const second = runner.runPrompt({ prompt: "replacement task" });
    await secondAnnounced.promise;

    try {
      releaseFirst.resolve();
      await expect(first).rejects.toThrow("admission is no longer current");
      releaseSecond.resolve();
      await expect(second).resolves.toEqual({ text: "done" });
      expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledOnce();
      expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledWith(
        expect.objectContaining({ operationalRunInstance: currentRun }),
      );
      expect(runner.runPrompt.claimFailureAppend()).toBe(true);
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await Promise.allSettled([first, second]);
      runner.runPrompt.claimFailureAppend();
    }
  });

  it("rejects a stale owner before it can announce over its replacement", async () => {
    const firstWaiting = deferred<void>();
    const releaseFirst = deferred<void>();
    const secondPublished = deferred<void>();
    const finishSecond = deferred<void>();
    const chatAbortControllers = new Map();
    const registerRun = vi.fn(async () => ({ release: vi.fn(), isCurrent: () => true }));
    const currentRun = { instanceId: "instance:current-owner", runId: "run-talk" };
    const secondHandle = createEmbeddedRunHandle({ runId: "run-talk" });
    const project = vi.fn((_overlay: ReplyToolAuthorityOverlay) => "current-authority");
    let invocation = 0;
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(currentRun);
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      invocation += 1;
      if (invocation === 1) {
        firstWaiting.resolve();
        await releaseFirst.promise;
        await params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
        await params.agentRuntime.runEmbeddedAgent(coreParams);
        return { text: "stale" };
      }
      await params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      await params.agentRuntime.runEmbeddedAgent(coreParams);
      return { text: "current" };
    });
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance: currentRun,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project,
            projectAsync: async (overlay) => project(overlay),
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", secondHandle, "agent:researcher:talk"),
      );
      secondPublished.resolve();
      await finishSecond.promise;
      clearActiveEmbeddedRun("session-talk", secondHandle, "agent:researcher:talk");
      return { payloads: [] };
    });
    mocks.controlRealtimeVoiceAgentRun.mockImplementationOnce(async (params) => {
      const overlay = params.getToolAuthorityOverlay?.();
      if (overlay) {
        await params.prepareToolAuthorityOverlay?.(overlay);
      }
      return {
        ok: true,
        mode: "steer",
        sessionKey: "agent:researcher:talk",
        sessionId: "session-talk",
        active: true,
        queued: true,
        target: "embedded",
        message: "Steering accepted.",
        speak: true,
        show: true,
        suppress: false,
      };
    });
    const runner = createConsultRunner({
      context: { chatAbortControllers, logGateway: { warn: vi.fn() } } as never,
      ownerConnId: "connection-owner",
      registerRun,
    });
    runner.runPrompt.adoptCompletionClaims();
    const first = runner.runPrompt({ prompt: "first task" });
    await firstWaiting.promise;
    expect(runner.runPrompt.claimFailureAppend()).toBe(true);
    const second = runner.runPrompt({ prompt: "replacement task" });
    await secondPublished.promise;

    try {
      releaseFirst.resolve();
      await expect(first).rejects.toThrow("admission is no longer current");
      await expect(runner.runPrompt.steer?.({ prompt: "latest task" })).resolves.toEqual({
        text: "",
      });
      expect(registerRun).toHaveBeenCalledOnce();
      expect(project).toHaveBeenCalledOnce();
    } finally {
      releaseFirst.resolve();
      finishSecond.resolve();
      await Promise.allSettled([first, second]);
      runner.runPrompt.claimFailureAppend();
    }
  });

  it("does not let a stale runner revoke a replacement completion claim", async () => {
    const staleWaiting = deferred<void>();
    const releaseStale = deferred<void>();
    const currentStarted = deferred<void>();
    const finishCurrent = deferred<void>();
    let invocation = 0;
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      const currentInvocation = (invocation += 1);
      if (currentInvocation === 1) {
        staleWaiting.resolve();
        await releaseStale.promise;
      }
      await params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      if (currentInvocation === 2) {
        currentStarted.resolve();
        await finishCurrent.promise;
      }
      return { text: "done" };
    });
    const runnerOptions = {
      ownerConnId: "connection-owner",
    };
    const staleRunner = createRunner(undefined, undefined, runnerOptions);
    const currentRunner = createRunner(undefined, undefined, runnerOptions);
    let staleCurrent = true;
    const staleRun = staleRunner.runOwnedArgs(
      { question: "stale task" },
      undefined,
      undefined,
      () => {
        if (!staleCurrent) {
          throw new Error("Realtime voice session is not active");
        }
      },
    );
    await staleWaiting.promise;
    staleCurrent = false;
    const currentRun = currentRunner.runOwnedArgs(
      { question: "replacement task" },
      undefined,
      undefined,
      () => {},
    );
    await currentStarted.promise;

    try {
      releaseStale.resolve();
      const [staleSettlement] = await Promise.allSettled([staleRun]);
      expect(currentRunner.runOwnedArgs.claimFailureAppend()).toBe(true);
      expect(staleSettlement?.status).toBe("rejected");
      if (staleSettlement?.status === "rejected") {
        expect(String(staleSettlement.reason)).toContain("not active");
      }
      finishCurrent.resolve();
      await expect(currentRun).resolves.toEqual({ text: "done" });
    } finally {
      releaseStale.resolve();
      finishCurrent.resolve();
      await Promise.allSettled([staleRun, currentRun]);
      staleRunner.runOwnedArgs.claimFailureAppend();
      currentRunner.runOwnedArgs.claimFailureAppend();
    }
  });

  it("installs steering ownership before readiness and delays backend admission", async () => {
    const ready = deferred<void>();
    const finish = deferred<void>();
    const chatAbortControllers = new Map();
    const handle = createEmbeddedRunHandle({ runId: "run-talk" });
    const operationalRunInstance = {
      instanceId: "instance:readiness",
      runId: "run-talk",
    };
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(operationalRunInstance);
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      const project = (_overlay: ReplyToolAuthorityOverlay) => "authority";
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project,
            projectAsync: async (overlay) => project(overlay),
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk"),
      );
      await finish.promise;
      clearActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk");
      return { payloads: [] };
    });
    const runner = createConsultRunner({
      context: { chatAbortControllers, logGateway: { warn: vi.fn() } } as never,
      ownerConnId: "connection-owner",
    });
    const readiness = vi.fn(() => ready.promise);
    const assertCurrent = vi.fn();
    const run = runner.runOwnedArgs(
      { question: "first task" },
      new AbortController().signal,
      readiness,
      assertCurrent,
    );
    const steer = runner.runOwnedArgs.steer;
    if (!steer) {
      throw new Error("owned Talk runner did not expose steering");
    }
    const steering = steer({ prompt: "latest task" });

    try {
      expect(readiness).toHaveBeenCalledOnce();
      expect(assertCurrent).not.toHaveBeenCalled();
      expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(mocks.controlRealtimeVoiceAgentRun).not.toHaveBeenCalled();
      ready.resolve();
      await steering;
      // Voice registration rechecks live ownership before and after its worker wait.
      expect(assertCurrent).toHaveBeenCalledTimes(5);
      expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledOnce();
      expect(mocks.controlRealtimeVoiceAgentRun).toHaveBeenCalledOnce();
      finish.resolve();
      await expect(run).resolves.toEqual({ text: "done" });
    } finally {
      ready.resolve();
      finish.resolve();
      await steering.catch(() => undefined);
      await run.catch(() => undefined);
    }
  });

  it.each(["state-switch", "file-replaced"] as const)(
    "keeps browser consult on its published physical source (%s)",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const target = {
          agentId: "researcher",
          sessionKey: "main",
          voiceSessionId: "voice-session",
          origin: "client" as const,
        };
        const originalEnv = { ...process.env };
        const sourcePath = resolveOpenClawAgentSqlitePath(target);
        const otherState = path.join(path.dirname(sourcePath), "other-state");
        await createOrResumeClientVoiceSession(target);
        const source = captureClientVoiceSessionSource(target.agentId);
        if (change === "state-switch") {
          setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
          await createOrResumeClientVoiceSession(target);
          setTestEnvValue("OPENCLAW_STATE_DIR", state.stateDir);
        }
        const ready = deferred<void>();
        let published = false;
        const sourceOwner = {
          getVoiceSessionSource: () => {
            if (!published) {
              throw new Error("Browser source has not been published");
            }
            return source;
          },
        };
        const runner = createConsultRunner({
          registerRun: undefined,
          ...sourceOwner,
        });
        mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
          if (change === "state-switch") {
            setTestEnvValue("OPENCLAW_STATE_DIR", otherState);
          }
          await params.onRunStarted?.({
            runId: "run-talk",
            sessionId: "session-talk",
            timeoutMs: 1,
          });
          await params.agentRuntime.runEmbeddedAgent(coreParams);
          return { text: "done" };
        });
        const running = runner.runOwnedArgs(
          { question: "Use this browser's store" },
          undefined,
          () => ready.promise,
        );
        try {
          expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
          if (change === "file-replaced") {
            await closeOpenClawAgentDatabasesAsync(state.stateDir);
            renameSync(sourcePath, `${sourcePath}.original`);
            copyFileSync(`${sourcePath}.original`, sourcePath);
          }
          published = true;
          ready.resolve();
          if (change === "file-replaced") {
            await expect(running).rejects.toThrow();
            expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
            expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
          } else {
            await expect(running).resolves.toEqual({ text: "done" });
            expect(
              readVoiceSessionRecord(target.agentId, target.voiceSessionId, { env: originalEnv }),
            ).toMatchObject({ consultRunIds: ["run-talk"] });
            expect(readVoiceSessionRecord(target.agentId, target.voiceSessionId)).toMatchObject({
              consultRunIds: [],
            });
          }
        } finally {
          ready.resolve();
          await running.catch(() => undefined);
          setTestEnvValue("OPENCLAW_STATE_DIR", state.stateDir);
          clientVoiceSessionTesting.reset();
          await cleanupSessionStateForTest({ stateDir: otherState });
        }
      });
    },
  );

  it("rechecks reusable browser ownership after yielding before backend admission", async () => {
    let current = true;
    const assertCurrent = vi.fn(() => {
      if (!current) {
        throw new Error("Realtime voice session is not active");
      }
    });
    const runner = createRunner();
    const run = runner.runArgs(
      { question: "first task" },
      new AbortController().signal,
      assertCurrent,
    );
    current = false;

    await expect(run).rejects.toThrow("not active");
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(mocks.consultRealtimeVoiceAgent).not.toHaveBeenCalled();
  });

  it("rechecks reusable ownership at embedded-run admission", async () => {
    let current = true;
    const assertCurrent = vi.fn(() => {
      if (!current) {
        throw new Error("Realtime voice session is not active");
      }
    });
    mocks.createOperationalRunInstanceRef.mockImplementationOnce((runId: string) => {
      current = false;
      return { instanceId: `instance:${runId}`, runId };
    });

    await expect(
      createRunner().runArgs({ question: "first task" }, undefined, assertCurrent),
    ).rejects.toThrow("not active");
    expect(assertCurrent).toHaveBeenCalledTimes(4);
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
  });

  it("rechecks owned run identity at embedded-run admission", async () => {
    let current = true;
    mocks.createOperationalRunInstanceRef.mockImplementationOnce((runId: string) => {
      current = false;
      return { instanceId: `instance:${runId}`, runId };
    });
    const runner = createRunner(
      vi.fn(async () => ({ release: vi.fn(), isCurrent: () => current })),
      undefined,
      {
        ownerConnId: "connection-owner",
      },
    );
    runner.runPrompt.adoptCompletionClaims();

    await expect(runner.runPrompt({ prompt: "first task" })).rejects.toThrow(
      "admission is no longer current",
    );
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
  });

  it("revokes admission immediately when the composite run signal aborts", async () => {
    const core = deferred<{ payloads: never[] }>();
    mocks.runEmbeddedAgentCore.mockReturnValueOnce(core.promise);
    const controller = new AbortController();
    const run = createRunner().runPrompt({ prompt: "check", signal: controller.signal });
    await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());

    controller.abort(new Error("cancelled"));
    expect(mocks.close).toHaveBeenCalledOnce();
    core.resolve({ payloads: [] });
    await expect(run).resolves.toEqual({ text: "done" });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("closes admission when abort races with listener registration", async () => {
    const controller = new AbortController();
    mocks.prepareAgentRunAdmission.mockImplementationOnce(() => {
      controller.abort(new Error("raced cancellation"));
      return {
        operationalRunInstance: { instanceId: "instance:run-talk", runId: "run-talk" },
        admit: vi.fn(),
        close: mocks.close,
      };
    });

    await expect(
      createRunner().runPrompt({ prompt: "check", signal: controller.signal }),
    ).rejects.toThrow("raced cancellation");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("does not create admission for an already-aborted consult", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    await expect(
      createRunner().runPrompt({ prompt: "check", signal: controller.signal }),
    ).rejects.toThrow("already cancelled");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("returns the current server challenge instead of a model's superseded confirmation id", async () => {
    let currentChallenge = "";
    mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
      await params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      for (const message of ["first blocked action", "last blocked action"]) {
        const challenge = checkClientVoiceToolConfirmationPolicy({
          agentId: "researcher",
          voiceSessionId: "voice-session",
          runId: "run-talk",
          toolName: "message",
          toolParams: { action: "send", message },
        });
        if (challenge.allowed) {
          throw new Error("expected a blocked action");
        }
        currentChallenge = challenge.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)![1]!;
      }
      return { text: "VOICE_CONFIRMATION_REQUIRED:stale-model-id Say yes, send the message." };
    });
    const result = await createRunner().runArgs({ question: "check" });
    expect(result.text).toContain(`VOICE_CONFIRMATION_REQUIRED:${currentChallenge}`);
    expect(result.text).toContain('Say "yes"');
    expect(result.text).not.toContain("stale-model-id");
  });

  it("continues the admitted run when close invalidates confirmation before registration", async () => {
    const now = Date.now();
    const challenge = checkClientVoiceToolConfirmationPolicy({
      agentId: "researcher",
      voiceSessionId: "voice-session",
      runId: "run-original",
      toolName: "message",
      toolParams: { action: "send", message: "cancelled action" },
      now,
    });
    if (challenge.allowed) {
      throw new Error("expected voice confirmation challenge");
    }
    const confirmationId = challenge.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1];
    if (!confirmationId) {
      throw new Error("missing voice confirmation id");
    }
    noteClientVoiceConfirmationUtterance({
      agentId: "researcher",
      voiceSessionId: "voice-session",
      text: "yes",
      timestamp: now + 1,
    });
    authorizeClientVoiceConfirmation({
      agentId: "researcher",
      voiceSessionId: "voice-session",
      confirmationId,
      now: now + 2,
    });
    mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
      deactivateClientVoiceConfirmationSession("researcher", "voice-session");
      await params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      await params.agentRuntime.runEmbeddedAgent(coreParams);
      return { text: "done" };
    });
    const registerRun = vi.fn(async () => ({ release: vi.fn(), isCurrent: () => true }));

    await expect(
      createRunner(registerRun).runArgs({ question: "check", confirmationId }),
    ).resolves.toEqual({ text: "done" });
    expect(registerRun).toHaveBeenCalledWith({
      runId: "run-talk",
      assertCurrent: expect.any(Function),
    });
    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("carries the exact confirmed call into a tool-call consult", async () => {
    const now = Date.now();
    const toolParams = { action: "send", message: "confirmed message" };
    const challenge = checkClientVoiceToolConfirmationPolicy({
      agentId: "researcher",
      voiceSessionId: "voice-session",
      runId: "run-original",
      toolName: "message",
      toolCallId: "blocked-message-call",
      toolParams,
      now,
    });
    if (challenge.allowed) {
      throw new Error("expected challenge");
    }
    const confirmationId = challenge.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1];
    noteClientVoiceConfirmationUtterance({
      agentId: "researcher",
      voiceSessionId: "voice-session",
      text: "yes",
      timestamp: now + 1,
    });
    mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
      await params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      await params.agentRuntime.runEmbeddedAgent(coreParams);
      return { text: "done" };
    });
    await createRunner().runArgs({ question: "Confirm", confirmationId });
    expect(mocks.consultRealtimeVoiceAgent).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: false, toolsAllow: ["read"] }),
    );
    expect(mocks.runEmbeddedAgentCore.mock.calls[0]?.[0].extraSystemPrompt).toContain(
      "previously blocked tool call",
    );
    expect(mocks.runEmbeddedAgentCore.mock.calls[0]?.[0].extraSystemPrompt).toContain(
      "blocked-message-call",
    );
  });
});
